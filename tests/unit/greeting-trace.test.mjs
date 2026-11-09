import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeGreetingTrace } from '../../scripts/summarize-greeting-trace.mjs'

test('greeting evidence separates late arrival, native poll, and stale timestamp math', () => {
  const batch = (...rows) => ({ beforeMs: 199, afterMs: 201, nativeNowMs: 200, values: rows.flat(), dropped: 0 })
  const wire = (phase, source, sequence, nativeTxId, atMs) => ({ phase, source, sequence, nativeTxId, atMs })
  const host = {
    role: 1, complete: true,
    native: [batch([1, 100, 10_000, 0, 1, 0, 0], [3, 104, 14_000, 0, 1, 2, 1],
      [10, 108, 13_000, 0, 5, 1, 0], [4, 109, 19_000, 0, 1, 2, 2], [5, 109, 19_000, 13_000, 5, 1, 2])],
    wire: [wire('send', 1, 5, 1, 101), wire('arrival', 2, 5, undefined, 108)],
  }
  const peer = {
    role: 2, complete: true,
    native: [batch([2, 105, 13_000, 0, 1, 1, 0])],
    wire: [wire('arrival', 1, 5, undefined, 102), wire('send', 2, 5, 1, 106)],
  }
  const result = summarizeGreetingTrace([host, peer])
  assert.equal(result.incomplete, false)
  assert.equal(result.commandDeliveryMs.median, 1)
  assert.equal(result.replyDeliveryMs.median, 2)
  assert.equal(result.hostCommandToFirstPollMs.median, 4)
  assert.equal(result.decisions.emptyPoll, 1)
  assert.equal(result.decisions.stale, 1)
  assert.equal(result.replyArrivalToNativeQueueMs.median, 0)
  assert.equal(result.replyQueueToDecisionMs.median, 1)
  assert.equal(result.staleReplyMinusPollDsUs.median, -6000)
  assert.equal(result.estimatedStaleClockOffsetUs.median, -2000)
  host.native[0].dropped = 1
  assert.equal(summarizeGreetingTrace([host, peer]).incomplete, true)
})
