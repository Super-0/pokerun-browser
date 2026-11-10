import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeGreetingTrace } from '../../scripts/summarize-greeting-trace.mjs'

test('greeting evidence separates late arrival, native poll, and stale timestamp math', () => {
  const batch = (...rows) => ({ beforeMs: 199, afterMs: 201, nativeNowMs: 200, values: rows.flat(), dropped: 0 })
  const wire = (phase, source, sequence, nativeTxId, atMs) => ({ phase, source, sequence, nativeTxId, atMs })
  const host = {
    role: 1, complete: true,
    native: [batch([1, 100, 10_000, 0, 1, 0, 0], [3, 104, 14_000, 0, 1, 2, 1],
      [10, 108, 13_000, 0, 5, 1, 0], [4, 109, 19_000, 0, 1, 2, 2], [5, 109, 19_000, 13_000, 5, 1, 2],
      [1, 110, 20_000, 0, 2, 0, 0], [3, 111, 21_000, 0, 2, 2, 3],
      [1, 115, 25_000, 0, 3, 0, 0], [3, 117, 27_000, 0, 3, 2, 4])],
    wire: [wire('send', 1, 5, 1, 101), wire('send', 1, 6, 2, 112), wire('send', 1, 7, 3, 116), wire('arrival', 2, 5, undefined, 108)],
  }
  const peer = {
    role: 2, complete: true,
    native: [batch([2, 105, 13_000, 0, 1, 1, 0])],
    wire: [wire('arrival', 1, 5, undefined, 102), wire('arrival', 1, 6, undefined, 113), wire('arrival', 1, 7, undefined, 118), wire('send', 2, 5, 1, 106)],
  }
  const result = summarizeGreetingTrace([host, peer])
  assert.equal(result.incomplete, false)
  assert.equal(result.commandDeliveryMs.median, 1)
  assert.equal(result.replyDeliveryMs.median, 2)
  assert.equal(result.hostCommandToFirstPollMs.median, 2)
  assert.equal(result.decisions.emptyPoll, 3)
  assert.equal(result.emptyFirstPolls.beforeBrowserSend, 1)
  assert.equal(result.emptyFirstPolls.beforePeerArrival, 1)
  assert.equal(result.emptyFirstPolls.afterPeerArrival, 1)
  assert.equal(result.decisions.stale, 1)
  assert.equal(result.replyArrivalToNativeQueueMs.median, 0)
  assert.equal(result.replyQueueToDecisionMs.median, 1)
  assert.equal(result.staleReplyMinusPollDsUs.median, -6000)
  assert.equal(result.estimatedStaleClockOffsetUs.median, -2000)
  host.native[0].dropped = 1
  assert.equal(summarizeGreetingTrace([host, peer]).incomplete, true)
})

test('hardware summary distinguishes collector, RX ring, cursor, and peer ACK', () => {
  const span = (start, end) => (end << 16) | start
  const trace = (role, rows) => ({
    role, complete: true, wire: [],
    native: [{ beforeMs: 99, afterMs: 101, nativeNowMs: 100, values: rows.flat() }],
  })
  const event = (kind, detail, flags) => [kind, 50, 1_000, detail, 10, flags, 1]
  const host = trace(1, [
    event(11, 1, 0), event(12, 44, 0x4000), event(13, 44, 0x4000),
    event(14, span(100, 124), 0x800E), event(16, span(100, 124), 124),
    event(11, 1, 2), event(17, 0, 0),
  ])
  const peer = trace(2, [
    event(18, span(4000, 10), 0x800D), event(16, span(4000, 11), 11),
  ])
  assert.deepEqual(summarizeGreetingTrace([host, peer]).hardware, {
    replyAttempts: 2, replyBlocked: 1, replyStarted: 1, protectedReplyStarted: 1,
    replyFinished: 1, replyRingCommitted: 1, replyRingMpReply: 1, replyRingOverflow: 0,
    replyCursorAdvanced: 1, ackTx: 1, ackTxWithoutClientFailure: 1,
    ackTxWithExpiredCommandCounter: 1, ackRingCommitted: 1, ackCursorAdvanced: 1,
  })
})

test('GFL callback summary separates data and idle receives from game negotiation', () => {
  const event = (kind, address, detail, flags) => [kind, 100, 0, detail, address, flags, 0]
  const host = {
    role: 1, complete: true, wire: [],
    native: [{ beforeMs: 99, afterMs: 101, nativeNowMs: 100, values: [
      event(19, 0x0203F81C, 96, 0x201), event(20, 0x0203F81C, 1, 1),
      event(19, 0x0203F81C, 96, 0x101), event(20, 0x0203F81C, 0, 1),
      event(19, 0x020408AC, 9, 1), event(19, 0x020424D8, 1010, 0),
      event(19, 0x02080B2C, 0x82, 0x15), event(19, 0x02081E1C, 0, 3), event(19, 0x020820F0, 90, (0x15 << 4) | 1),
    ].flat() }],
  }
  assert.deepEqual(summarizeGreetingTrace([host]).gflCallbacks, {
    '1:receive-machine:1:data': 1,
    '1:receive-machine:1:accepted': 1,
    '1:receive-machine:1:idle': 1,
    '1:receive-machine:1:returned-false': 1,
    '1:receive-negotiation:1': 1,
    '1:network-error:1010': 1,
    '1:wm-fifo:api-130:state-21:error-0': 1,
    '1:wm-step:result-0:received-3': 1,
    '1:wm-parent-port:state-21:error-0:aid-1:length-90': 1,
  })
})

test('peer ACK ring arrival is separate from an earlier NitroSDK ACK error', () => {
  const peer = {
    role: 2, complete: true, wire: [],
    native: [{ beforeMs: 99, afterMs: 101, nativeNowMs: 100, values: [
      [2, 10, 1_000, 0, 1, 1, 0],
      [19, 12, 0, 0xE, 0x02080B2C, (9 << 8) | 13, 0],
      [18, 40, 31_000, 0, 9, 0x801D, 0],
      [2, 50, 41_000, 0, 2, 1, 0],
      [18, 60, 51_000, 0, 10, 0x801D, 0],
      [19, 62, 0, 0xE, 0x02080B2C, (9 << 8) | 13, 0],
    ].flat() }],
  }
  const timing = summarizeGreetingTrace([peer]).peerAckTiming
  assert.equal(timing.replyToAckMs.count, 2)
  assert.equal(timing.replyToAckDsUs.max, 30_000)
  assert.equal(timing.sdkErrorsBeforeRing, 1)
  assert.equal(timing.replyToSdkErrorMs.median, 2)
})
