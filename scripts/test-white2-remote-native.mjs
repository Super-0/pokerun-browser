import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { captureAfter, readCheckpointSave, verifyTradeIntegrity, within } from './white2-gameplay-evidence.mjs'

assert(!process.env.CI, 'Private White 2 gameplay runs are local only.')

const privateRoot = resolve('local-test-assets')
const checkpoint = join(privateRoot, 'white2-checkpoint', 'Default')
const run = await mkdtemp(join(privateRoot, 'white2-remote-run-'))
const origin = process.env.POKERUN_REMOTE_URL ?? 'http://127.0.0.1:4181'
process.env.POKERUN_WHITE2_UNATTENDED = '1'
process.env.POKERUN_EXPECT_WHITE2 = 'trade-confirmed'
process.env.POKERUN_WHITE2_RUN_DIR = run
const driver = await import(new URL('../local-test-assets/white2-greeting-driver.mjs', import.meta.url))
const contexts = []
const pages = []
const report = {
  stage: 'startup', transport: 'network', unionRoomEntered: false, unionRoomPrepared: false,
  nativeAssociation: false, associationFramesReceived: 0,
  tradeMenu: false, genuineTrade: false, pageErrors: [0, 0],
}
let samplePending = false

async function captureRadio() {
  const samples = await Promise.all(pages.map(captureAfter))
  samplePending = false
  report.associationFramesReceived += samples
    .flatMap(sample => sample.stages)
    .filter(stage => stage.label === 'Association responses')
    .reduce((sum, stage) => sum + stage.hardwareRx, 0)
  report.nativeAssociation = report.associationFramesReceived > 0
  return samples
}

function assertHealthy(samples) {
  const fps = samples.map(sample => sample.emulatedFrames * 1000 / sample.elapsedMs)
  assert(fps.every(value => value >= 55 && value <= 65),
    'Expected both real emulators at 55–65 DS frames/s.')
}

async function createProfile(player, roomCode = '') {
  const profile = join(run, `player-${player}`)
  await mkdir(join(profile, 'Default'), { recursive: true })
  await Promise.all(['IndexedDB', 'Local Storage'].map(directory =>
    cp(join(checkpoint, directory), join(profile, 'Default', directory), { recursive: true })))
  const context = await chromium.launchPersistentContext(profile, {
    headless: process.env.POKERUN_HEADED !== '1',
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
  })
  contexts.push(context)
  context.setDefaultTimeout(12_000)
  await context.addInitScript(() => {
    sessionStorage.setItem('pokerun:prk80-greeting-trace', '1')
    sessionStorage.setItem('pokerun:prk80-worker-radio', '1')
    sessionStorage.setItem('pokerun:prk80-trace-game-negotiation', '1')
  })
  const page = context.pages()[0] ?? await context.newPage()
  pages.push(page)
  page.on('pageerror', () => { report.pageErrors[player - 1]++ })
  const playerUrl = new URL('/multiplayer-dev.html', origin)
  playerUrl.search = new URLSearchParams({ transport: 'network', player, radioIsolation: '1' })
  if (roomCode) playerUrl.searchParams.set('room', roomCode)
  await page.goto(playerUrl.href, { waitUntil: 'commit' })
  const slot = await page.evaluate(async player => {
    const { multiplayerSaveStore } = await import('/src/core/storage/MultiplayerSaveStore.ts')
    const profiles = multiplayerSaveStore.list('white2').sort((a, b) => a.slotNumber - b.slotNumber)
    if (profiles.length < 2) throw new Error('The private checkpoint must contain two verified save slots.')
    localStorage.removeItem('pokerun-multiplayer-dev-room-v1')
    const keys = [1, 2].map(index => `pokerun-multiplayer-dev-save-player-${index}-v1`)
    const stored = keys.map(key => localStorage.getItem(key))
    const selected = stored.every(id => id && profiles.some(profile => profile.id === id)) &&
      stored[0] !== stored[1] ? stored[player - 1] : profiles[player - 1].id
    localStorage.setItem(keys[player - 1], selected)
    const profile = profiles.find(item => item.id === selected)
    return { slotNumber: profile.slotNumber, id: profile.id }
  }, player)
  await page.goto(playerUrl.href, { waitUntil: 'commit' })
  return { page, slot }
}

try {
  report.stage = 'boot'
  const first = await createProfile(1)
  const roomPattern = /\bROOM\s+([A-Z2-9]{6})\s+(?:Waiting|Both)/
  await first.page.waitForFunction(source => new RegExp(source).test(document.body.innerText), roomPattern.source, { timeout: 30_000 })
  const roomCode = (await first.page.locator('body').innerText()).match(roomPattern)?.[1]
  assert(roomCode, 'Host did not expose a room code.')

  const second = await createProfile(2, roomCode)
  assert.notEqual(first.slot.id, second.slot.id, 'The two processes must restore distinct saves.')
  report.stage = 'room-paired'
  await Promise.all(pages.map(page => page.waitForFunction(() => /2\/2 PLAYERS/.test(document.body.innerText), null, { timeout: 30_000 })))
  await Promise.all(pages.map(page => page.getByText('Both real players joined this PokeRun room.').waitFor()))
  report.stage = 'emulators'
  await Promise.all(pages.map(async page => {
    await page.getByText(/PRK75 RADIO ISOLATION ACTIVE/).waitFor({ timeout: 90_000 })
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button =>
      button.textContent === 'PAUSE' && !button.disabled), null, { timeout: 90_000 })
    assert.equal(await page.getByRole('button', { name: '1×', exact: true }).getAttribute('aria-pressed'), 'true')
  }))

  report.stage = 'checkpoint'
  const prepared = await within(120_000, 'Checkpoint preparation timed out.', () => driver.prepareGreeting({ pages }))
  assert(prepared?.distinctTrainerIds === true && prepared?.atGreetingCheckpoint === true,
    'Expected both games at their verified Union Room entrance checkpoints.')

  report.stage = 'radio-link'
  await Promise.all(pages.map(page => page.getByRole('button', { name: '1. CAPTURE BEFORE' }).click()))
  samplePending = true
  await Promise.all(pages.map(page => page.getByRole('button', { name: 'START LOCAL DS RADIO', exact: true }).click()))
  await Promise.all(pages.map((page, index) => page
    .getByText(new RegExp(`^LINKED\\s*•\\s*5 ms host poll\\s*•\\s*PLAYER ${index + 1}$`))
    .waitFor({ timeout: 30_000 })))
  await delay(5_000)
  report.baselineCounters = await captureRadio()
  assertHealthy(report.baselineCounters)

  report.stage = 'union-room'
  await Promise.all(pages.map(page => page.getByRole('button', { name: '1. CAPTURE BEFORE' }).click()))
  samplePending = true
  try {
    await within(90_000, 'Union Room staging timed out.', () => driver.stageGreeting({ pages }))
  } finally {
    const maps = await Promise.all(pages.map(page =>
      page.locator('.multiplayer-player-panel .multiplayer-location-name').allTextContents()
        .catch(() => [])))
    report.unionRoomEntered = maps.every(locations =>
      locations.length === 2 && locations.every(location => location.trim() === 'MAP 422'))
  }
  assert(report.unionRoomEntered, 'Both games must be on Union Room map 422 after staging.')
  report.unionRoomPrepared = true
  const savesBefore = await Promise.all(pages.map((page, index) => readCheckpointSave(page, index + 1)))

  report.stage = 'greeting'
  const result = await within(180_000, 'The paired gameplay attempt timed out.',
    () => driver.attemptGreeting({ pages, invitingPlayer: 1 }))
  report.gameplayCounters = await captureRadio()
  report.tradeMenu = result?.tradeMenu === true
  assert(report.nativeAssociation, 'No native association response reached either DS.')
  assert(report.tradeMenu && result?.exchangeSubmitted === true && !result.greetingFailed,
    'The two games did not submit a reciprocal trade.')

  report.stage = 'post-trade-integrity'
  report.integrity = await verifyTradeIntegrity(pages, savesBefore)
  assert(report.pageErrors.every(count => count === 0), 'An uncaught browser error occurred during the run.')
  report.genuineTrade = true
  report.stage = 'gameplay-health'
  assertHealthy(report.gameplayCounters)
  report.stage = 'trade-confirmed'
  await writeFile(join(run, 'result.json'), JSON.stringify(report, null, 2))
  console.log(`Verified isolated-process White 2 trade. Evidence: ${run}`)
} catch (error) {
  if (samplePending) report.failureCounters = await captureRadio().catch(() => undefined)
  report.error = error instanceof Error ? error.message : String(error)
  await mkdir(run, { recursive: true })
  await Promise.all(pages.map(async (page, index) => {
    const diagnostics = await page.evaluate(() => ({
      text: document.body.innerText,
      room: localStorage.getItem('pokerun-multiplayer-dev-room-v1'),
      player1: localStorage.getItem('pokerun-multiplayer-dev-save-player-1-v1'),
      player2: localStorage.getItem('pokerun-multiplayer-dev-save-player-2-v1'),
    })).catch(() => null)
    if (diagnostics) await writeFile(join(run, `p${index + 1}-diagnostics.json`), JSON.stringify(diagnostics, null, 2))
    const section = page.locator('section.multiplayer-session-debug')
      .filter({ hasText: 'WHITE 2 • NATIVE MULTIPLAYER TEST' })
    await section.locator('details').evaluateAll(details => {
      for (const detail of details) detail.open = true
    }).catch(() => undefined)
    const panel = await section.innerText().catch(() => '')
    if (panel) await writeFile(join(run, `p${index + 1}-panel.txt`), panel)
    for (const [screen, canvas] of (await page.locator('canvas.melonds-screen').all()).entries()) {
      await canvas.screenshot({ path: join(run, `p${index + 1}-ds-${screen}.png`) }).catch(() => undefined)
    }
  }))
  await Promise.all(pages.map((page, index) => page.screenshot({ path: join(run, `p${index + 1}-failure.png`) }).catch(() => undefined)))
  await writeFile(join(run, 'result.json'), JSON.stringify(report, null, 2))
  console.error(`Private remote run stopped at ${report.stage}. Evidence: ${run}`)
  process.exitCode = 1
} finally {
  await Promise.all(contexts.map(context => context.close()))
  await driver.dispose?.()
  for (const player of [1, 2]) {
    await rm(join(run, `player-${player}`), { recursive: true, force: true, maxRetries: 3, retryDelay: 500 })
  }
}
