import { loadMelonDsRuntime, POKERUN_MELONDS_RUNTIME_STAMP } from './core/emulator/melonds/runtime'

const output = document.querySelector<HTMLPreElement>('#output')
function report(message: string) {
  if (output) output.textContent += `\n${message}`
  console.info('[PRK81B]', message)
}
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
}

async function main() {
  if (output) output.textContent = 'Starting PRK81B reentry probe (Promise-aware)'
  report(`Cross-origin isolated: ${window.crossOriginIsolated}`)
  if (!window.crossOriginIsolated) throw new Error('COOP/COEP required for this runtime.')

  const module = await loadMelonDsRuntime()
  const emulator = new module.WasmEmulator()
  let radioEnabled = false
  let safeToCleanUp = true
  try {
    const stamp = emulator.pokerunRuntimeVersion() >>> 0
    if (stamp !== POKERUN_MELONDS_RUNTIME_STAMP) {
      throw new Error(`Stale WASM runtime: 0x${stamp.toString(16)}`)
    }
    report(`Native runtime stamp: 0x${stamp.toString(16)}`)
    await emulator.prk66SetEnabled(true)
    radioEnabled = true

    const countBefore = await emulator.prk79ReplyRx()
    report(`Radio RX counter before: ${countBefore}`)

    const start = performance.now()
    const offset = () => (performance.now() - start).toFixed(1)
    let nativeResumedAt: number | null = null
    let replySettledAt: number | null = null
    let rxSettledAt: number | null = null
    let outgoingSettledAt: number | null = null

    const nativeRaw = emulator.prk81AsyncifyProbe(80)
    if (!isPromiseLike(nativeRaw)) {
      throw new Error('Expected an asynchronously suspended native probe.')
    }
    // Register native resolution immediately so its completion time is
    // measured independently of the nested radio-entry promises.
    const nativeResumed = Promise.resolve(nativeRaw).then(value => {
      nativeResumedAt = performance.now()
      report(`Native sleep resumed at +${offset()} ms, result ${value}`)
      return value
    })

    const radioCalls = new Promise<void>((resolve, reject) => {
      window.setTimeout(() => {
        try {
          report(`Attempting WASM radio reentry at +${offset()} ms`)
          // 12-byte emulator header + 24-byte IEEE 802.11 frame header.
          // Validates transport entry only. No RF broadcast, ROM or saves.
          const frame = new Uint8Array(36)
          frame[10] = 24
          frame[11] = 0

          // Invoke the native export while its prior call is suspended.
          // Asyncify can return a Promise even for ordinarily synchronous
          // Embind getters. We must not treat that Promise as a numeric value.
          const injectionRaw = emulator.prk79InjectReply(frame, 1000, 1)
          report(`Inject return type: ${isPromiseLike(injectionRaw) ? 'Promise' : typeof injectionRaw}`)
          const radioResults = (async () => {
            const accepted = await injectionRaw
            replySettledAt = performance.now()
            report(`Inject settled at +${offset()} ms: ${String(accepted)}`)
            if (accepted !== true) {
              throw new Error('The native PRK79 entry point did not accept the test packet.')
            }

            const rxRaw = emulator.prk79ReplyRx()
            report(`RX counter return type: ${isPromiseLike(rxRaw) ? 'Promise' : typeof rxRaw}`)
            const countAfter = await rxRaw
            rxSettledAt = performance.now()
            report(`RX counter settled at +${offset()} ms: ${String(countAfter)}`)
            if (countAfter !== countBefore + 1) {
              throw new Error(`Expected RX counter ${countBefore + 1}, got ${String(countAfter)}`)
            }

            const outgoingRaw = emulator.prk66TakeOutgoing()
            report(`Outgoing read return type: ${isPromiseLike(outgoingRaw) ? 'Promise' : typeof outgoingRaw}`)
            const outgoing = await outgoingRaw
            outgoingSettledAt = performance.now()
            if (outgoing !== null) {
              throw new Error('Unexpected outgoing radio frame without emulated frames.')
            }
            report(`Outgoing queue read settled at +${offset()} ms: empty`)
          })()
          void radioResults.then(resolve, reject)
        } catch (error) {
          reject(error)
        }
      }, 10)
    })

    try {
      const [nativeResult] = await Promise.race([
        Promise.all([nativeResumed, radioCalls]),
        new Promise<never>((_, reject) => window.setTimeout(
          () => reject(new Error('Native/radio test did not complete within 5 seconds.')), 5000)),
      ])
      if (nativeResult !== 0x81) {
        throw new Error(`Native sleep returned ${nativeResult}; expected 129.`)
      }

      if (nativeResumedAt === null || replySettledAt === null ||
          rxSettledAt === null || outgoingSettledAt === null) {
        throw new Error('One or more result timestamps were not recorded.')
      }

      if (replySettledAt < nativeResumedAt &&
          rxSettledAt < nativeResumedAt &&
          outgoingSettledAt < nativeResumedAt) {
        report('RESULT: radio entry promises settled BEFORE native sleep resumed.')
        report('This supports a bounded native reply-wait experiment; full scheduler safety remains unproven.')
      } else {
        report('RESULT: at least one radio operation settled AFTER native sleep resumed.')
        report('Asyncify returned Promises; this does not establish safe synchronous radio access during a native wait.')
        report('Next: evaluate a worker-based or JS-owned radio mailbox rather than assuming reentry is safe.')
      }
      report('TEST COMPLETE: native returned correctly; the radio packet was accepted and counted.')
    } catch (error) {
      // If there is an unresolved Asyncify operation, deleting the WASM
      // instance from a finally block can introduce a second failure.
      safeToCleanUp = false
      throw error
    }
  } finally {
    if (safeToCleanUp) {
      if (radioEnabled) await emulator.prk66SetEnabled(false)
      emulator.delete?.()
    } else {
      report('Native cleanup skipped after error: reload this isolated page before another run.')
    }
  }
}

void main().catch(error => {
  report(`FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
})
