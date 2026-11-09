import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const mode = process.argv[2]
assert(['prepare', 'greeting', 'runtime'].includes(mode), 'Use prepare, greeting, or runtime.')
assert(!process.env.CI, 'This runner is local only.')
const privateRoot = resolve('local-test-assets')
const checkpoint = join(privateRoot, 'white2-checkpoint')
const origin = 'http://127.0.0.1:4181'
const manual = process.env.POKERUN_MANUAL === '1'
const tracing = mode === 'greeting' && process.env.POKERUN_GREETING_TRACE !== '0'

async function captureAfter(page) {
  const [message] = await Promise.all([
    page.waitForEvent('console', {
      predicate: event => event.text().startsWith('[PokéRun wireless] PRK80 INTERACTION TIMING DELTA'),
    }),
    page.getByRole('button', { name: '2. CAPTURE AFTER' }).click(),
  ])
  return message.args()[1].jsonValue()
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
  async attemptGreeting() {
    const reproduced = await confirm('Attempt one normal greeting. Did you observe native association, a greeting failure, and no Trade menu or confirmation on either player?')
    return reproduced ? { association: true, greetingFailed: true, tradeMenu: false, tradeConfirmed: false } : null
  },
}
if (mode === 'greeting') {
  await stat(join(checkpoint, 'Default', 'IndexedDB'))
  driver = manual ? manualDriver : await import(pathToFileURL(join(privateRoot, 'white2-greeting-driver.mjs')).href)
  assert(typeof driver.prepareGreeting === 'function' && typeof driver.attemptGreeting === 'function')
  run = await mkdtemp(join(privateRoot, 'white2-run-'))
  await cp(checkpoint, join(run, 'profile'), { recursive: true })
} else if (mode === 'prepare') {
  await mkdir(checkpoint, { recursive: true })
}

const server = await createServer({
  server: {
    host: '127.0.0.1', port: 4181, strictPort: true,
  },
})
let browser, context
let pages = []
const report = { mode, tracing, stage: 'startup', pageErrors: [0, 0] }
try {
  await server.listen()
  if (mode === 'runtime') {
    browser = await chromium.launch()
    const page = await browser.newPage()
    await page.goto(origin)
    const stamp = await within(20_000, 'WASM initialization timed out.', () => page.evaluate(async () => {
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
        return emu.pokerunRuntimeVersion().toString(16)
      } finally { emu.delete() }
    }))
    console.log(`Chromium loaded melonDS runtime 0x${stamp} and verified the trace clock without a ROM.`)
  } else {
    context = await chromium.launchPersistentContext(mode === 'prepare' ? checkpoint : join(run, 'profile'), {
      headless: mode !== 'prepare' && !manual && process.env.POKERUN_HEADED !== '1',
      args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
    })
    context.setDefaultTimeout(8_000)
    context.setDefaultNavigationTimeout(15_000)
    if (mode === 'prepare') {
      const page = context.pages()[0] ?? await context.newPage()
      await page.goto(origin + '/multiplayer-dev.html')
      console.log('Prepare both slots at the fixed local origin. Close Chromium when both in-game checkpoints are saved.')
      await within(30 * 60_000, 'Checkpoint preparation exceeded 30 minutes.', () => new Promise(resolveClose => context.once('close', resolveClose)))
    } else {
      await context.addInitScript(({ origin, tracing }) => {
        if (location.origin === origin) sessionStorage.setItem('pokerun:prk80-greeting-trace', tracing ? '1' : '0')
      }, { origin, tracing })
      const p1 = context.pages()[0] ?? await context.newPage()
      const p2 = await context.newPage()
      pages = [p1, p2]
      for (const [index, page] of pages.entries()) page.on('pageerror', () => { report.pageErrors[index]++ })
      report.stage = 'boot'
      await p1.goto(origin + '/multiplayer-dev.html')
      const distinctSlots = await p1.evaluate(() => {
        localStorage.removeItem('pokerun-multiplayer-dev-room-v1')
        const prefix = 'pokerun-multiplayer-dev-save-player-'
        const first = localStorage.getItem(prefix + '1-v1')
        const second = localStorage.getItem(prefix + '2-v1')
        return Boolean(first && second && first !== second)
      })
      assert(distinctSlots, 'Select two different save slots in the checkpoint launcher.')
      await Promise.all(pages.map((page, i) => page.goto(`${origin}/multiplayer-dev.html?player=${i + 1}&radioIsolation=1`)))
      await Promise.all(pages.map(async page => {
        await page.getByText(/PRK75 RADIO ISOLATION ACTIVE/).waitFor({ timeout: 90_000 })
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
      await Promise.all(pages.map(page => page.getByRole('button', { name: 'START LOCAL DS RADIO' }).click()))
      await Promise.all(pages.map((page, i) => page.getByText(/LINKED\s*•\s*5 ms host poll/).filter({ hasText: `PLAYER ${i + 1}` }).waitFor()))
      await delay(5_000)
      report.baselineCounters = await Promise.all(pages.map(captureAfter))
      report.health = report.baselineCounters.map(sample => sample.emulatedFrames * 1000 / sample.elapsedMs)
      assert(report.health.every(fps => fps >= 55 && fps <= 65), 'Expected both real emulators at 55–65 DS frames/s near the 60 FPS target.')

      report.stage = 'greeting'
      await Promise.all(pages.map((page, i) => page.screenshot({ path: join(run, `p${i + 1}-before.png`), timeout: 5_000 })))
      await Promise.all(pages.map(page => page.getByRole('button', { name: before }).click()))
      const result = await within(45_000, 'One greeting attempt exceeded 45 seconds.', () => driver.attemptGreeting({ pages }))
      report.observation = {
        association: result?.association === true,
        greetingFailed: result?.greetingFailed === true,
        tradeMenu: result?.tradeMenu === true,
        tradeConfirmed: result?.tradeConfirmed === true,
      }
      report.greetingCounters = await Promise.all(pages.map(captureAfter))
      report.associationFramesReceived = [...report.baselineCounters, ...report.greetingCounters]
        .flatMap(sample => sample.stages)
        .filter(stage => stage.label === 'Association responses')
        .reduce((sum, stage) => sum + stage.hardwareRx, 0)
      assert(report.pageErrors.every(count => count === 0), 'An uncaught browser error occurred during the run.')
      assert(report.observation.association && report.associationFramesReceived > 0 && report.observation.greetingFailed &&
        !report.observation.tradeMenu && !report.observation.tradeConfirmed,
      'PRK80 greeting failure did not reproduce with the expected game-level outcome.')
      report.stage = 'reproduced-greeting-failure'
      console.log('Reproduced the greeting failure after native association.')
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
        const panel = await page.locator('.melonds-player, [role="status"]').allTextContents().catch(() => [])
        await writeFile(prefix + '-panel.txt', panel.join('\n'))
        await page.getByRole('button', { name: /STOP & CLEAR RADIO/ }).click({ timeout: 2_000 }).catch(() => {})
        if (!tracing) return
        const trace = await within(5_000, 'Trace extraction timed out.', () => page.evaluate(async () => {
          const { takeWhite2GreetingTrace } = await import('/src/multiplayer/games/White2GreetingTrace.ts')
          return takeWhite2GreetingTrace()
        })).catch(() => null)
        await writeFile(prefix + '-timing.json', JSON.stringify(trace))
        if (report.stage === 'reproduced-greeting-failure' &&
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
      await context?.close()
      await browser?.close()
    } finally { await server.close() }
  }
}
