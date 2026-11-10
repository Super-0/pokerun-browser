import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

assert(!process.env.CI, 'White 2 streaks require private assets and run locally.')
const target = Number(process.argv[2] ?? 10)
const limit = Number(process.argv[3] ?? target + 6)
assert(Number.isInteger(target) && target >= 1 && Number.isInteger(limit) && limit >= target && limit <= 50,
  'Pass a positive target and an attempt limit between the target and 50.')

const assets = resolve('local-test-assets')
const batch = await mkdtemp(join(assets, 'white2-streak-'))
const report = { target, limit, consecutive: 0, attempts: [] }

for (let attempt = 1; attempt <= limit && report.consecutive < target; attempt++) {
  const result = await new Promise((resolve, reject) => {
    let output = ''
    const child = spawn(process.execPath, ['scripts/test-white2-private.mjs', 'greeting'], {
      env: {
        ...process.env,
        POKERUN_MANUAL: '0',
        POKERUN_WORKER_RADIO: '1',
        POKERUN_DEFER_HOST_POLL: '',
        POKERUN_EXPECT_WHITE2: 'trade-confirmed',
        POKERUN_WHITE2_UNATTENDED: '1',
        POKERUN_GREETING_TRACE: '1',
        POKERUN_TRACE_GAME_NEGOTIATION: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk) })
    child.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk) })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, output }))
  })
  const match = result.output.match(/^Local evidence directory: .*[\\/](white2-run-[a-z0-9]+)\s*$/im)
  const directory = match?.[1] ?? null
  const observation = directory
    ? JSON.parse(await readFile(join(assets, directory, 'result.json'), 'utf8'))
    : null
  const passed = result.code === 0 && observation?.stage === 'complete' &&
    observation.outcome === 'trade-confirmed' && observation.integrity?.reciprocalPartyExchange === true &&
    observation.integrity.persistedBatteryChanged.every(Boolean) && !observation.timingIncomplete
  report.consecutive = passed ? report.consecutive + 1 : 0
  report.attempts.push({
    attempt, directory, passed, stage: observation?.stage ?? 'startup',
    outcome: observation?.outcome ?? null, consecutive: report.consecutive,
  })
  await writeFile(join(batch, `attempt-${attempt}.log`), result.output)
  await writeFile(join(batch, 'result.json'), JSON.stringify(report, null, 2))
  console.log(`Attempt ${attempt}: ${passed ? 'pass' : 'failed'} (${report.consecutive}/${target} consecutive).`)
  if (!directory || result.signal) break
  const prior = report.attempts.at(-2)
  if (!passed && prior && !prior.passed && prior.stage === observation.stage) {
    console.error('Two attempts stopped at the same stage. Inspect their private evidence before resuming.')
    break
  }
}
console.log(`Streak report: local-test-assets/${basename(batch)}/result.json`)
if (report.consecutive < target) process.exitCode = 1
