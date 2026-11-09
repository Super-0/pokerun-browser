import { loadMelonDsRuntime, POKERUN_MELONDS_RUNTIME_STAMP } from './core/emulator/melonds/runtime'

const output = document.querySelector<HTMLPreElement>('#output')
function report(message: string) {
  if (output) output.textContent += `\n${message}`
  console.info('[PRK81B]', message)
}

async function main() {
  if (output) output.textContent = 'Starting PRK81B reentry probe'
  report(`Cross-origin isolated: ${window.crossOriginIsolated}`)
  if (!window.crossOriginIsolated) throw new Error('COOP/COEP required for this runtime.')

  const module = await loadMelonDsRuntime()
  const emulator = new module.WasmEmulator()
  let radioEnabled = false
  try {
    const stamp = emulator.pokerunRuntimeVersion() >>> 0
    if (stamp !== POKERUN_MELONDS_RUNTIME_STAMP) {
      throw new Error(`Stale WASM runtime: 0x${stamp.toString(16)}`)
    }
    report(`Native runtime stamp: 0x${stamp.toString(16)}`)
    emulator.prk66SetEnabled(true)
    radioEnabled = true

    const countBefore = emulator.prk79ReplyRx()
    report(`Radio RX counter before: ${countBefore}`)

    const startedAt = performance.now()
    const resumed = emulator.prk81AsyncifyProbe(80)
    if (!resumed || typeof (resumed as Promise<number>).then !== 'function') {
      throw new Error('Asyncify did not return a Promise during native suspension.')
    }

    const reentry = new Promise<void>((resolve, reject) => {
      window.setTimeout(() => {
        try {
          const elapsed = performance.now() - startedAt
          report(`Attempting synchronous WASM radio calls at +${elapsed.toFixed(1)} ms`)
          if (elapsed > 65) throw new Error('Probe timer was delayed until too close to native resume.')

          // A 12-byte emulator header plus a 24-byte 802.11 MAC header.
          // The native PRK79 gate checks total length and byte 10/11.
          // This is a synthetic framing probe; it is never sent over RF.
          const frame = new Uint8Array(36)
          frame[10] = 24
          frame[11] = 0
          const accepted = emulator.prk79InjectReply(frame, 1000, 1)
          if (!accepted) throw new Error('PRK79 rejected the correctly framed test packet.')
          const countAfter = emulator.prk79ReplyRx()
          if (countAfter !== countBefore + 1) {
            throw new Error(`RX counter did not advance: ${countBefore} -> ${countAfter}`)
          }
          report(`Synchronous native reply injection: accepted, RX ${countBefore} → ${countAfter}`)

          // Can the browser drain the host's outgoing queue while it is suspended?
          // Queue is expected empty: no emulated frames are running.
          const outgoing = emulator.prk66TakeOutgoing()
          if (outgoing !== null) throw new Error('Unexpected outgoing radio frame in no-ROM probe.')
          report('Synchronous native outgoing-queue read: succeeded')
          resolve()
        } catch (error) {
          reject(error)
        }
      }, 10)
    })

    const result = await Promise.race([
      Promise.all([resumed as Promise<number>, reentry]).then(([value]) => value),
      new Promise<never>((_, reject) => window.setTimeout(
        () => reject(new Error('Suspended native call did not finish within 5 seconds.')), 5000)),
    ])
    if (result !== 0x81) throw new Error(`Native resume returned ${result}, expected 129.`)
    report(`Native call resumed after ${(performance.now() - startedAt).toFixed(1)} ms`)
    report('PASS: synchronous radio entry points worked during native suspension.')
    report('This is not yet a live multiplayer handshake or scheduler safety test.')
  } finally {
    if (radioEnabled) emulator.prk66SetEnabled(false)
    emulator.delete?.()
  }
}
void main().catch(error => {
  report(`FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
})
