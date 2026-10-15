import { useEffect, useMemo, useState } from 'react'
import { Arm9MemoryInspector, type Arm9ByteChange, type Arm9Snapshot } from '../core/emulator/melonds/Arm9MemoryInspector'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2ActorSystemProbe, type White2ActorHeapScan, type White2ActorSystemSnapshot } from '../multiplayer/games/White2ActorSystem'
import { PixelButton } from './PixelButton'

const MAX_LENGTH = 0x10000
const TESTED_WHITE2_SHA256 = '54bec4091ba3eb89f4e1ee4e2f3421005835804376a34e5e45f3157e1f55625a'
const WHITE2_BASE_POINTER = 0x02000024
const WHITE2_POSITION_OFFSET = 0x36780
const SCRATCH_ACTOR_SLOT = 11
const SCRATCH_TEST_OFFSET = 0xfc
const SCRATCH_TEST_MARKER = 0x50524b4e
const ACTOR_FACE_DIR_OFFSET = 0x18
const ACTOR_GPOS_OFFSET = 0x3c
const ACTOR_WPOS_OFFSET = 0x44
const PLAYER_FACE_TEST_MS = 1800
const FX32_ONE = 4096
const TILE_WORLD_UNITS = 16
const PLAYER_WPOS_TEST_DELTA = (TILE_WORLD_UNITS / 2) * FX32_ONE
const PLAYER_WPOS_TEST_MS = 1200
const PLAYER_WPOS_REAPPLY_MS = 40

type Comparison = { label: string; before: Arm9Snapshot; after: Arm9Snapshot; changes: Arm9ByteChange[] }
type PositionProbe = { base: number; position: number; map: number; x: number; y: number; z: number }

function snapshotLabel(index: number) { return index < 26 ? String.fromCharCode(65 + index) : `S${index + 1}` }
function parseHex(value: string) { const normalized = value.trim().replace(/^0x/i, ''); return /^[0-9a-f]+$/i.test(normalized) ? Number.parseInt(normalized, 16) : Number.NaN }
function hex(value: number, width = 2) { return value.toString(16).toUpperCase().padStart(width, '0') }
function date(value: number) { return new Date(value).toLocaleTimeString() }
function slots(values: number[]) { return values.length ? values.join(', ') : 'NONE' }

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
  const [actorProbe, setActorProbe] = useState<White2ActorSystemSnapshot | null>(null)
  const [actorProbeError, setActorProbeError] = useState<string | null>(null)
  const [actorHeapScan, setActorHeapScan] = useState<White2ActorHeapScan | null>(null)
  const [actorHeapScanError, setActorHeapScanError] = useState<string | null>(null)
  const [actorHeapScanBusy, setActorHeapScanBusy] = useState(false)
  const [scratchWriteBusy, setScratchWriteBusy] = useState(false)
  const [scratchWriteResult, setScratchWriteResult] = useState<string | null>(null)
  const [playerFaceBusy, setPlayerFaceBusy] = useState(false)
  const [playerFaceResult, setPlayerFaceResult] = useState<string | null>(null)
  const [playerWPosBusy, setPlayerWPosBusy] = useState(false)
  const [playerWPosResult, setPlayerWPosResult] = useState<string | null>(null)

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

  useEffect(() => {
    if (!bridge || !probeEnabled || !White2ActorSystemProbe.supportsRom(rom)) {
      setActorProbe(null)
      setActorProbeError(null)
      setActorHeapScan(null)
      setActorHeapScanError(null)
      setScratchWriteResult(null)
      setPlayerFaceResult(null)
      setPlayerWPosResult(null)
      return
    }
    const actorSystem = new White2ActorSystemProbe(bridge)
    let cancelled = false
    let reading = false
    async function refreshActors() {
      if (reading || cancelled) return
      reading = true
      try {
        const snapshot = await actorSystem.inspect()
        if (!cancelled) {
          setActorProbe(snapshot)
          setActorProbeError(null)
        }
      } catch (reason) {
        if (!cancelled) {
          setActorProbe(null)
          setActorProbeError(reason instanceof Error ? reason.message.toUpperCase() : 'ACTOR SYSTEM PROBE FAILED.')
        }
      } finally {
        reading = false
      }
    }
    void refreshActors()
    const timer = window.setInterval(() => void refreshActors(), 1000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [bridge, probeEnabled, rom])

  async function scanActorHeap() {
    if (!bridge || !probeEnabled || !White2ActorSystemProbe.supportsRom(rom)) return
    setActorHeapScanBusy(true)
    setActorHeapScanError(null)
    setScratchWriteResult(null)
    setPlayerFaceResult(null)
    setPlayerWPosResult(null)
    try {
      setActorHeapScan(await new White2ActorSystemProbe(bridge).scanHeap())
    } catch (reason) {
      setActorHeapScan(null)
      setActorHeapScanError(reason instanceof Error ? reason.message.toUpperCase() : 'ACTOR HEAP SCAN FAILED.')
    } finally {
      setActorHeapScanBusy(false)
    }
  }

  function copyActorHeapScan() {
    if (!actorHeapScan) return
    const lines = [
      `ACTOR SYSTEM 0x${hex(actorHeapScan.actorSystem, 8)} HEAP 0x${hex(actorHeapScan.actorHeap, 8)}`,
      `COUNT ${actorHeapScan.count}/${actorHeapScan.capacity}`,
      `PLAYER ${slots(actorHeapScan.playerSlots)}`,
      `ACTIVE ${slots(actorHeapScan.activeSlots)}`,
      `ZEROED ${slots(actorHeapScan.zeroedSlots)}`,
      `DETACHED ${slots(actorHeapScan.detachedSlots)}`,
      `SUSPICIOUS ${slots(actorHeapScan.suspiciousSlots)}`,
      '',
      ...actorHeapScan.entries.map(entry => `SLOT ${entry.index} ${entry.state.toUpperCase()} @0x${hex(entry.address, 8)} FLAGS 0x${hex(entry.flags, 8)} MOVE 0x${hex(entry.movementFlags, 8)} UID ${entry.uid} MODEL ${entry.modelId} ZONE ${entry.zoneId} X ${entry.x} Y ${entry.y} H ${entry.height} FACE ${entry.faceDir} TCB 0x${hex(entry.tcb, 8)} OWNER 0x${hex(entry.actorSystemBackptr, 8)} MOVEVT 0x${hex(entry.moveCodeVTable, 8)} SCENEVT 0x${hex(entry.sceneNodeVTable, 8)}`),
    ]
    void navigator.clipboard.writeText(lines.join('\n')).then(() => setActorHeapScanError('ACTOR HEAP SCAN COPIED.')).catch(() => setActorHeapScanError('COPY FAILED: BROWSER CLIPBOARD PERMISSION WAS DENIED.'))
  }

  async function testScratchActorWrite() {
    if (!bridge || !probeEnabled || !White2ActorSystemProbe.supportsRom(rom)) return
    setScratchWriteBusy(true)
    setScratchWriteResult(null)
    setPlayerFaceResult(null)
    setPlayerWPosResult(null)
    setActorHeapScanError(null)
    const wasRunning = bridge.status === 'running'
    let testAddress: number | null = null
    let originalValue: number | null = null
    try {
      if (wasRunning) await bridge.pause()
      const actorSystem = new White2ActorSystemProbe(bridge)
      const freshScan = await actorSystem.scanHeap()
      setActorHeapScan(freshScan)
      if (freshScan.suspiciousSlots.length) throw new Error('Scratch write blocked because suspicious actor slots are present.')
      const candidate = freshScan.entries.find(entry => entry.index === SCRATCH_ACTOR_SLOT)
      if (!candidate || candidate.state !== 'zeroed') throw new Error(`Scratch write blocked because slot ${SCRATCH_ACTOR_SLOT} is no longer zeroed.`)

      testAddress = candidate.address + SCRATCH_TEST_OFFSET
      originalValue = await bridge.read32(testAddress)
      if (originalValue !== 0) throw new Error(`Scratch write blocked because 0x${hex(testAddress, 8)} is not zero.`)

      await bridge.write32(testAddress, SCRATCH_TEST_MARKER)
      const readback = await bridge.read32(testAddress)
      if (readback !== SCRATCH_TEST_MARKER) throw new Error(`Write/readback mismatch at 0x${hex(testAddress, 8)}.`)

      await bridge.write32(testAddress, originalValue)
      const restored = await bridge.read32(testAddress)
      if (restored !== originalValue) throw new Error(`Restore verification failed at 0x${hex(testAddress, 8)}.`)

      setScratchWriteResult(`PASS • SLOT ${SCRATCH_ACTOR_SLOT} +0x${hex(SCRATCH_TEST_OFFSET)} • WROTE 0x${hex(SCRATCH_TEST_MARKER, 8)} • READ BACK • RESTORED 0x${hex(restored, 8)}`)
      setActorHeapScan(await actorSystem.scanHeap())
    } catch (reason) {
      if (testAddress !== null && originalValue !== null) {
        try { await bridge.write32(testAddress, originalValue) } catch { /* best-effort restore before reporting failure */ }
      }
      setScratchWriteResult(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • SCRATCH WRITE TEST FAILED.')
    } finally {
      if (wasRunning) await bridge.resume()
      setScratchWriteBusy(false)
    }
  }

  async function testPlayerFacingWrite() {
    if (!bridge || !probeEnabled || !White2ActorSystemProbe.supportsRom(rom)) return
    setPlayerFaceBusy(true)
    setPlayerFaceResult(null)
    setPlayerWPosResult(null)
    setActorHeapScanError(null)
    const wasRunning = bridge.status === 'running'
    let faceAddress: number | null = null
    let originalFace: number | null = null
    try {
      if (!wasRunning) throw new Error('Player facing test requires melonDS to be running.')
      await bridge.pause()
      const actorSystem = new White2ActorSystemProbe(bridge)
      const freshScan = await actorSystem.scanHeap()
      setActorHeapScan(freshScan)
      if (freshScan.suspiciousSlots.length) throw new Error('Player facing test blocked because suspicious actor slots are present.')
      const player = freshScan.playerActor
      if (!player) throw new Error('Player facing test blocked because the live player actor was not found.')

      faceAddress = player.address + ACTOR_FACE_DIR_OFFSET
      originalFace = await bridge.read16(faceAddress)
      if (originalFace > 3) throw new Error(`Player facing test blocked because face direction ${originalFace} is outside 0–3.`)
      const testFace = (originalFace + 2) & 0x3

      await bridge.write16(faceAddress, testFace)
      const readback = await bridge.read16(faceAddress)
      if (readback !== testFace) throw new Error(`Facing write/readback mismatch at 0x${hex(faceAddress, 8)}.`)

      await bridge.resume()
      await new Promise<void>(resolve => window.setTimeout(resolve, PLAYER_FACE_TEST_MS))
      await bridge.pause()

      await bridge.write16(faceAddress, originalFace)
      const restored = await bridge.read16(faceAddress)
      if (restored !== originalFace) throw new Error(`Facing restore verification failed at 0x${hex(faceAddress, 8)}.`)

      setPlayerFaceResult(`PASS • PLAYER SLOT ${player.index} FACE ${originalFace}→${testFace} FOR ${PLAYER_FACE_TEST_MS}MS→${restored} • NATIVE ACTOR FIELD RESTORED`)
      setActorHeapScan(await actorSystem.scanHeap())
    } catch (reason) {
      if (faceAddress !== null && originalFace !== null) {
        try {
          if (bridge.status === 'running') await bridge.pause()
          await bridge.write16(faceAddress, originalFace)
        } catch { /* best-effort restore before reporting failure */ }
      }
      setPlayerFaceResult(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • PLAYER FACING TEST FAILED.')
    } finally {
      if (wasRunning && bridge.status === 'paused') await bridge.resume()
      setPlayerFaceBusy(false)
    }
  }

  async function testPlayerWPosWrite() {
    if (!bridge || !probeEnabled || !White2ActorSystemProbe.supportsRom(rom)) return
    setPlayerWPosBusy(true)
    setPlayerWPosResult(null)
    setPlayerFaceResult(null)
    setActorHeapScanError(null)
    const wasRunning = bridge.status === 'running'
    let wPosXAddress: number | null = null
    let originalWPosX: number | null = null
    let reapplyTimer: number | null = null
    try {
      if (!wasRunning) throw new Error('Player WPos test requires melonDS to be running.')
      await bridge.pause()
      const actorSystem = new White2ActorSystemProbe(bridge)
      const freshScan = await actorSystem.scanHeap()
      setActorHeapScan(freshScan)
      if (freshScan.suspiciousSlots.length) throw new Error('Player WPos test blocked because suspicious actor slots are present.')
      const player = freshScan.playerActor
      if (!player) throw new Error('Player WPos test blocked because the live player actor was not found.')

      const gPosX = await bridge.read16(player.address + ACTOR_GPOS_OFFSET)
      if (gPosX !== player.x) throw new Error(`Player WPos test blocked because GPos X changed during setup (${gPosX} != ${player.x}).`)

      wPosXAddress = player.address + ACTOR_WPOS_OFFSET
      originalWPosX = await bridge.read32(wPosXAddress)
      const testWPosX = (originalWPosX + PLAYER_WPOS_TEST_DELTA) >>> 0

      await bridge.write32(wPosXAddress, testWPosX)
      const readback = await bridge.read32(wPosXAddress)
      if (readback !== testWPosX) throw new Error(`WPos write/readback mismatch at 0x${hex(wPosXAddress, 8)}.`)

      await bridge.resume()
      reapplyTimer = window.setInterval(() => {
        if (wPosXAddress !== null) void bridge.write32(wPosXAddress, testWPosX)
      }, PLAYER_WPOS_REAPPLY_MS)
      await new Promise<void>(resolve => window.setTimeout(resolve, PLAYER_WPOS_TEST_MS))
      window.clearInterval(reapplyTimer)
      reapplyTimer = null
      await bridge.pause()

      const observedWPosX = await bridge.read32(wPosXAddress)
      const observedGPosX = await bridge.read16(player.address + ACTOR_GPOS_OFFSET)
      await bridge.write32(wPosXAddress, originalWPosX)
      const restored = await bridge.read32(wPosXAddress)
      if (restored !== originalWPosX) throw new Error(`WPos restore verification failed at 0x${hex(wPosXAddress, 8)}.`)

      setPlayerWPosResult(`PASS • PLAYER SLOT ${player.index} WPOS.X 0x${hex(originalWPosX, 8)}→0x${hex(testWPosX, 8)} FOR ${PLAYER_WPOS_TEST_MS}MS→0x${hex(restored, 8)} • GPOS.X ${player.x}→${observedGPosX} • LAST WPOS 0x${hex(observedWPosX, 8)}`)
      setActorHeapScan(await actorSystem.scanHeap())
    } catch (reason) {
      if (reapplyTimer !== null) window.clearInterval(reapplyTimer)
      if (wPosXAddress !== null && originalWPosX !== null) {
        try {
          if (bridge.status === 'running') await bridge.pause()
          await bridge.write32(wPosXAddress, originalWPosX)
        } catch { /* best-effort restore before reporting failure */ }
      }
      setPlayerWPosResult(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • PLAYER WPOS TEST FAILED.')
    } finally {
      if (wasRunning && bridge.status === 'paused') await bridge.resume()
      setPlayerWPosBusy(false)
    }
  }

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
  const nonActiveActorEntries = actorHeapScan?.entries.filter(entry => entry.state !== 'active' && entry.state !== 'player') ?? []
  const scratchWriteReady = !!actorHeapScan && actorHeapScan.suspiciousSlots.length === 0 && actorHeapScan.zeroedSlots.includes(SCRATCH_ACTOR_SLOT)
  const playerFaceReady = !!actorHeapScan && actorHeapScan.suspiciousSlots.length === 0 && actorHeapScan.playerSlots.length === 1
  const playerWPosReady = playerFaceReady
  const actorResearchBusy = actorHeapScanBusy || scratchWriteBusy || playerFaceBusy || playerWPosBusy

  return <section className="white2-memory-research pixel-border"><h2>WHITE 2 ARM9 MEMORY RESEARCH</h2><p>Reads the emulated ARM9 bus, not the WASM heap. Capture only controlled, bounded ranges; no bytes leave this tab.</p>
    <div className="memory-results"><strong>EXPERIMENTAL POSITION PROBE</strong>{!probeEnabled ? <span>DISABLED FOR THIS ROM FINGERPRINT.</span> : !bridge ? <span>WAITING FOR MELONDS.</span> : probeError ? <span className="form-error">{probeError}</span> : probe ? <><code>BASE PTR 0x{hex(probe.base, 8)}</code><code>POS STRUCT 0x{hex(probe.position, 8)}</code><code>MAP {probe.map} • X {probe.x} • Y {probe.y} • Z {probe.z}</code><span>VALIDATED POSITION STRUCT FOR THE TESTED WHITE 2 FINGERPRINT.</span></> : <span>READING POSITION DATA...</span>}</div>
    <div className="memory-results"><strong>FIELD ACTOR SYSTEM PROBE</strong>{!probeEnabled ? <span>DISABLED FOR THIS ROM FINGERPRINT.</span> : !bridge ? <span>WAITING FOR MELONDS.</span> : actorProbeError ? <span className="form-error">{actorProbeError}</span> : actorProbe ? <><code>GSYS 0x{hex(actorProbe.gameSystem, 8)} • GAME DATA 0x{hex(actorProbe.gameData, 8)}</code><code>ACTOR SYSTEM 0x{hex(actorProbe.actorSystem, 8)} • HEAP 0x{hex(actorProbe.actorHeap, 8)}</code><code>ACTORS {actorProbe.count}/{actorProbe.capacity}</code>{actorProbe.playerActor ? <code>PLAYER SLOT {actorProbe.playerActor.index} • 0x{hex(actorProbe.playerActor.address, 8)} • MODEL {actorProbe.playerActor.modelId} • ZONE {actorProbe.playerActor.zoneId} • X {actorProbe.playerActor.x} Y {actorProbe.playerActor.y} H {actorProbe.playerActor.height} • FACE {actorProbe.playerActor.faceDir}</code> : <span>ACTOR HEAP FOUND; PLAYER UID 0xFF NOT FOUND.</span>}<span>CONTROLLED WRITE TESTS ARE LIMITED TO THE EXACT TESTED WHITE 2 FINGERPRINT AND ALWAYS RESTORE THE ORIGINAL VALUE.</span></> : <span>READING FIELD ACTOR SYSTEM...</span>}
      <div className="memory-compare"><PixelButton tone="ghost" disabled={!bridge || !probeEnabled || actorResearchBusy} onClick={() => void scanActorHeap()}>{actorHeapScanBusy ? 'SCANNING 64 SLOTS...' : 'SCAN ACTOR HEAP'}</PixelButton><PixelButton tone="ghost" disabled={!actorHeapScan || actorResearchBusy} onClick={copyActorHeapScan}>COPY HEAP SCAN</PixelButton><PixelButton tone="danger" disabled={!scratchWriteReady || actorResearchBusy} onClick={() => void testScratchActorWrite()}>{scratchWriteBusy ? 'TESTING + RESTORING...' : 'TEST SLOT 11 WRITE + RESTORE'}</PixelButton><PixelButton tone="danger" disabled={!playerFaceReady || actorResearchBusy} onClick={() => void testPlayerFacingWrite()}>{playerFaceBusy ? 'TURNING + RESTORING...' : 'TURN PLAYER 1.8S + RESTORE'}</PixelButton><PixelButton tone="danger" disabled={!playerWPosReady || actorResearchBusy} onClick={() => void testPlayerWPosWrite()}>{playerWPosBusy ? 'SHIFTING + RESTORING...' : 'SHIFT PLAYER 1/2 TILE 1.2S + RESTORE'}</PixelButton></div>
      {actorHeapScanError && <span className={actorHeapScanError === 'ACTOR HEAP SCAN COPIED.' ? 'memory-ok' : 'form-error'}>{actorHeapScanError}</span>}
      {scratchWriteResult && <span className={scratchWriteResult.startsWith('PASS') ? 'memory-ok' : 'form-error'}>{scratchWriteResult}</span>}
      {playerFaceResult && <span className={playerFaceResult.startsWith('PASS') ? 'memory-ok' : 'form-error'}>{playerFaceResult}</span>}
      {playerWPosResult && <span className={playerWPosResult.startsWith('PASS') ? 'memory-ok' : 'form-error'}>{playerWPosResult}</span>}
      {actorHeapScan && <><code>INVENTORY • PLAYER {actorHeapScan.playerSlots.length} • ACTIVE {actorHeapScan.activeSlots.length} • ZEROED {actorHeapScan.zeroedSlots.length} • DETACHED {actorHeapScan.detachedSlots.length} • SUSPICIOUS {actorHeapScan.suspiciousSlots.length}</code><code>ZEROED CANDIDATES: {slots(actorHeapScan.zeroedSlots)}</code><code>DETACHED SLOTS: {slots(actorHeapScan.detachedSlots)}</code><code>SUSPICIOUS SLOTS: {slots(actorHeapScan.suspiciousSlots)}</code>{nonActiveActorEntries.map(entry => <code key={entry.index}>SLOT {entry.index} • {entry.state.toUpperCase()} • UID {entry.uid} MODEL {entry.modelId} • X {entry.x} Y {entry.y} H {entry.height} • TCB 0x{hex(entry.tcb, 8)} • OWNER 0x{hex(entry.actorSystemBackptr, 8)}</code>)}<span>ZEROED MEANS ALL CHECKED IDENTITY/RUNTIME FIELDS WERE ZERO. SLOT 11 TESTS RAW WRITE/READBACK/RESTORE WHILE PAUSED. PLAYER-FACING TEMPORARILY FLIPS FIELD ACTOR +0x18. PLAYER WPOS TEMPORARILY OFFSETS ONLY FIELD ACTOR +0x44 BY HALF A TILE IN FX32, REAPPLIES THE OFFSET WHILE THE GAME RUNS, THEN RESTORES THE ORIGINAL WORLD X POSITION; GPOS IS LEFT UNTOUCHED.</span></>}
    </div>
    <div className="memory-inputs"><label>START ADDRESS <input value={addressText} onChange={event => setAddressText(event.target.value)} inputMode="text" spellCheck="false"/></label><label>LENGTH <input value={lengthText} onChange={event => setLengthText(event.target.value)} inputMode="numeric"/></label><PixelButton disabled={busy || !bridge} onClick={() => void capture()}>{busy ? 'CAPTURING...' : 'CAPTURE SNAPSHOT'}</PixelButton></div>
    <div className="memory-snapshots"><strong>SNAPSHOTS</strong>{snapshots.length ? snapshots.map((snapshot, index) => <span key={`${snapshot.capturedAt}-${index}`}>{option(index)} • 0x{hex(snapshot.address, 8)} • {snapshot.bytes.length} B • {date(snapshot.capturedAt)}</span>) : <span>NONE YET — CAPTURE A WHILE STANDING STILL.</span>}</div>
    <div className="memory-compare"><label>COMPARE <select value={first} onChange={event => setFirst(event.target.value)}>{snapshots.map((_, index) => <option key={option(index)}>{option(index)}</option>)}</select> VS <select value={second} onChange={event => setSecond(event.target.value)}>{snapshots.map((_, index) => <option key={option(index)}>{option(index)}</option>)}</select></label><PixelButton tone="ghost" disabled={snapshots.length < 2 || busy} onClick={compareSelected}>COMPARE</PixelButton><PixelButton tone="ghost" disabled={snapshots.length < 2 || busy} onClick={compareAll}>COMPARE ALL</PixelButton><PixelButton tone="ghost" disabled={!comparisons.length} onClick={copyResults}>COPY RESULTS</PixelButton><PixelButton tone="danger" disabled={!snapshots.length} onClick={() => { setSnapshots([]); setComparisons([]); setFirst('A'); setSecond('B'); setError(null) }}>CLEAR SNAPSHOTS</PixelButton></div>
    {error && <p className={error === 'RESULTS COPIED.' ? 'memory-ok' : 'form-error'}>{error}</p>}
    <div className="memory-results"><strong>RESULTS {comparisons.length ? `• ${comparisons.reduce((total, comparison) => total + comparison.changes.length, 0)} CHANGED BYTES` : ''}</strong>{visibleChanges.length ? visibleChanges.map(({ comparison, change }) => <code key={`${comparison}-${change.address}`}>{comparison} • 0x{hex(change.address, 8)} {hex(change.before)} → {hex(change.after)}</code>) : <span>COMPARE SNAPSHOTS TO LIST CHANGED ADDRESSES.</span>}{visibleChanges.length === 500 && <span>DISPLAY LIMITED TO 500 ROWS; COPY RESULTS INCLUDES THE FULL COMPARISON.</span>}</div>
  </section>
}
