import { loadMelonDsRuntime, POKERUN_MELONDS_RUNTIME_STAMP } from './core/emulator/melonds/runtime'

const output = document.querySelector<HTMLPreElement>('#output')
function report(message: string) {
  if (output) output.textContent += `\n${message}`
  console.info('[PRK81A]', message)
}
async function main() {
  if (output) output.textContent = 'Starting PRK81A probe'
  report(`Cross-origin isolated: ${window.crossOriginIsolated}`)
  if (!window.crossOriginIsolated) {
    throw new Error('The dev origin must provide COOP/COEP headers for pthreads.')
  }
  const module = await loadMelonDsRuntime()
  const emulator = new module.WasmEmulator()
  try {
    const stamp = emulator.pokerunRuntimeVersion() >>> 0
    if (stamp !== POKERUN_MELONDS_RUNTIME_STAMP) {
      throw new Error(`Incorrect runtime stamp: ${stamp.toString(16)}`)
    }
    report(`Native runtime stamp: 0x${stamp.toString(16)}`)

    let timeoutCallbackRan = false
    const startedAt = performance.now()
    const timer = new Promise<void>(resolve => {
      window.setTimeout(() => { timeoutCallbackRan = true; resolve() }, 0)
    })
    const result = emulator.prk81AsyncifyProbe(30)
    if (!result || typeof (result as Promise<number>).then !== 'function') {
      throw new Error('Native probe returned synchronously; Asyncify did not suspend.')
    }
    const resolved = await Promise.race([
      result as Promise<number>,
      new Promise<never>((_, reject) => window.setTimeout(
        () => reject(new Error('Asyncify did not resume within 5 seconds.')), 5000)),
    ])
    await timer
    const elapsed = Math.round(performance.now() - startedAt)
    if (resolved !== 0x81) throw new Error(`Wrong resumed value: ${resolved}`)
    if (!timeoutCallbackRan) throw new Error('The JavaScript event loop never ran.')
    report(`JS timer ran during native suspension: ${timeoutCallbackRan}`)
    report(`Native probe resumed successfully after ${elapsed} ms`)
    report('PASS: Asyncify yielded and resumed through Embind.')
    report('This does NOT prove PRK81 wireless handshake correctness.')
  } finally {
    emulator.delete?.()
  }
}
void main().catch(error => {
  report(`FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
})
