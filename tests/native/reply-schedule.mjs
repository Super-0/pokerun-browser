import assert from 'node:assert/strict'

export async function checkReplySchedules(page) {
  const result = await page.evaluate(async () => {
    const { loadMelonDsRuntime } = await import('/src/core/emulator/melonds/runtime.ts')
    const { WasmEmulator } = await loadMelonDsRuntime()
    const pollDsUs = 10_000
    const aid = 1
    const expectedAidMask = 1 << aid

    function run(pollAtUs, replyDsUs) {
      const host = new WasmEmulator()
      try {
        if (typeof host.pokerunTestPollMpReplies !== 'function' ||
            typeof host.pokerunTestSendMpCommand !== 'function') {
          throw new Error('Build melonDS with POKERUN_NATIVE_TEST_HOOKS=1 before running this test.')
        }
        host.prk66SetEnabled(true)
        const reply = new Uint8Array(36)
        reply[10] = reply.length - 12
        let commandLength, commandDsUs, queued, mask, queuedAtPoll
        // Virtual host time, in microseconds. The 70 µs first poll and
        // millisecond-scale delivery intervals approximate the real capture.
        // Only the first poll moves between the two ordering scenarios.
        const events = [
          [0, () => { commandLength = host.pokerunTestSendMpCommand(pollDsUs) }],
          [8000, () => { commandDsUs = host.prk66TakeOutgoing()?.timestamp }],
          [14_700, () => {
            if (commandDsUs !== pollDsUs) throw new Error('Peer received no synthetic command.')
          }],
          [26_800, () => {
            queued = host.prk79InjectReply(reply, replyDsUs, aid, 1)
          }],
          [pollAtUs, () => {
            queuedAtPoll = host.prk79ReplyRx()
            mask = host.pokerunTestPollMpReplies(pollDsUs, expectedAidMask)
          }],
        ]
        for (const [, event] of events.sort(([a], [b]) => a - b)) event()
        return {
          commandLength, commandDsUs, queued, mask, queuedAtPoll,
          replies: host.prk79ReplyRx(), polls: host.prk79HostPoll(),
          empty: host.prk80EmptyPoll(), stale: host.prk79Stale(), matched: host.prk79HostMatch(),
        }
      } finally { host.delete() }
    }

    return {
      early: run(70, pollDsUs),
      inFlight: run(10_000, pollDsUs),
      late: run(27_000, pollDsUs),
      boundary: run(27_000, pollDsUs - 32),
      stale: run(27_000, pollDsUs - 33),
    }
  })
  const common = { commandLength: 36, commandDsUs: 10_000, queued: true, replies: 1, polls: 1 }
  const empty = { ...common, mask: 0, queuedAtPoll: 0, empty: 1, stale: 0, matched: 0 }
  const matched = { ...common, mask: 2, queuedAtPoll: 1, empty: 0, stale: 0, matched: 1 }
  assert.deepEqual(result, {
    early: empty,
    inFlight: empty,
    late: matched,
    boundary: matched,
    stale: { ...common, mask: 0, queuedAtPoll: 1, empty: 0, stale: 1, matched: 0 },
  })
}
