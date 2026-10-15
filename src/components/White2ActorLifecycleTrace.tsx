import { useState } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2ActorSystemProbe, type White2ActorHeapEntry, type White2ActorHeapScan } from '../multiplayer/games/White2ActorSystem'
import { PixelButton } from './PixelButton'

const WHITE2_BASE_POINTER = 0x02000024
const WHITE2_POSITION_OFFSET = 0x36780
const FIELD_ACTOR_SIZE = 0x100
const WORDS_PER_ACTOR = FIELD_ACTOR_SIZE / 4
const MAX_VISIBLE_WORD_CHANGES = 48

type ActorRaw = {
  index: number
  address: number
  words: number[]
}

type TraceSnapshot = {
  capturedAt: number
  mapId: number
  scan: White2ActorHeapScan
  raw: ActorRaw[]
}

type WordChange = {
  offset: number
  before: number
  after: number
}

type ActorSlotDiff = {
  index: number
  before: White2ActorHeapEntry
  after: White2ActorHeapEntry
  wordChanges: WordChange[]
  interesting: boolean
}

type TraceDiff = {
  before: TraceSnapshot
  after: TraceSnapshot
  slots: ActorSlotDiff[]
  created: number[]
  destroyed: number[]
  replaced: number[]
}

function hex(value: number, width = 8) {
  return value.toString(16).toUpperCase().padStart(width, '0')
}

function isLive(entry: White2ActorHeapEntry) {
  return entry.state === 'active' || entry.state === 'player'
}

function identityChanged(before: White2ActorHeapEntry, after: White2ActorHeapEntry) {
  return before.uid !== after.uid ||
    before.modelId !== after.modelId ||
    before.zoneId !== after.zoneId ||
    before.tcb !== after.tcb ||
    before.actorSystemBackptr !== after.actorSystemBackptr ||
    before.moveCodeVTable !== after.moveCodeVTable ||
    before.sceneNodeVTable !== after.sceneNodeVTable
}

function compareSnapshots(before: TraceSnapshot, after: TraceSnapshot): TraceDiff {
  const slots: ActorSlotDiff[] = []
  const created: number[] = []
  const destroyed: number[] = []
  const replaced: number[] = []
  const count = Math.min(before.scan.entries.length, after.scan.entries.length)

  for (let index = 0; index < count; index += 1) {
    const beforeEntry = before.scan.entries[index]
    const afterEntry = after.scan.entries[index]
    const beforeRaw = before.raw[index]?.words ?? []
    const afterRaw = after.raw[index]?.words ?? []
    const wordChanges: WordChange[] = []

    for (let word = 0; word < Math.min(beforeRaw.length, afterRaw.length); word += 1) {
      if (beforeRaw[word] !== afterRaw[word]) {
        wordChanges.push({ offset: word * 4, before: beforeRaw[word], after: afterRaw[word] })
      }
    }

    const beforeLive = isLive(beforeEntry)
    const afterLive = isLive(afterEntry)
    if (!beforeLive && afterLive) created.push(index)
    if (beforeLive && !afterLive) destroyed.push(index)
    if (beforeLive && afterLive && identityChanged(beforeEntry, afterEntry)) replaced.push(index)

    const interesting = beforeEntry.state !== afterEntry.state || identityChanged(beforeEntry, afterEntry)
    if (interesting || wordChanges.length) slots.push({ index, before: beforeEntry, after: afterEntry, wordChanges, interesting })
  }

  return { before, after, slots, created, destroyed, replaced }
}

function entrySummary(entry: White2ActorHeapEntry) {
  return `${entry.state.toUpperCase()} UID ${entry.uid} MODEL ${entry.modelId} ZONE ${entry.zoneId} X ${entry.x} Y ${entry.y} H ${entry.height} FACE ${entry.faceDir} TCB 0x${hex(entry.tcb)} OWNER 0x${hex(entry.actorSystemBackptr)} MOVEVT 0x${hex(entry.moveCodeVTable)} SCENEVT 0x${hex(entry.sceneNodeVTable)}`
}

export function White2ActorLifecycleTrace({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const [baseline, setBaseline] = useState<TraceSnapshot | null>(null)
  const [diff, setDiff] = useState<TraceDiff | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const supported = White2ActorSystemProbe.supportsRom(rom)

  async function captureSnapshot(): Promise<TraceSnapshot> {
    if (!bridge) throw new Error('WAIT FOR MELONDS TO FINISH BOOTING.')
    const wasRunning = bridge.status === 'running'
    if (wasRunning) await bridge.pause()
    try {
      const actorSystem = new White2ActorSystemProbe(bridge)
      const scan = await actorSystem.scanHeap()
      const base = await bridge.read32(WHITE2_BASE_POINTER)
      const mapId = await bridge.read16((base + WHITE2_POSITION_OFFSET) >>> 0)
      const raw: ActorRaw[] = []

      for (const entry of scan.entries) {
        const words: number[] = []
        for (let word = 0; word < WORDS_PER_ACTOR; word += 1) {
          words.push(await bridge.read32(entry.address + word * 4))
        }
        raw.push({ index: entry.index, address: entry.address, words })
      }

      return { capturedAt: Date.now(), mapId, scan, raw }
    } finally {
      if (wasRunning && bridge.status === 'paused') await bridge.resume()
    }
  }

  async function captureBaseline() {
    if (!bridge || !supported) return
    setBusy(true)
    setStatus(null)
    setDiff(null)
    try {
      const snapshot = await captureSnapshot()
      setBaseline(snapshot)
      setStatus(`BASELINE CAPTURED • MAP ${snapshot.mapId} • HEAP 0x${hex(snapshot.scan.actorHeap)} • ${snapshot.scan.activeSlots.length + snapshot.scan.playerSlots.length} LIVE ACTORS`)
    } catch (reason) {
      setStatus(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • BASELINE CAPTURE FAILED.')
    } finally {
      setBusy(false)
    }
  }

  async function captureAfter() {
    if (!bridge || !supported || !baseline) return
    setBusy(true)
    setStatus(null)
    try {
      const after = await captureSnapshot()
      const comparison = compareSnapshots(baseline, after)
      setDiff(comparison)
      setStatus(`TRACE COMPLETE • MAP ${baseline.mapId}→${after.mapId} • CREATED ${comparison.created.length} • DESTROYED ${comparison.destroyed.length} • REPLACED ${comparison.replaced.length}`)
    } catch (reason) {
      setStatus(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • AFTER CAPTURE FAILED.')
    } finally {
      setBusy(false)
    }
  }

  function copyTrace() {
    if (!diff) return
    const important = diff.slots.filter(slot => slot.interesting)
    const lines = [
      'WHITE 2 ACTOR LIFECYCLE TRACE',
      `BEFORE MAP ${diff.before.mapId} ACTOR_SYSTEM 0x${hex(diff.before.scan.actorSystem)} HEAP 0x${hex(diff.before.scan.actorHeap)} @ ${new Date(diff.before.capturedAt).toISOString()}`,
      `AFTER  MAP ${diff.after.mapId} ACTOR_SYSTEM 0x${hex(diff.after.scan.actorSystem)} HEAP 0x${hex(diff.after.scan.actorHeap)} @ ${new Date(diff.after.capturedAt).toISOString()}`,
      `CREATED: ${diff.created.length ? diff.created.join(', ') : 'NONE'}`,
      `DESTROYED: ${diff.destroyed.length ? diff.destroyed.join(', ') : 'NONE'}`,
      `REPLACED: ${diff.replaced.length ? diff.replaced.join(', ') : 'NONE'}`,
      '',
      ...important.flatMap(slot => [
        `SLOT ${slot.index} @ BEFORE 0x${hex(slot.before.address)} / AFTER 0x${hex(slot.after.address)}`,
        `BEFORE ${entrySummary(slot.before)}`,
        `AFTER  ${entrySummary(slot.after)}`,
        ...slot.wordChanges.map(change => `+0x${hex(change.offset, 2)}: 0x${hex(change.before)} -> 0x${hex(change.after)}`),
        '',
      ]),
    ]
    void navigator.clipboard.writeText(lines.join('\n')).then(() => setStatus('TRACE COPIED.')).catch(() => setStatus('COPY FAILED: BROWSER CLIPBOARD PERMISSION WAS DENIED.'))
  }

  const importantSlots = diff?.slots.filter(slot => slot.interesting) ?? []

  return <section className="white2-memory-research pixel-border">
    <h2>WHITE 2 ACTOR LIFECYCLE TRACE</h2>
    <p>Capture a coherent 64-slot baseline while standing still, cross a doorway or map transition normally, then capture again. Each capture pauses melonDS while reading every 0x100-byte FieldActor record as 32-bit words, then resumes. This tool performs no writes.</p>
    <div className="memory-compare">
      <PixelButton tone="ghost" disabled={!bridge || !supported || busy} onClick={() => void captureBaseline()}>{busy ? 'CAPTURING...' : baseline ? 'RECAPTURE BASELINE' : 'CAPTURE ACTOR BASELINE'}</PixelButton>
      <PixelButton tone="ghost" disabled={!bridge || !supported || !baseline || busy} onClick={() => void captureAfter()}>CAPTURE AFTER + DIFF</PixelButton>
      <PixelButton tone="ghost" disabled={!diff || busy} onClick={copyTrace}>COPY LIFECYCLE TRACE</PixelButton>
      <PixelButton tone="danger" disabled={busy || (!baseline && !diff)} onClick={() => { setBaseline(null); setDiff(null); setStatus(null) }}>CLEAR TRACE</PixelButton>
    </div>
    {!supported && <span className="form-error">DISABLED FOR THIS ROM FINGERPRINT.</span>}
    {status && <span className={status.startsWith('FAIL') ? 'form-error' : 'memory-ok'}>{status}</span>}
    {baseline && <code>BASELINE • MAP {baseline.mapId} • ACTOR SYSTEM 0x{hex(baseline.scan.actorSystem)} • HEAP 0x{hex(baseline.scan.actorHeap)} • PLAYER {baseline.scan.playerSlots.join(', ') || 'NONE'} • ACTIVE {baseline.scan.activeSlots.join(', ') || 'NONE'}</code>}
    {diff && <>
      <code>AFTER • MAP {diff.after.mapId} • ACTOR SYSTEM 0x{hex(diff.after.scan.actorSystem)} • HEAP 0x{hex(diff.after.scan.actorHeap)}</code>
      <code>CREATED: {diff.created.length ? diff.created.join(', ') : 'NONE'} • DESTROYED: {diff.destroyed.length ? diff.destroyed.join(', ') : 'NONE'} • REPLACED: {diff.replaced.length ? diff.replaced.join(', ') : 'NONE'}</code>
      {importantSlots.length === 0 ? <span>NO ACTOR LIFECYCLE CHANGES FOUND. TRY A TRANSITION THAT LOADS OR UNLOADS NPCS.</span> : importantSlots.map(slot => <div className="memory-results" key={slot.index}>
        <strong>SLOT {slot.index} • {slot.before.state.toUpperCase()} → {slot.after.state.toUpperCase()} • {slot.wordChanges.length} CHANGED WORDS</strong>
        <code>BEFORE • {entrySummary(slot.before)}</code>
        <code>AFTER • {entrySummary(slot.after)}</code>
        {slot.wordChanges.slice(0, MAX_VISIBLE_WORD_CHANGES).map(change => <code key={change.offset}>+0x{hex(change.offset, 2)} • 0x{hex(change.before)} → 0x{hex(change.after)}</code>)}
        {slot.wordChanges.length > MAX_VISIBLE_WORD_CHANGES && <span>DISPLAY LIMITED TO {MAX_VISIBLE_WORD_CHANGES} WORDS FOR THIS SLOT; COPY LIFECYCLE TRACE INCLUDES ALL CHANGES.</span>}
      </div>)}
    </>}
    <span>BEST TEST: CAPTURE BASELINE JUST BEFORE A DOOR, WALK THROUGH IT, WAIT UNTIL THE NEW MAP IS FULLY VISIBLE, THEN CAPTURE AFTER + DIFF.</span>
  </section>
}
