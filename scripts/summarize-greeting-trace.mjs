import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function range(values) {
  if (!values.length) return { count: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  return { count: sorted.length, min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) }
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
