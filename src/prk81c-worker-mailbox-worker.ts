// PRK81C: isolate the execution topology before moving melonDS itself.
// This worker plays the role of the native DS host: it publishes an outgoing
// command, blocks waiting for a real reply in shared memory, then validates it.
// Messages are never processed *within* the blocked worker; the main thread
// writes the mailbox directly and issues Atomics.notify().
type Start = { kind: 'start'; shared: SharedArrayBuffer; rounds: number }
type ToMain =
  | { kind: 'awaiting'; round: number }
  | { kind: 'received'; round: number; waitMs: number }
  | { kind: 'complete'; rounds: number }
  | { kind: 'error'; message: string }

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<Start>) => void) | null
  postMessage: (message: ToMain) => void
}

ctx.onmessage = event => {
  if (event.data?.kind !== 'start') return
  const { shared, rounds } = event.data
  try {
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) {
      throw new Error('Invalid test round count.')
    }
    const control = new Int32Array(shared, 0, 8)
    const payload = new Uint8Array(shared, 32, 64)
    for (let round = 1; round <= rounds; round += 1) {
      // The main thread must finish writing bytes and metadata before
      // publishing state=1 (release) and notifying the waiting worker.
      Atomics.store(control, 0, 0)
      const startedAt = performance.now()
      ctx.postMessage({ kind: 'awaiting', round })
      const wake = Atomics.wait(control, 0, 0, 2000)
      if (wake === 'timed-out') {
        throw new Error('Mailbox timed out on round ' + round)
      }
      if (Atomics.load(control, 0) !== 1) {
        throw new Error('Worker awakened without a committed packet.')
      }
      const sequence = Atomics.load(control, 1)
      const length = Atomics.load(control, 2)
      const aid = Atomics.load(control, 3)
      if (sequence !== round || length !== 36 || aid !== 1 ||
          payload[10] !== 24 || payload[11] !== 0 ||
          payload[12] !== 0x08 || payload[13] !== 0x01 ||
          payload[14] !== (round & 0xff)) {
        throw new Error(`Mailbox packet failed validation: round ${round}, sequence ${sequence}, length ${length}, aid ${aid}`)
      }
      ctx.postMessage({ kind: 'received', round, waitMs: performance.now() - startedAt })
    }
    ctx.postMessage({ kind: 'complete', rounds })
  } catch (error) {
    ctx.postMessage({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
