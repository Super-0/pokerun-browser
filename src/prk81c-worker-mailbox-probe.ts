// PRK81C tests whether an isolated worker can synchronously wait for
// a packet while the browser main thread remains responsive and delivers
// it through a SharedArrayBuffer mailbox. This is not a native game test.
const output = document.querySelector<HTMLPreElement>('#output')
function report(message: string) {
  if (output) output.textContent += `\n${message}`
  console.info('[PRK81C]', message)
}

type WorkerEvent =
  | { kind: 'awaiting'; round: number }
  | { kind: 'received'; round: number; waitMs: number }
  | { kind: 'complete'; rounds: number }
  | { kind: 'error'; message: string }

async function run() {
  if (output) output.textContent = 'Starting PRK81C worker mailbox test'
  report(`Cross-origin isolated: ${window.crossOriginIsolated}`)
  if (!window.crossOriginIsolated || typeof SharedArrayBuffer !== 'function') {
    throw new Error('This experiment requires cross-origin isolation and SharedArrayBuffer.')
  }
  const rounds = 20
  const shared = new SharedArrayBuffer(96)
  const control = new Int32Array(shared, 0, 8)
  const payload = new Uint8Array(shared, 32, 64)
  const worker = new Worker(
    new URL('./prk81c-worker-mailbox-worker.ts', import.meta.url),
    { type: 'module' },
  )
  let received = 0
  let heartbeats = 0
  let sumWaitMs = 0
  let dispatchCount = 0
  const heartbeat = window.setInterval(() => { heartbeats++ }, 5)
  const startedAt = performance.now()
  report(`Running ${rounds} real worker waits with browser-side packet delivery`)

  try {
    const completed = await new Promise<number>((resolve, reject) => {
      const watchdog = window.setTimeout(() => {
        reject(new Error('Worker test timed out after 8 seconds.'))
      }, 8000)
      const finish = (err?: Error, roundsDone?: number) => {
        window.clearTimeout(watchdog)
        if (err) reject(err)
        else resolve(roundsDone ?? 0)
      }
      worker.onerror = event => finish(new Error(event.message || 'Worker crashed.'))
      worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
        const message = event.data
        if (!message || typeof message !== 'object') {
          finish(new Error('Malformed worker response.'))
          return
        }
        if (message.kind === 'error') {
          finish(new Error(message.message))
          return
        }
        if (message.kind === 'awaiting') {
          const round = message.round
          // The worker is blocked in Atomics.wait. A regular postMessage
          // cannot wake it: only the shared-memory store+notify can.
          window.setTimeout(() => {
            if (round !== dispatchCount + 1) {
              finish(new Error(`Out-of-order mailbox request ${round}`))
              return
            }
            payload.fill(0)
            payload[10] = 24 // 802.11 MAC header length (36 - 12)
            payload[12] = 0x08
            payload[13] = 0x01
            payload[14] = round & 0xff
            Atomics.store(control, 1, round) // logical command sequence
            Atomics.store(control, 2, 36)    // frame length
            Atomics.store(control, 3, 1)     // emulated client AID
            Atomics.store(control, 0, 1)     // publish committed reply
            Atomics.notify(control, 0, 1)
            dispatchCount += 1
          }, 10)
          return
        }
        if (message.kind === 'received') {
          if (message.round !== received + 1) {
            finish(new Error(`Out-of-order worker receipt ${message.round}`))
            return
          }
          received += 1
          sumWaitMs += message.waitMs
          if (received <= 3 || received === rounds) {
            report(`Received verified mailbox reply ${received}/${rounds} (worker waited ${message.waitMs.toFixed(1)} ms)`)
          }
          return
        }
        if (message.kind === 'complete') finish(undefined, message.rounds)
      }
      worker.postMessage({ kind: 'start', shared, rounds })
    })
    const elapsed = performance.now() - startedAt
    if (completed !== rounds || received !== rounds || dispatchCount !== rounds) {
      throw new Error(`Incomplete handshakes: completed ${completed}, received ${received}, delivered ${dispatchCount}`)
    }
    if (heartbeats < 5) {
      throw new Error(`Browser event loop did not keep running: only ${heartbeats} heartbeats`)
    }
    report(`Worker replies: ${received}/${rounds}`)
    report(`Browser event-loop heartbeats: ${heartbeats}`)
    report(`Average worker wait: ${(sumWaitMs / rounds).toFixed(1)} ms`)
    report(`Elapsed: ${elapsed.toFixed(1)} ms`)
    report('PASS: main thread delivered test packets while the worker was blocked.')
    report('This verifies the worker + mailbox mechanism, NOT actual melonDS integration.')
  } finally {
    window.clearInterval(heartbeat)
    worker.terminate()
  }
}

void run().catch(error => {
  report(`FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
})
