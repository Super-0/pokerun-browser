import assert from 'node:assert/strict'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const privateRoot = resolve('local-test-assets')
const checkpoint = join(privateRoot, 'white2-checkpoint', 'Default')
const run = join(privateRoot, `white2-remote-run-${Math.random().toString(36).slice(2, 8)}`)
const origin = process.env.POKERUN_REMOTE_URL ?? 'http://127.0.0.1:4181'
process.env.POKERUN_WHITE2_UNATTENDED = '1'
process.env.POKERUN_EXPECT_WHITE2 = 'trade-confirmed'
const driver = await import(new URL('../local-test-assets/white2-greeting-driver.mjs', import.meta.url))
const contexts = []
const pages = []
const report = { stage: 'startup', transport: 'network', nativeAssociation: false, genuineTrade: false }

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
  context.setDefaultTimeout(12_000)
  await context.addInitScript(() => {
    sessionStorage.setItem('pokerun:prk80-greeting-trace', '1')
    sessionStorage.setItem('pokerun:prk80-worker-radio', '1')
    sessionStorage.setItem('pokerun:prk80-trace-game-negotiation', '1')
  })
  const page = context.pages()[0] ?? await context.newPage()
  const roomQuery = roomCode ? `&room=${roomCode}` : ''
  await page.goto(`${origin}/multiplayer-dev.html?transport=network&player=${player}${roomQuery}`, { waitUntil: 'commit' })
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
  await page.goto(`${origin}/multiplayer-dev.html?transport=network&player=${player}${roomQuery}`, { waitUntil: 'commit' })
  return { context, page, slot }
}

try {
  report.stage = 'boot'
  const first = await createProfile(1)
  contexts.push(first.context); pages.push(first.page)
  const roomPattern = /\bROOM\s+([A-Z2-9]{6})\s+(?:Waiting|Both)/
  await first.page.waitForFunction(source => new RegExp(source).test(document.body.innerText), roomPattern.source, { timeout: 30_000 })
  const roomCode = (await first.page.locator('body').innerText()).match(roomPattern)?.[1]
  assert(roomCode, 'Host did not expose a room code.')

  const second = await createProfile(2, roomCode)
  contexts.push(second.context); pages.push(second.page)
  report.stage = 'room-paired'
  await Promise.all(pages.map(page => page.waitForFunction(() => /2\/2 PLAYERS/.test(document.body.innerText), null, { timeout: 30_000 })))
  await Promise.all(pages.map(page => page.getByText('Both real players joined this PokeRun room.').waitFor()))
  await Promise.all([first.page, second.page].map((page, index) =>
    page.evaluate(({ player, id }) => localStorage.setItem(`pokerun-multiplayer-dev-save-player-${player}-v1`, id),
      { player: index + 1, id: index === 0 ? first.slot.id : second.slot.id })))
  await Promise.all(pages.map(page => page.waitForFunction(() => /ROM VERIFIED/.test(document.body.innerText), null, { timeout: 60_000 })))
  await Promise.all(pages.map(page => page.getByRole('button', { name: 'READY', exact: true }).waitFor()))
  await Promise.all(pages.map(page => page.getByRole('button', { name: 'READY', exact: true }).waitFor({ state: 'detached', timeout: 60_000 }).catch(() => undefined)))
  report.stage = 'emulators'
  await Promise.all(pages.map(page => page.getByRole('button', { name: 'START LOCAL DS RADIO', exact: true }).waitFor({ timeout: 120_000 })))
  await Promise.all(pages.map(page => page.getByRole('button', { name: 'START LOCAL DS RADIO', exact: true }).click()))
  await Promise.all(pages.map(page => page.getByText(/^LINKED\b/, { exact: false }).first().waitFor({ timeout: 30_000 })))
  await delay(5_000)
  report.stage = 'association-setup'
  await driver.prepareGreeting({ pages })
  await driver.stageGreeting({ pages })
  report.stage = 'greeting'
  report.nativeAssociation = true
  const result = await driver.attemptGreeting({ pages, invitingPlayer: 1 })
  report.result = result
  report.genuineTrade = result?.tradeConfirmed === true
  report.stage = report.genuineTrade ? 'trade-confirmed' : result?.tradeMenu ? 'trade-menu' : 'greeting'
  await writeFile(join(run, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, evidence: run }, null, 2))
} catch (error) {
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
    const panel = await page.locator('.multiplayer-session-debug').innerText().catch(() => '')
    if (panel) await writeFile(join(run, `p${index + 1}-panel.txt`), panel)
    for (const [screen, canvas] of (await page.locator('canvas.melonds-screen').all()).entries()) {
      await canvas.screenshot({ path: join(run, `p${index + 1}-ds-${screen}.png`) }).catch(() => undefined)
    }
  }))
  await Promise.all(pages.map((page, index) => page.screenshot({ path: join(run, `p${index + 1}-failure.png`) }).catch(() => undefined)))
  await writeFile(join(run, 'result.json'), JSON.stringify(report, null, 2))
  console.error(JSON.stringify({ ...report, evidence: run }, null, 2))
  process.exitCode = 1
} finally {
  await Promise.all(contexts.map(context => context.close()))
  await driver.dispose?.()
  for (const player of [1, 2]) {
    await rm(join(run, `player-${player}`), { recursive: true, force: true, maxRetries: 3, retryDelay: 500 })
  }
}
