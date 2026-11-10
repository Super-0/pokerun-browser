import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function range(values) {
  if (!values.length) return { count: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  return { count: sorted.length, min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) }
}

function summarizeHardware(native) {
  const totals = {
    replyAttempts: 0, replyBlocked: 0, replyStarted: 0, protectedReplyStarted: 0,
    replyFinished: 0, replyRingCommitted: 0, replyRingMpReply: 0, replyRingOverflow: 0,
    replyCursorAdvanced: 0, ackTx: 0, ackTxWithoutClientFailure: 0,
    ackTxWithExpiredCommandCounter: 0, ackRingCommitted: 0, ackCursorAdvanced: 0,
  }
  const pendingByRole = new Map([[1, []], [2, []]])
  let observed = false
  for (const event of native) {
    const { kind, role, replyUs: detail, aidOrMask: flags } = event
    if (kind < 11 || kind > 18) continue
    observed = true
    const pending = pendingByRole.get(role)
    switch (kind) {
      case 11:
        totals.replyAttempts++
        if (flags) totals.replyBlocked++
        break
      case 12:
        totals.replyStarted++
        if (flags & 0x4000) totals.protectedReplyStarted++
        break
      case 13: totals.replyFinished++; break
      case 14:
        totals.replyRingCommitted++
        if ((flags & 0x800F) === 0x800E) totals.replyRingMpReply++
        pending.push({ kind, end: detail >>> 16 })
        break
      case 15: totals.replyRingOverflow++; break
      case 16: {
        const previous = detail & 0xFFFF
        const next = detail >>> 16
        pendingByRole.set(role, pending.filter(({ kind: frameKind, end }) => {
          const advanced = previous < next ? end > previous && end <= next : end > previous || end <= next
          if (advanced) totals[frameKind === 14 ? 'replyCursorAdvanced' : 'ackCursorAdvanced']++
          return !advanced
        }))
        break
      }
      case 17:
        totals.ackTx++
        if (!flags) totals.ackTxWithoutClientFailure++
        if (!detail) totals.ackTxWithExpiredCommandCounter++
        break
      case 18:
        totals.ackRingCommitted++
        pending.push({ kind, end: detail >>> 16 })
        break
    }
  }
  return observed ? totals : null
}

function summarizeGfl(native) {
  const routines = new Map([
    [0x0203F81C, 'receive-machine'], [0x0203F924, 'receive-server'],
    [0x02040530, 'send-negotiation'], [0x020408AC, 'receive-negotiation'],
    [0x02040988, 'receive-negotiation-reply'], [0x020424D8, 'network-error'],
    [0x02080B2C, 'wm-fifo'], [0x02081E1C, 'wm-step'], [0x020820F0, 'wm-parent-port'], [0x020821B4, 'wm-child-port'],
  ])
  const counters = {}
  for (const { kind, role, sequence, replyUs, aidOrMask } of native) {
    if (kind !== 19 && kind !== 20) continue
    const routine = routines.get(sequence)
    if (!routine) continue
    let label = `${role}:${routine}`
    if (kind === 20) label += `:${aidOrMask}:${replyUs ? 'accepted' : 'returned-false'}`
    else if (routine === 'wm-step') label += `:result-${replyUs}:received-${aidOrMask}`
    else if (routine === 'wm-fifo') label += `:api-${replyUs}:state-${aidOrMask & 255}:error-${aidOrMask >>> 8}`
    else if (routine.endsWith('-port')) {
      label += `:state-${(aidOrMask >>> 4) & 255}:error-${aidOrMask >>> 12}:aid-${aidOrMask & 15}:length-${replyUs}`
    } else if (routine.startsWith('receive-') && sequence <= 0x0203F924) {
      label += `:${aidOrMask & 0xFF}:${['invalid', 'idle', 'data'][aidOrMask >>> 8] ?? 'unknown'}`
    } else if (routine === 'network-error') label += `:${replyUs}`
    else if (routine.startsWith('receive-')) label += `:${aidOrMask}`
    counters[label] = (counters[label] ?? 0) + 1
  }
  return Object.keys(counters).length ? counters : null
}

// Match the first peer ACK ring write within each reply interval. An SDK
// error is counted only when it occurred in that same interval before RX.
function summarizePeerAckTiming(native) {
  const pending = new Map()
  const replyToAckMs = [], replyToAckDsUs = [], replyToSdkErrorMs = []
  let sdkErrorsBeforeRing = 0
  for (const event of native) {
    const { kind, role, atMs, dsUs, sequence, replyUs, aidOrMask } = event
    if (kind === 2) {
      pending.set(role, { atMs, dsUs })
      continue
    }
    const reply = pending.get(role)
    if (!reply) continue
    if (kind === 19 && sequence === 0x02080B2C && replyUs === 0xE &&
        (aidOrMask & 255) === 13 && (aidOrMask >>> 8) !== 0 && reply.errorAt === undefined) {
      reply.errorAt = atMs
    }
    if (kind !== 18) continue
    replyToAckMs.push(atMs - reply.atMs)
    replyToAckDsUs.push(dsUs - reply.dsUs)
    if (reply.errorAt !== undefined) {
      sdkErrorsBeforeRing++
      replyToSdkErrorMs.push(reply.errorAt - reply.atMs)
    }
    pending.delete(role)
  }
  return {
    sdkErrorsBeforeRing, replyToAckMs: range(replyToAckMs),
    replyToAckDsUs: range(replyToAckDsUs), replyToSdkErrorMs: range(replyToSdkErrorMs),
  }
}

export function summarizeGreetingTrace(traces) {
  const key = (role, id) => `${role}:${id}`
  const native = []
  const wire = traces.flatMap(trace => trace.wire)
  let incomplete = false
  for (const trace of traces) {
    incomplete ||= !trace.complete || !trace.wire.length || !trace.native.length ||
      Boolean(trace.droppedWire || trace.droppedBatches)
    for (const batch of trace.native) {
      incomplete ||= Boolean(batch.dropped) || batch.values.length % 7 !== 0 ||
        batch.nativeNowMs < batch.beforeMs - 1 || batch.nativeNowMs > batch.afterMs + 1
      for (let i = 0; i < batch.values.length; i += 7) {
        const [kind, atMs, dsUs, replyUs, sequence, aidOrMask, poll] = batch.values.slice(i, i + 7)
        native.push({ role: trace.role, kind, atMs, dsUs, replyUs, sequence, aidOrMask, poll })
      }
    }
  }
  const index = (events, eventKey) => new Map(events.map(event => [eventKey(event), event]))
  const sends = index(wire.filter(event => event.phase === 'send'), e => key(e.source, e.sequence))
  const arrivals = index(wire.filter(event => event.phase === 'arrival'), e => key(e.source, e.sequence))
  const nativeSends = index(native.filter(event => event.kind === 1 || event.kind === 2), e => key(e.role, e.sequence))
  const commands = [], replies = [], nativeToWire = [], hostCommandToPoll = [], arrivalToQueue = []
  const sendsByNativeId = new Map()
  let sendsWithoutArrival = 0
  for (const [id, sent] of sends) {
    const tx = nativeSends.get(key(sent.source, sent.nativeTxId))
    if (!tx) continue
    sendsByNativeId.set(key(sent.source, sent.nativeTxId), sent)
    nativeToWire.push(sent.atMs - tx.atMs)
    const arrival = arrivals.get(id)
    if (!arrival) { sendsWithoutArrival++; continue }
    const times = tx.kind === 1 ? commands : replies
    times.push(arrival.atMs - sent.atMs)
  }

  const decisions = { emptyPoll: 0, queuedPoll: 0, stale: 0, otherAid: 0, matched: 0, blank: 0, duplicateAid: 0 }
  const decisionLabels = ['emptyPoll', 'queuedPoll', 'stale', 'otherAid', 'matched', 'blank', 'duplicateAid']
  const staleDelta = [], matchedDelta = [], staleOffset = [], matchedOffset = [], queueToPoll = []
  const queued = index(native.filter(event => event.kind === 10), e => key(e.role, e.sequence))
  for (const enqueued of queued.values()) {
    const arrival = arrivals.get(key(3 - enqueued.role, enqueued.sequence))
    if (arrival) arrivalToQueue.push(enqueued.atMs - arrival.atMs)
  }
  const firstPolls = new Set()
  const emptyFirstPolls = { beforeBrowserSend: 0, beforePeerArrival: 0, afterPeerArrival: 0, noObservedSend: 0, noObservedArrival: 0 }
  for (const event of native) {
    const { kind, role, sequence, dsUs, replyUs, atMs } = event
    if (kind < 3 || kind > 9) continue
    decisions[decisionLabels[kind - 3]]++
    if (kind === 3 || kind === 4) {
      const commandKey = key(role, sequence)
      const command = nativeSends.get(commandKey)
      if (command && !firstPolls.has(commandKey)) {
        firstPolls.add(commandKey)
        hostCommandToPoll.push(atMs - command.atMs)
        if (kind === 3) {
          const sent = sendsByNativeId.get(commandKey)
          const arrival = sent && arrivals.get(key(role, sent.sequence))
          if (!sent) emptyFirstPolls.noObservedSend++
          else if (atMs < sent.atMs) emptyFirstPolls.beforeBrowserSend++
          else if (!arrival) emptyFirstPolls.noObservedArrival++
          else if (atMs < arrival.atMs) emptyFirstPolls.beforePeerArrival++
          else emptyFirstPolls.afterPeerArrival++
        }
      }
      continue
    }
    if (kind !== 5 && kind !== 7) continue
    const raw = replyUs - dsUs
    const rawDeltas = kind === 5 ? staleDelta : matchedDelta
    rawDeltas.push(raw)
    const enqueued = queued.get(key(role, sequence))
    if (enqueued) queueToPoll.push(atMs - enqueued.atMs)
    const sent = sends.get(key(3 - role, sequence))
    const tx = nativeSends.get(key(3 - role, sent?.nativeTxId))
    if (tx?.kind === 2) {
      // At nominal speed, remove the elapsed wall time between the two samples.
      // Drift, emulation batching and timer resolution can affect this estimate.
      const effectiveOffset = raw - (tx.atMs - atMs) * 1000
      const offsets = kind === 5 ? staleOffset : matchedOffset
      offsets.push(effectiveOffset)
    }
  }
  return {
    incomplete,
    commandDeliveryMs: range(commands),
    replyDeliveryMs: range(replies),
    nativeTxToBrowserSendMs: range(nativeToWire),
    hostCommandToFirstPollMs: range(hostCommandToPoll),
    replyQueueToDecisionMs: range(queueToPoll),
    replyArrivalToNativeQueueMs: range(arrivalToQueue),
    nativeTxWithoutBrowserSend: nativeSends.size - sendsByNativeId.size,
    sendsWithoutArrival,
    decisions,
    emptyFirstPolls,
    hardware: summarizeHardware(native),
    gflCallbacks: summarizeGfl(native),
    peerAckTiming: summarizePeerAckTiming(native),
    staleReplyMinusPollDsUs: range(staleDelta),
    matchedReplyMinusPollDsUs: range(matchedDelta),
    estimatedStaleClockOffsetUs: range(staleOffset),
    estimatedMatchedClockOffsetUs: range(matchedOffset),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = process.argv[2]
  if (!run) throw new Error('Pass the private run directory.')
  const traces = await Promise.all([1, 2].map(async role => JSON.parse(await readFile(join(run, `p${role}-timing.json`), 'utf8'))))
  if (traces.some((trace, index) => trace?.role !== index + 1)) throw new Error('Both role traces are required.')
  const summary = summarizeGreetingTrace(traces)
  console.log(JSON.stringify(summary, null, 2))
  if (summary.incomplete) process.exitCode = 1
}
