import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { cp, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { assertReciprocalPartyExchange } from './white2-party-exchange.mjs'
import { checkReplySchedules } from '../tests/native/reply-schedule.mjs'

const mode = process.argv[2]
assert(['prepare', 'greeting', 'runtime', 'schedule'].includes(mode), 'Use prepare, greeting, runtime, or schedule.')
assert(!process.env.CI, 'This runner is local only.')
const privateRoot = resolve('local-test-assets')
const checkpoint = join(privateRoot, 'white2-checkpoint')
const origin = 'http://127.0.0.1:4181'
const manual = process.env.POKERUN_MANUAL === '1'
const tracing = mode === 'greeting' && process.env.POKERUN_GREETING_TRACE !== '0'

const unattended = process.env.POKERUN_WHITE2_UNATTENDED === '1'
const expectedOutcome = process.env.POKERUN_EXPECT_WHITE2 ?? 'greeting-failure'
const battleTurn = expectedOutcome === 'battle-turn'
if (mode === 'greeting') assert(['greeting-failure', 'trade-menu', 'trade-confirmed', 'battle-turn'].includes(expectedOutcome),
  'POKERUN_EXPECT_WHITE2 must be greeting-failure, trade-menu, trade-confirmed, or battle-turn.')

assert(!unattended || (mode === 'greeting' && !manual && expectedOutcome === 'trade-confirmed'),
  'Unattended mode requires the private trade driver and a trade-confirmed expectation.')

const normalUi = process.env.POKERUN_WHITE2_NORMAL_UI === '1'
assert(!normalUi || ((unattended || battleTurn) && process.env.VITE_POKERUN_WHITE2_LOCAL_MULTIPLAYER === '1'),
  'The normal UI test requires the local wireless feature flag and an unattended trade or observed battle.')
const reconnect = process.env.POKERUN_WHITE2_RECONNECT === '1'
const tradesPerSession = Number(process.env.POKERUN_WHITE2_TRADES_PER_SESSION ?? 1)
const invitingPlayer = Number(process.env.POKERUN_WHITE2_INVITING_PLAYER ?? 1)
assert([1, 2].includes(tradesPerSession) && [1, 2].includes(invitingPlayer),
  'White 2 trade count and inviting player must be 1 or 2.')
assert(unattended || (!reconnect && tradesPerSession === 1 && invitingPlayer === 1),
  'Reconnect, reverse invitations, and repeat trades require unattended mode.')

const traceGameNegotiation = process.env.POKERUN_TRACE_GAME_NEGOTIATION === '1'
const workerRadio = mode === 'greeting' && process.env.POKERUN_WORKER_RADIO === '1'
assert(!workerRadio || !process.env.POKERUN_DEFER_HOST_POLL, 'Worker radio and emulated poll delays are separate experiments.')
const requestedPollMode = process.env.POKERUN_DEFER_HOST_POLL
const pollModes = new Map([['1', 1], ['adaptive', 2], ['preserve-counter', 3]])
const deferHostPoll = mode === 'greeting' ? pollModes.get(requestedPollMode) ?? 0 : 0

async function launchFromNormalUi(pages) {
  const [host, guest] = pages
  await Promise.all(pages.map(async page => {
    await page.goto(origin + '/')
    await page.getByRole('button', { name: 'MULTIPLAYER', exact: true }).click()
    await page.getByRole('button', { name: /white 2/i }).click()
  }))
  await host.getByRole('button', { name: 'CREATE ROOM' }).click()
  const code = await host.locator('.lobby-room-code strong').textContent()
  assert(code && /^[A-Z2-9]{6}$/.test(code), 'The normal lobby did not provide a valid room code.')
  await guest.getByRole('textbox', { name: 'Room code' }).fill(code)
  await guest.getByRole('button', { name: 'JOIN', exact: true }).click()
  await Promise.all(pages.map(async (page, index) => {
    await page.getByText('Both real players joined this PokeRun room.').waitFor()
    const slot = await page.evaluate(index => {
      const id = localStorage.getItem(`pokerun-multiplayer-dev-save-player-${index + 1}-v1`)
      const profiles = JSON.parse(localStorage.getItem('pokerun-multiplayer-save-profiles-v1') ?? '[]')
      return profiles.find(profile => profile.id === id)?.slotNumber
    }, index)
    assert(Number.isInteger(slot), 'The disposable checkpoint has no saved slot for this player.')
    const title = `SAVE ${String(slot).padStart(3, '0')}`
    await page.locator('article.run-card').filter({
      has: page.getByRole('heading', { name: title, exact: true }),
    }).getByRole('button', { name: 'CONTINUE', exact: true }).click()
    await page.getByRole('button', { name: 'READY', exact: true }).click()
  }))
  await host.getByRole('button', { name: 'START GAME', exact: true }).click()
  await Promise.all(pages.map(page => page.getByRole('heading', { name: 'WHITE 2 LOCAL WIRELESS' }).waitFor({ timeout: 90_000 })))
}

async function captureAfter(page) {
  const [message] = await Promise.all([
    page.waitForEvent('console', {
      predicate: event => event.text().startsWith('[PokéRun wireless] PRK80 INTERACTION TIMING DELTA'),
    }),
    page.getByRole('button', { name: '2. CAPTURE AFTER' }).click(),
  ])
  return message.args()[1].jsonValue()
}

async function readCheckpointSave(page, player) {
  return page.evaluate(async player => {
    const { multiplayerSaveStore } = await import('/src/core/storage/MultiplayerSaveStore.ts')
    const { readWhite2SavedParty } = await import('/src/multiplayer/games/White2PartyStructureProbe.ts')
    const profile = localStorage.getItem(`pokerun-multiplayer-dev-save-player-${player}-v1`)
    if (!profile) throw new Error('Missing disposable White 2 save selection.')
    const bytes = await multiplayerSaveStore.loadBatterySave(profile)
    if (!bytes) throw new Error('Missing disposable White 2 battery.')
    const party = readWhite2SavedParty(bytes)
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    return { digest: Array.from(new Uint8Array(hash)).join(','), party }
  }, player)
}

async function verifyTradeIntegrity(pages, savesBefore) {
  let lastFailure
  const deadline = Date.now() + 90_000
  do {
    try {
      const savesAfter = await Promise.all(pages.map((page, index) => readCheckpointSave(page, index + 1)))
      assertReciprocalPartyExchange(savesBefore.map(save => save.party), savesAfter.map(save => save.party))
      const persistedBatteryChanged = savesAfter.map((save, index) => save.digest !== savesBefore[index].digest)
      assert(persistedBatteryChanged.every(Boolean), 'The two disposable batteries did not both change after the trade.')
      return {
        reciprocalPartyExchange: true,
        bothSavedBatteriesPassFooterValidation: true,
        persistedBatteryChanged,
      }
    } catch (error) {
      lastFailure = error
      await delay(2_000)
    }
  } while (Date.now() < deadline)
  throw lastFailure
}

async function within(ms, description, action) {
  let timer
  try {
    return await Promise.race([
      action(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(description)), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

for (const extension of ['js', 'wasm']) {
  await stat(`public/emulators/melonds/wasmemulator.${extension}`)
}
let driver, run, input
async function confirm(prompt) {
  input ??= createInterface({ input: process.stdin, output: process.stdout })
  return (await input.question(prompt + ' [y/N] ')).trim().toLowerCase() === 'y'
}
const manualDriver = {
  async prepareGreeting() {
    const verified = await confirm('Verify the two Trainer IDs are different and position both players just before the native Union Room greeting. Ready?')
    return { distinctTrainerIds: verified, atGreetingCheckpoint: verified }
  },
  async stageGreeting() {
    assert(await confirm('Enter both Union Rooms, verify the other trainer appears, and position the host to greet. Ready?'),
      'The paired Union Room setup was not confirmed.')
  },
  async attemptGreeting({ captureBattle }) {
    if (battleTurn) {
      const started = await confirm('Start a native Single Battle. Do both DS screens show the opposing Pokémon and the first Fight menu?')
      if (!started) return null
      await captureBattle('before')
      const resolved = await confirm('Choose a move on each console. Did both screens show the same resolved turn and matching HP changes?')
      if (!resolved) return null
      await captureBattle('after')
      return { association: true, battleStarted: true, battleTurnResolved: true }
    }
    const reproduced = await confirm('Attempt one normal greeting. Did you observe native association, a greeting failure, and no Trade menu or confirmation on either player?')
    return reproduced ? { association: true, greetingFailed: true, tradeMenu: false, tradeConfirmed: false } : null
  },
}
if (mode === 'greeting') {
  await stat(join(checkpoint, 'Default', 'IndexedDB'))
  driver = manual ? manualDriver : await import(pathToFileURL(join(privateRoot, 'white2-greeting-driver.mjs')).href)
  assert(typeof driver.prepareGreeting === 'function' && typeof driver.attemptGreeting === 'function')
  assert(tradesPerSession === 1 || typeof driver.attemptAnotherTrade === 'function',
    'The private driver must implement attemptAnotherTrade for a second exchange.')
  run = await mkdtemp(join(privateRoot, 'white2-run-'))
  const runProfile = join(run, 'profile', 'Default')
  await mkdir(runProfile, { recursive: true })
  // Chromium can rebuild its caches. Clone only the two stores that contain
  // the cartridge, battery checkpoints, and launcher selections.
  await Promise.all(['IndexedDB', 'Local Storage'].map(directory =>
    cp(join(checkpoint, 'Default', directory), join(runProfile, directory), {
      recursive: true, mode: constants.COPYFILE_FICLONE,
    })))
} else if (mode === 'prepare') {
  await mkdir(checkpoint, { recursive: true })
}

const server = await createServer({
  plugins: [{
    name: 'pokerun-native-check-page',
    configureServer(vite) {
      vite.middlewares.use('/__pokerun_native_check', (_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
        response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
        response.end('<!doctype html><title>PokéRun native check</title>')
      })
    },
  }],
  server: {
    host: '127.0.0.1', port: 4181, strictPort: true, watch: null, hmr: false,
  },
})
let browser, context
let pages = []
const report = { mode, tracing, deferHostPoll, workerRadio, expectedOutcome, invitingPlayer, tradesPerSession, normalUi, stage: 'startup', pageErrors: [0, 0] }
try {
  await server.listen()
  if (mode === 'runtime' || mode === 'schedule') {
    browser = await chromium.launch()
    const page = await browser.newPage()
    await page.goto(origin + '/__pokerun_native_check')
    if (mode === 'schedule') {
      await within(20_000, 'Native schedule test timed out.', () => checkReplySchedules(page))
      console.log('Native reply schedules passed: early and in-flight empty, late matched, −32 µs matched, −33 µs stale.')
    } else {
      const checkWorker = process.env.POKERUN_WORKER_RADIO === '1'
      const stamp = await within(20_000, 'WASM initialization or worker frame timed out.', () => page.evaluate(async checkWorker => {
        const { loadMelonDsRuntime } = await import('/src/core/emulator/melonds/runtime.ts')
        const module = await loadMelonDsRuntime()
        const emu = new module.WasmEmulator()
        try {
          emu.prk66SetEnabled(true)
          emu.setGreetingTrace(true)
          if (!emu.prk79InjectReply(new Uint8Array(), 123, 1, 42)) throw new Error('Synthetic reply was rejected.')
          const before = performance.timeOrigin + performance.now()
          const batch = emu.drainGreetingTrace()
          const after = performance.timeOrigin + performance.now()
          if (batch.values.length !== 7 || batch.values[0] !== 10 || batch.values[2] !== 123 ||
              batch.values[4] !== 42 || batch.values[5] !== 1 || batch.dropped || batch.nativeNowMs < before - 1 || batch.nativeNowMs > after + 1) {
            throw new Error('Unexpected native queue trace or clock domain.')
          }
          emu.setGreetingTrace(false)
          if (!emu.prk79InjectReply(new Uint8Array(), 124, 1, 43) || emu.drainGreetingTrace().values.length) {
            throw new Error('Disabling observation changed the queue or continued tracing.')
          }
          emu.prk66SetEnabled(false)
          if (checkWorker) {
            if (!emu.pokerunStartFrame || !emu.pokerunFramePending) throw new Error('Worker frame hooks are missing.')
            let finish
            window.WebMelon = { _internal: { events: {
              onWorkerFrame: elapsed => finish(elapsed),
              onShutdown: () => {}, onSaveWrite: () => {},
            } } }
            emu.loadFreeBIOS()
            emu.initialize(false)
            for (let frame = 0; frame < 2; frame++) {
              const completed = new Promise(resolve => { finish = resolve })
              if (!emu.pokerunStartFrame()) throw new Error('Worker rejected an idle frame request.')
              const elapsed = await completed
              if (emu.pokerunFramePending() || !Number.isFinite(elapsed) || elapsed < 0) {
                throw new Error('Worker did not publish completed frame state.')
              }
            }
          }
          return emu.pokerunRuntimeVersion().toString(16)
        } finally { emu.delete() }
      }, checkWorker))
      console.log(`Chromium loaded melonDS runtime 0x${stamp} and verified the trace clock without a ROM.`)
      if (checkWorker) console.log('Two worker frames completed without a ROM.')
    }
  } else {
    context = await chromium.launchPersistentContext(mode === 'prepare' ? checkpoint : join(run, 'profile'), {
      headless: mode !== 'prepare' && !manual && process.env.POKERUN_HEADED !== '1',
      args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
    })
    context.setDefaultTimeout(8_000)
    context.setDefaultNavigationTimeout(60_000)
    if (mode === 'prepare') {
      const page = context.pages()[0] ?? await context.newPage()
      await page.goto(origin + '/multiplayer-dev.html')
      console.log('Prepare both slots at the fixed local origin. Close Chromium when both in-game checkpoints are saved.')
      await within(30 * 60_000, 'Checkpoint preparation exceeded 30 minutes.', () => new Promise(resolveClose => context.once('close', resolveClose)))
    } else {
      await context.addInitScript(({ origin, tracing, deferHostPoll, traceGameNegotiation, workerRadio }) => {
        if (location.origin !== origin) return
        sessionStorage.setItem('pokerun:prk80-greeting-trace', tracing ? '1' : '0')
        sessionStorage.setItem('pokerun:prk80-defer-host-poll', String(deferHostPoll))
        sessionStorage.setItem('pokerun:prk80-worker-radio', workerRadio ? '1' : '0')
        sessionStorage.setItem('pokerun:prk80-trace-game-negotiation', traceGameNegotiation ? '1' : '0')
      }, { origin, tracing, deferHostPoll, traceGameNegotiation, workerRadio })
      const p1 = context.pages()[0] ?? await context.newPage()
      const p2 = await context.newPage()
      pages = [p1, p2]
      for (const [index, page] of pages.entries()) page.on('pageerror', () => { report.pageErrors[index]++ })
      report.stage = 'boot'
      await p1.goto(origin + (normalUi ? '/' : '/multiplayer-dev.html'), { waitUntil: 'commit' })
      const distinctSlots = await p1.evaluate(() => {
        localStorage.removeItem('pokerun-multiplayer-dev-room-v1')
        const prefix = 'pokerun-multiplayer-dev-save-player-'
        const first = localStorage.getItem(prefix + '1-v1')
        const second = localStorage.getItem(prefix + '2-v1')
        return Boolean(first && second && first !== second)
      })
      assert(distinctSlots, 'Select two different save slots in the checkpoint launcher.')
      if (normalUi) await launchFromNormalUi(pages)
      else await Promise.all(pages.map((page, i) => page.goto(`${origin}/multiplayer-dev.html?player=${i + 1}&radioIsolation=1`, { waitUntil: 'commit' })))
      await Promise.all(pages.map(async page => {
        if (!normalUi) await page.getByText(/PRK75 RADIO ISOLATION ACTIVE/).waitFor({ timeout: 90_000 })
        await page.getByRole('button', { name: 'PAUSE', exact: true }).waitFor()
        await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button =>
          button.textContent === 'PAUSE' && !button.disabled), { timeout: 90_000 })
        assert.equal(await page.getByRole('button', { name: '1×', exact: true }).getAttribute('aria-pressed'), 'true')
      }))
      report.stage = 'checkpoint'
      const prepared = await within(120_000, 'Checkpoint preparation timed out.', () => driver.prepareGreeting({ pages }))
      assert(prepared?.distinctTrainerIds === true && prepared?.atGreetingCheckpoint === true, 'Verify both trainer IDs and the greeting checkpoint before continuing.')

      report.stage = 'health'
      const before = '1. CAPTURE BEFORE'
      await Promise.all(pages.map(page => page.getByRole('button', { name: before }).click()))
      async function startRadio() {
        await Promise.all(pages.map(page => page.getByRole('button', { name: normalUi ? 'CONNECT LOCAL WIRELESS' : 'START LOCAL DS RADIO', exact: true }).click()))
        if (normalUi) await Promise.all(pages.map(page => page.getByText('LOCAL WIRELESS CONNECTED', { exact: true }).waitFor()))
        else await Promise.all(pages.map((page, i) => page.getByText(/LINKED\s*•\s*5 ms host poll/).filter({ hasText: `PLAYER ${i + 1}` }).waitFor()))
      }
      await startRadio()
      if (reconnect) {
        report.stage = 'radio-reconnect'
        await Promise.all(pages.map(page => page.getByRole('button', { name: normalUi ? 'DISCONNECT LOCAL WIRELESS' : /STOP & CLEAR RADIO/ }).click()))
        await startRadio()
        report.reconnectVerified = true
        await Promise.all(pages.map(page => page.getByRole('button', { name: before }).click()))
        report.stage = 'health'
      }
      await delay(5_000)
      report.baselineCounters = await Promise.all(pages.map(captureAfter))
      report.health = report.baselineCounters.map(sample => sample.emulatedFrames * 1000 / sample.elapsedMs)
      assert(report.health.every(fps => fps >= 55 && fps <= 65), 'Expected both real emulators at 55–65 DS frames/s near the 60 FPS target.')

      if (typeof driver.stageGreeting === 'function') {
        report.stage = 'association-setup'
        await Promise.all(pages.map(page => page.getByRole('button', { name: before }).click()))
        await within(90_000, 'Union Room staging timed out.', () => driver.stageGreeting({ pages }))
        report.stagingCounters = await Promise.all(pages.map(captureAfter))
        await Promise.all(pages.map(page => page.getByRole('button', { name: before }).click()))
        await delay(5_000)
        report.readyCounters = await Promise.all(pages.map(captureAfter))
        report.readyHealth = report.readyCounters.map(sample => sample.emulatedFrames * 1000 / sample.elapsedMs)
        assert(report.readyHealth.every(fps => fps >= 55 && fps <= 65), 'DS frame health fell outside 55–65 frames/s after entering the Union Room.')
      }

      let savesBefore
      if (unattended) {
        report.stage = 'pre-trade-integrity'
        savesBefore = await Promise.all(pages.map((page, index) => readCheckpointSave(page, index + 1)))
      }
      report.stage = 'greeting'
      await Promise.all(pages.map((page, i) => page.screenshot({ path: join(run, `p${i + 1}-before.png`), timeout: 5_000 })))
      await Promise.all(pages.map(page => page.getByRole('button', { name: before }).click()))
      let result
      const battleScreens = new Map()
      async function captureBattle(phase) {
        assert(battleTurn && phase === (battleScreens.has('before') ? 'after' : 'before') &&
          !battleScreens.has(phase), 'Capture the battle before and after one resolved turn.')
        const screens = await Promise.all(pages.map(page =>
          page.locator('canvas.melonds-screen').evaluateAll(elements =>
            elements.map(canvas => canvas.toDataURL('image/png').split(',')[1]))))
        assert(screens.every(pair => pair.length === 2 && pair.every(Boolean)), 'Expected both DS screens from each console.')
        battleScreens.set(phase, screens)
        await Promise.all(screens.flatMap((pair, player) => pair.map((png, screen) =>
          writeFile(join(run, `p${player + 1}-battle-${phase}-${screen}.png`), Buffer.from(png, 'base64')))))
      }
      try {
        const attemptMs = battleTurn ? 480_000 :
          expectedOutcome === 'trade-confirmed' ? 180_000 : 45_000
        result = await within(attemptMs, 'The paired gameplay attempt timed out.', () => driver.attemptGreeting({ pages, invitingPlayer, captureBattle }))
      } catch (error) {
        report.greetingCounters = await Promise.all(pages.map(captureAfter)).catch(() => undefined)
        throw error
      }
      let tradeConfirmed = result?.tradeConfirmed === true
      if (unattended) {
        report.stage = 'post-trade-integrity'
        assert(result?.exchangeSubmitted === true && result?.tradeMenu === true &&
          result?.association === true && !result?.greetingFailed,
        'The private driver did not reach and submit the reciprocal trade confirmation.')
        report.integrity = await verifyTradeIntegrity(pages, savesBefore)
        report.verifiedTrades = 1
        if (tradesPerSession === 2) {
          const betweenTrades = await Promise.all(pages.map((page, index) => readCheckpointSave(page, index + 1)))
          report.stage = 'second-trade'
          const repeat = await within(180_000, 'The second trade timed out.', () => driver.attemptAnotherTrade({ pages, invitingPlayer }))
          assert(repeat?.exchangeSubmitted === true, 'The private driver did not submit the second trade.')
          report.secondTradeIntegrity = await verifyTradeIntegrity(pages, betweenTrades)
          report.verifiedTrades++
        }
        tradeConfirmed = true
      }
      report.observation = {
        association: result?.association === true,
        greetingFailed: result?.greetingFailed === true,
        tradeMenu: result?.tradeMenu === true,
        tradeConfirmed,
        battleStarted: result?.battleStarted === true,
        battleTurnResolved: result?.battleTurnResolved === true,
      }
      report.greetingCounters = await Promise.all(pages.map(captureAfter))
      report.associationFramesReceived = [...report.baselineCounters, ...(report.stagingCounters ?? []), ...(report.readyCounters ?? []), ...report.greetingCounters]
        .flatMap(sample => sample.stages)
        .filter(stage => stage.label === 'Association responses')
        .reduce((sum, stage) => sum + stage.hardwareRx, 0)
      assert(report.pageErrors.every(count => count === 0), 'An uncaught browser error occurred during the run.')
      const { association, greetingFailed, tradeMenu } = report.observation
      assert(association && report.associationFramesReceived > 0, 'Native association was not verified.')
      if (report.observation.battleStarted && report.observation.battleTurnResolved &&
          !tradeMenu && !tradeConfirmed && !greetingFailed) {
        const beforeScreens = battleScreens.get('before')
        const afterScreens = battleScreens.get('after')
        assert(beforeScreens && afterScreens && beforeScreens.every((pair, player) => pair[0] !== afterScreens[player][0]),
          'A battle result requires changed top screens from both consoles after the observed turn.')
        report.outcome = 'battle-turn'
      } else if (tradeConfirmed && tradeMenu && !greetingFailed) report.outcome = 'trade-confirmed'
      else if (tradeMenu && !greetingFailed) report.outcome = 'trade-menu'
      else if (greetingFailed && !tradeMenu && !tradeConfirmed) report.outcome = 'greeting-failure'
      else report.outcome = 'other'
      assert.equal(report.outcome, expectedOutcome, 'Unexpected game-level outcome.')
      if (unattended || battleTurn) {
        assert(report.greetingCounters.every(sample => {
          const fps = sample.emulatedFrames * 1000 / sample.elapsedMs
          return fps >= 55 && fps <= 65
        }), 'DS frame health fell outside 55–65 frames/s during gameplay.')
      }
      report.stage = 'complete'
      console.log(`Verified White 2 outcome: ${report.outcome}.`)
    }
  }
} catch (error) {
  process.exitCode = 1
  if (!run) throw error
  // Driver errors and browser captures can contain private identifiers. Keep them in the run directory.
  await writeFile(join(run, 'failure.txt'), String(error.stack ?? error))
  console.error(`Private run stopped at ${report.stage}. Inspect its local evidence.`)
} finally {
  try {
    if (run) {
      await Promise.allSettled(pages.map(async (page, index) => {
        const prefix = join(run, `p${index + 1}`)
        await page.screenshot({ path: prefix + '.png', timeout: 5_000 }).catch(() => {})
        const canvases = await within(3_000, 'DS screen capture timed out.', () =>
          page.locator('canvas.melonds-screen').evaluateAll(elements =>
            elements.map(canvas => canvas.toDataURL('image/png').split(',')[1]))).catch(() => [])
        await Promise.all(canvases.map((png, screen) =>
          writeFile(prefix + '-ds-' + screen + '.png', Buffer.from(png, 'base64'))))
        const panel = await page.locator('.melonds-player, [role="status"]').allTextContents().catch(() => [])
        await writeFile(prefix + '-panel.txt', panel.join('\n'))
        await page.getByRole('button', { name: normalUi ? 'DISCONNECT LOCAL WIRELESS' : /STOP & CLEAR RADIO/ }).click({ timeout: 2_000 }).catch(() => {})
        if (!tracing) return
        const serialized = await within(15_000, 'Trace extraction timed out.', () => page.evaluate(async () => {
          const { takeWhite2GreetingTrace } = await import('/src/multiplayer/games/White2GreetingTrace.ts')
          return JSON.stringify(takeWhite2GreetingTrace() ?? null)
        })).catch(async error => {
          await writeFile(prefix + '-timing-error.txt', String(error.stack ?? error))
          return 'null'
        })
        await writeFile(prefix + '-timing.json', serialized)
        const trace = JSON.parse(serialized)
        if (report.stage === 'complete' &&
            (!trace?.complete || !trace.native.length || !trace.wire.length ||
              trace.droppedWire || trace.droppedBatches || trace.native.some(batch => batch.dropped))) {
          process.exitCode = 1
          report.timingIncomplete = true
        }
      })).then(results => {
        if (results.some(result => result.status === 'rejected')) {
          process.exitCode = 1
          report.timingIncomplete = true
        }
      })
      await writeFile(join(run, 'result.json'), JSON.stringify(report, null, 2))
      console.log(`Local evidence directory: ${run}`)
    }
  } finally {
    try {
      input?.close()
      try {
        if (typeof driver?.dispose === 'function') {
          await within(2_000, 'Private driver cleanup timed out.', () => driver.dispose())
        }
      } finally {
        await context?.close()
      }
      await browser?.close()
    } finally { await server.close() }
  }
}
