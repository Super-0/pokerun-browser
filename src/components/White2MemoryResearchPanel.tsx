import { useEffect, useMemo, useState } from 'react'
import { Arm9MemoryInspector, type Arm9ByteChange, type Arm9Snapshot } from '../core/emulator/melonds/Arm9MemoryInspector'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { PixelButton } from './PixelButton'

const MAX_LENGTH = 0x10000
const TESTED_WHITE2_SHA256 = '54bec4091ba3eb89f4e1ee4e2f3421005835804376a34e5e45f3157e1f55625a'
const WHITE2_BASE_POINTER = 0x02000024
const WHITE2_POSITION_OFFSET = 0x36780

type Comparison = { label: string; before: Arm9Snapshot; after: Arm9Snapshot; changes: Arm9ByteChange[] }
type PositionProbe = { base: number; position: number; map: number; x: number; y: number; z: number }

function snapshotLabel(index: number) { return index < 26 ? String.fromCharCode(65 + index) : `S${index + 1}` }
function parseHex(value: string) { const normalized = value.trim().replace(/^0x/i, ''); return /^[0-9a-f]+$/i.test(normalized) ? Number.parseInt(normalized, 16) : Number.NaN }
function hex(value: number, width = 2) { return value.toString(16).toUpperCase().padStart(width, '0') }
function date(value: number) { return new Date(value).toLocaleTimeString() }

/** DEV-only manual snapshot tool. It exposes no inferred meaning for captured ARM9 bytes. */
export function White2MemoryResearchPanel({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const inspector = useMemo(() => bridge ? new Arm9MemoryInspector(bridge) : null, [bridge])
  const [addressText, setAddressText] = useState('02000000')
  const [lengthText, setLengthText] = useState('65536')
  const [snapshots, setSnapshots] = useState<Arm9Snapshot[]>([])
  const [first, setFirst] = useState('A')
  const [second, setSecond] = useState('B')
  const [comparisons, setComparisons] = useState<Comparison[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState<PositionProbe | null>(null)
  const [probeError, setProbeError] = useState<string | null>(null)

  const probeEnabled = rom.sha256?.toLowerCase() === TESTED_WHITE2_SHA256

  useEffect(() => {
    if (!bridge || !probeEnabled) {
      setProbe(null)
      setProbeError(null)
      return
    }
    let cancelled = false
    async function refreshProbe() {
      try {
        const base = await bridge.read32(WHITE2_BASE_POINTER)
        const position = (base + WHITE2_POSITION_OFFSET) >>> 0
        const [map, x, z, y] = await Promise.all([
          bridge.read16(position + 0x00),
          bridge.read16(position + 0x06),
          bridge.read16(position + 0x0a),
          bridge.read16(position + 0x0e),
        ])
        if (!cancelled) {
          setProbe({ base, position, map, x, y, z })
          setProbeError(null)
        }
      } catch (reason) {
        if (!cancelled) {
          setProbe(null)
          setProbeError(reason instanceof Error ? reason.message.toUpperCase() : 'POSITION PROBE READ FAILED.')
        }
      }
    }
    void refreshProbe()
    const timer = window.setInterval(() => void refreshProbe(), 150)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [bridge, probeEnabled])

  function range() {
    const address = parseHex(addressText)
    const length = Number.parseInt(lengthText, 10)
    if (!Number.isInteger(address) || address < 0 || address > 0xffffffff) throw new Error('START ADDRESS MUST BE A VALID ARM9 HEX ADDRESS.')
    if (!Number.isInteger(length) || length < 1 || length > MAX_LENGTH) throw new Error(`LENGTH MUST BE 1–${MAX_LENGTH}.`)
    if (address + length - 1 > 0xffffffff) throw new Error('RANGE EXCEEDS THE ARM9 ADDRESS SPACE.')
    return { address, length }
  }
  async function capture() {
    try {
      if (!inspector) throw new Error('WAIT FOR MELONDS TO FINISH BOOTING.')
      const { address, length } = range()
      setBusy(true); setError(null)
      const snapshot = await inspector.capture(address, length)
      setSnapshots(current => [...current, snapshot])
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'CAPTURE FAILED.') }
    finally { setBusy(false) }
  }
  function comparePair(before: Arm9Snapshot, after: Arm9Snapshot) { return { label: `${snapshotLabel(snapshots.indexOf(before))}→${snapshotLabel(snapshots.indexOf(after))}`, before, after, changes: inspector!.compare(before, after) } }
  function compareSelected() {
    try {
      if (!inspector) throw new Error('WAIT FOR MELONDS TO FINISH BOOTING.')
      const before = snapshots.find((_, index) => snapshotLabel(index) === first)
      const after = snapshots.find((_, index) => snapshotLabel(index) === second)
      if (!before || !after) throw new Error('CHOOSE TWO CAPTURED SNAPSHOTS.')
      setError(null); setComparisons([comparePair(before, after)])
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'COMPARE FAILED.') }
  }
  function compareAll() {
    try {
      if (!inspector) throw new Error('WAIT FOR MELONDS TO FINISH BOOTING.')
      if (snapshots.length < 2) throw new Error('CAPTURE AT LEAST TWO SNAPSHOTS.')
      setError(null); setComparisons(snapshots.slice(1).map((after, index) => comparePair(snapshots[index], after)))
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'COMPARE FAILED.') }
  }
  function copyResults() {
    const lines = [
      `ROM FILE: ${rom.fileName ?? 'unknown'}`,
      `ROM SHA256: ${rom.sha256 ?? 'unknown'}`,
      `NDS TITLE: ${rom.title ?? 'unknown'}`,
      `GAME CODE: ${rom.gameCode ?? 'unknown'}`,
      '',
      ...comparisons.flatMap(comparison => [
        `SNAPSHOT ${comparison.label}`,
        `RANGE: 0x${hex(comparison.before.address, 8)}-0x${hex(comparison.before.address + comparison.before.bytes.length - 1, 8)}`,
        ...comparison.changes.map(change => `0x${hex(change.address, 8)}: ${hex(change.before)} -> ${hex(change.after)}`),
        '',
      ]),
    ]
    void navigator.clipboard.writeText(lines.join('\n')).then(() => setError('RESULTS COPIED.')).catch(() => setError('COPY FAILED: BROWSER CLIPBOARD PERMISSION WAS DENIED.'))
  }
  const option = (index: number) => snapshotLabel(index)
  const visibleChanges = comparisons.flatMap(comparison => comparison.changes.map(change => ({ comparison: comparison.label, change }))).slice(0, 500)
  return <section className="white2-memory-research pixel-border"><h2>WHITE 2 ARM9 MEMORY RESEARCH</h2><p>Reads the emulated ARM9 bus, not the WASM heap. Capture only controlled, bounded ranges; no bytes leave this tab.</p>
    <div className="memory-results"><strong>EXPERIMENTAL POSITION PROBE</strong>{!probeEnabled ? <span>DISABLED FOR THIS ROM FINGERPRINT.</span> : !bridge ? <span>WAITING FOR MELONDS.</span> : probeError ? <span className="form-error">{probeError}</span> : probe ? <><code>BASE PTR 0x{hex(probe.base, 8)}</code><code>POS STRUCT 0x{hex(probe.position, 8)}</code><code>MAP {probe.map} • X {probe.x} • Y {probe.y} • Z {probe.z}</code><span>CANDIDATE B2W2 OFFSETS ONLY — MOVE ONE TILE AT A TIME TO VALIDATE.</span></> : <span>READING CANDIDATE POSITION DATA...</span>}</div>
    <div className="memory-inputs"><label>START ADDRESS <input value={addressText} onChange={event => setAddressText(event.target.value)} inputMode="text" spellCheck="false"/></label><label>LENGTH <input value={lengthText} onChange={event => setLengthText(event.target.value)} inputMode="numeric"/></label><PixelButton disabled={busy || !bridge} onClick={() => void capture()}>{busy ? 'CAPTURING...' : 'CAPTURE SNAPSHOT'}</PixelButton></div>
    <div className="memory-snapshots"><strong>SNAPSHOTS</strong>{snapshots.length ? snapshots.map((snapshot, index) => <span key={`${snapshot.capturedAt}-${index}`}>{option(index)} • 0x{hex(snapshot.address, 8)} • {snapshot.bytes.length} B • {date(snapshot.capturedAt)}</span>) : <span>NONE YET — CAPTURE A WHILE STANDING STILL.</span>}</div>
    <div className="memory-compare"><label>COMPARE <select value={first} onChange={event => setFirst(event.target.value)}>{snapshots.map((_, index) => <option key={option(index)}>{option(index)}</option>)}</select> VS <select value={second} onChange={event => setSecond(event.target.value)}>{snapshots.map((_, index) => <option key={option(index)}>{option(index)}</option>)}</select></label><PixelButton tone="ghost" disabled={snapshots.length < 2 || busy} onClick={compareSelected}>COMPARE</PixelButton><PixelButton tone="ghost" disabled={snapshots.length < 2 || busy} onClick={compareAll}>COMPARE ALL</PixelButton><PixelButton tone="ghost" disabled={!comparisons.length} onClick={copyResults}>COPY RESULTS</PixelButton><PixelButton tone="danger" disabled={!snapshots.length} onClick={() => { setSnapshots([]); setComparisons([]); setFirst('A'); setSecond('B'); setError(null) }}>CLEAR SNAPSHOTS</PixelButton></div>
    {error && <p className={error === 'RESULTS COPIED.' ? 'memory-ok' : 'form-error'}>{error}</p>}
    <div className="memory-results"><strong>RESULTS {comparisons.length ? `• ${comparisons.reduce((total, comparison) => total + comparison.changes.length, 0)} CHANGED BYTES` : ''}</strong>{visibleChanges.length ? visibleChanges.map(({ comparison, change }) => <code key={`${comparison}-${change.address}`}>{comparison} • 0x{hex(change.address, 8)} {hex(change.before)} → {hex(change.after)}</code>) : <span>COMPARE SNAPSHOTS TO LIST CHANGED ADDRESSES.</span>}{visibleChanges.length === 500 && <span>DISPLAY LIMITED TO 500 ROWS; COPY RESULTS INCLUDES THE FULL COMPARISON.</span>}</div>
  </section>
}
