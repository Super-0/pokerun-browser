import { useEffect, useRef, useState } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../multiplayer/core/MultiplayerPresence'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2ActorSystemProbe, type White2ActorHeapEntry } from '../multiplayer/games/White2ActorSystem'
import { PixelButton } from './PixelButton'

const ACTOR_UID = 0x08
const ACTOR_MODEL_ID = 0x0c
const ACTOR_FACE_DIR = 0x18
const ACTOR_WPOS = 0x44
const ACTOR_TCB = 0x84
const STANDARD_NPC_SCENE_VTABLE = 0x021cf92c
const SPECIAL_PLAYER_COMPANION_UID = 0x00fe
const PLAYER_UID = 0x00ff
const FX32_ONE = 4096
const TILE_WORLD_UNITS = 16
const TILE_FX32 = FX32_ONE * TILE_WORLD_UNITS
const TEST_MS = 1500
const MODEL_TEST_MS = 1500
const REAPPLY_MS = 40
const REMOTE_TEST_MS = 8000
const REMOTE_REAPPLY_MS = 50
const MAX_REMOTE_DX = 7
const MAX_REMOTE_DY = 5
const DIR_LEFT = 2
const FACE_BY_DIRECTION = { north: 0, south: 1, west: 2, east: 3 } as const

type OriginalActorPose = {
  slot: number
  address: number
  uid: number
  modelId: number
  tcb: number
  face: number
  wposX: number
  wposY: number
  wposZ: number
}

function hex(value: number) {
  return value.toString(16).toUpperCase().padStart(8, '0')
}

function sameActor(entry: White2ActorHeapEntry | undefined, original: OriginalActorPose) {
  return !!entry && entry.state === 'active' && entry.uid === original.uid && entry.modelId === original.modelId && entry.tcb === original.tcb
}

function sameActorIgnoringModel(entry: White2ActorHeapEntry | undefined, original: OriginalActorPose) {
  return !!entry && entry.state === 'active' && entry.uid === original.uid && entry.tcb === original.tcb
}

function delay(ms: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms))
}

/**
 * DEV-only proof that PokéRun can drive a second, independent native FieldActor.
 *
 * The movement tests borrow a normal live NPC, change WPos + FaceDir, then restore
 * the exact original values. The model test separately changes only ModelID while
 * also moving that already-live NPC beside the player so the visual result is easy
 * to inspect. None of these tests create an actor or alter UID/GPos/TCB/scripts.
 */
export function White2NativeActorControlProbe({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const [busy, setBusy] = useState(false)
  const [modelBusy, setModelBusy] = useState(false)
  const [remoteBusy, setRemoteBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [modelResult, setModelResult] = useState<string | null>(null)
  const [remoteResult, setRemoteResult] = useState<string | null>(null)
  const [presence, setPresence] = useState<MultiplayerPresenceSnapshot>({ local: null, remote: null })
  const presenceRef = useRef<MultiplayerPresenceSnapshot>(presence)
  const supported = White2ActorSystemProbe.supportsRom(rom)

  useEffect(() => multiplayerPresence.subscribe(snapshot => {
    presenceRef.current = snapshot
    setPresence(snapshot)
  }), [])

  async function restorePose(original: OriginalActorPose) {
    if (!bridge) return false
    const scan = await new White2ActorSystemProbe(bridge).scanHeap()
    const entry = scan.entries[original.slot]
    if (!sameActor(entry, original)) return false
    await Promise.all([
      bridge.write16(original.address + ACTOR_FACE_DIR, original.face),
      bridge.write32(original.address + ACTOR_WPOS + 0x00, original.wposX),
      bridge.write32(original.address + ACTOR_WPOS + 0x04, original.wposY),
      bridge.write32(original.address + ACTOR_WPOS + 0x08, original.wposZ),
    ])
    return (await bridge.read16(original.address + ACTOR_FACE_DIR)) === original.face &&
      (await bridge.read32(original.address + ACTOR_WPOS + 0x00)) === original.wposX &&
      (await bridge.read32(original.address + ACTOR_WPOS + 0x04)) === original.wposY &&
      (await bridge.read32(original.address + ACTOR_WPOS + 0x08)) === original.wposZ
  }

  async function restoreModelAndPose(original: OriginalActorPose) {
    if (!bridge) return false
    const scan = await new White2ActorSystemProbe(bridge).scanHeap()
    const entry = scan.entries[original.slot]
    if (!sameActorIgnoringModel(entry, original)) return false
    await Promise.all([
      bridge.write16(original.address + ACTOR_MODEL_ID, original.modelId),
      bridge.write16(original.address + ACTOR_FACE_DIR, original.face),
      bridge.write32(original.address + ACTOR_WPOS + 0x00, original.wposX),
      bridge.write32(original.address + ACTOR_WPOS + 0x04, original.wposY),
      bridge.write32(original.address + ACTOR_WPOS + 0x08, original.wposZ),
    ])
    return (await bridge.read16(original.address + ACTOR_MODEL_ID)) === original.modelId &&
      (await bridge.read16(original.address + ACTOR_FACE_DIR)) === original.face &&
      (await bridge.read32(original.address + ACTOR_WPOS + 0x00)) === original.wposX &&
      (await bridge.read32(original.address + ACTOR_WPOS + 0x04)) === original.wposY &&
      (await bridge.read32(original.address + ACTOR_WPOS + 0x08)) === original.wposZ
  }

  async function identityStillMatches(entry: White2ActorHeapEntry) {
    if (!bridge) return false
    const [uid, modelId, tcb] = await Promise.all([
      bridge.read16(entry.address + ACTOR_UID),
      bridge.read16(entry.address + ACTOR_MODEL_ID),
      bridge.read32(entry.address + ACTOR_TCB),
    ])
    return uid === entry.uid && modelId === entry.modelId && tcb === entry.tcb
  }

  function chooseStandardNpc(entries: White2ActorHeapEntry[], player: White2ActorHeapEntry) {
    return entries
      .filter(entry => entry.state === 'active' && entry.uid !== SPECIAL_PLAYER_COMPANION_UID && entry.sceneNodeVTable === STANDARD_NPC_SCENE_VTABLE)
      .sort((a, b) => (Math.abs(a.x - player.x) + Math.abs(a.y - player.y)) - (Math.abs(b.x - player.x) + Math.abs(b.y - player.y)))[0]
  }

  async function runProbe() {
    if (!bridge || !supported) return
    setBusy(true)
    setResult(null)
    const wasRunning = bridge.status === 'running'
    let timer: number | null = null
    let original: OriginalActorPose | null = null

    try {
      if (!wasRunning) throw new Error('Native actor control test requires melonDS to be running.')
      await bridge.pause()

      const actorSystem = new White2ActorSystemProbe(bridge)
      const scan = await actorSystem.scanHeap()
      if (scan.suspiciousSlots.length) throw new Error('Native actor control test blocked because suspicious actor slots are present.')
      const player = scan.entries.find(entry => entry.state === 'player')
      if (!player) throw new Error('Native actor control test blocked because the player actor was not found.')

      const candidate = chooseStandardNpc(scan.entries, player)
      if (!candidate) throw new Error('No standard live NPC actor is available on this map. Try the MAP 428 room from the lifecycle trace.')

      const [face, wposX, wposY, wposZ, playerWPosX, playerWPosY, playerWPosZ] = await Promise.all([
        bridge.read16(candidate.address + ACTOR_FACE_DIR),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x00),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x04),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x08),
        bridge.read32(player.address + ACTOR_WPOS + 0x00),
        bridge.read32(player.address + ACTOR_WPOS + 0x04),
        bridge.read32(player.address + ACTOR_WPOS + 0x08),
      ])

      original = { slot: candidate.index, address: candidate.address, uid: candidate.uid, modelId: candidate.modelId, tcb: candidate.tcb, face, wposX, wposY, wposZ }
      const targetX = (playerWPosX + TILE_FX32) >>> 0
      const targetY = playerWPosY >>> 0
      const targetZ = playerWPosZ >>> 0

      const applyTarget = async () => {
        await Promise.all([
          bridge.write16(candidate.address + ACTOR_FACE_DIR, DIR_LEFT),
          bridge.write32(candidate.address + ACTOR_WPOS + 0x00, targetX),
          bridge.write32(candidate.address + ACTOR_WPOS + 0x04, targetY),
          bridge.write32(candidate.address + ACTOR_WPOS + 0x08, targetZ),
        ])
      }

      await applyTarget()
      const initialReadback = await Promise.all([
        bridge.read16(candidate.address + ACTOR_FACE_DIR),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x00),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x04),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x08),
      ])
      if (initialReadback[0] !== DIR_LEFT || initialReadback[1] !== targetX || initialReadback[2] !== targetY || initialReadback[3] !== targetZ) {
        throw new Error('Native NPC WPos/facing write did not read back correctly.')
      }

      await bridge.resume()
      timer = window.setInterval(() => { void applyTarget() }, REAPPLY_MS)
      await delay(TEST_MS)
      window.clearInterval(timer)
      timer = null
      await bridge.pause()

      const afterScan = await actorSystem.scanHeap()
      const afterEntry = afterScan.entries[candidate.index]
      if (!sameActor(afterEntry, original)) throw new Error(`Slot ${candidate.index} changed identity while the native actor test was running; original pose was not written into the replacement actor.`)

      const observed = await Promise.all([
        bridge.read32(candidate.address + ACTOR_WPOS + 0x00),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x04),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x08),
      ])
      const restored = await restorePose(original)
      if (!restored) throw new Error(`Native NPC slot ${candidate.index} could not be verified after restoring its original pose.`)

      setResult(`PASS • NATIVE NPC SLOT ${candidate.index} • UID ${candidate.uid} • MODEL ${candidate.modelId} • MOVED BESIDE PLAYER FOR ${TEST_MS}MS • OBSERVED WPOS 0x${hex(observed[0])}/0x${hex(observed[1])}/0x${hex(observed[2])} • ORIGINAL POSE RESTORED`)
    } catch (reason) {
      if (timer !== null) window.clearInterval(timer)
      if (original) {
        try {
          if (bridge.status === 'running') await bridge.pause()
          await restorePose(original)
        } catch { /* best-effort restore; identity guard prevents touching a replacement actor */ }
      }
      setResult(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • NATIVE ACTOR CONTROL TEST FAILED.')
    } finally {
      if (wasRunning && bridge.status === 'paused') await bridge.resume()
      setBusy(false)
    }
  }

  async function runModelProbe() {
    if (!bridge || !supported) return
    setModelBusy(true)
    setModelResult(null)
    const wasRunning = bridge.status === 'running'
    let timer: number | null = null
    let original: OriginalActorPose | null = null

    try {
      if (!wasRunning) throw new Error('Native model test requires melonDS to be running.')
      await bridge.pause()

      const actorSystem = new White2ActorSystemProbe(bridge)
      const scan = await actorSystem.scanHeap()
      if (scan.suspiciousSlots.length) throw new Error('Native model test blocked because suspicious actor slots are present.')
      const player = scan.entries.find(entry => entry.state === 'player')
      if (!player || player.uid !== PLAYER_UID) throw new Error('Native model test blocked because the live player actor was not found.')
      const candidate = chooseStandardNpc(scan.entries, player)
      if (!candidate) throw new Error('No standard live NPC actor is available for the native model test on this map.')

      const [face, wposX, wposY, wposZ, playerWPosX, playerWPosY, playerWPosZ] = await Promise.all([
        bridge.read16(candidate.address + ACTOR_FACE_DIR),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x00),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x04),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x08),
        bridge.read32(player.address + ACTOR_WPOS + 0x00),
        bridge.read32(player.address + ACTOR_WPOS + 0x04),
        bridge.read32(player.address + ACTOR_WPOS + 0x08),
      ])
      original = { slot: candidate.index, address: candidate.address, uid: candidate.uid, modelId: candidate.modelId, tcb: candidate.tcb, face, wposX, wposY, wposZ }

      const targetX = (playerWPosX + TILE_FX32) >>> 0
      const targetY = playerWPosY >>> 0
      const targetZ = playerWPosZ >>> 0
      const targetModel = player.modelId

      const applyTarget = async () => {
        await Promise.all([
          bridge.write16(candidate.address + ACTOR_MODEL_ID, targetModel),
          bridge.write16(candidate.address + ACTOR_FACE_DIR, DIR_LEFT),
          bridge.write32(candidate.address + ACTOR_WPOS + 0x00, targetX),
          bridge.write32(candidate.address + ACTOR_WPOS + 0x04, targetY),
          bridge.write32(candidate.address + ACTOR_WPOS + 0x08, targetZ),
        ])
      }

      await applyTarget()
      const [modelReadback, uidReadback, tcbReadback] = await Promise.all([
        bridge.read16(candidate.address + ACTOR_MODEL_ID),
        bridge.read16(candidate.address + ACTOR_UID),
        bridge.read32(candidate.address + ACTOR_TCB),
      ])
      if (modelReadback !== targetModel || uidReadback !== candidate.uid || tcbReadback !== candidate.tcb) {
        throw new Error('Native model test write/readback or identity verification failed before resume.')
      }

      await bridge.resume()
      timer = window.setInterval(() => { void applyTarget() }, REAPPLY_MS)
      await delay(MODEL_TEST_MS)
      window.clearInterval(timer)
      timer = null
      await bridge.pause()

      const afterScan = await actorSystem.scanHeap()
      const afterEntry = afterScan.entries[candidate.index]
      if (!sameActorIgnoringModel(afterEntry, original)) throw new Error(`Slot ${candidate.index} changed UID/TCB while the native model test was running; stopping before restoring into a replacement actor.`)
      const observedModel = await bridge.read16(candidate.address + ACTOR_MODEL_ID)

      const restored = await restoreModelAndPose(original)
      if (!restored) throw new Error(`Native model test could not verify restoration of NPC slot ${candidate.index}.`)

      setModelResult(`PASS • NPC SLOT ${candidate.index} • UID ${candidate.uid} • MODEL FIELD ${candidate.modelId}→${targetModel} FOR ${MODEL_TEST_MS}MS→${candidate.modelId} • OBSERVED MODEL ${observedModel} • ORIGINAL MODEL + POSE RESTORED`)
    } catch (reason) {
      if (timer !== null) window.clearInterval(timer)
      if (original) {
        try {
          if (bridge.status === 'running') await bridge.pause()
          await restoreModelAndPose(original)
        } catch { /* best-effort restore with UID/TCB identity guard */ }
      }
      setModelResult(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • NATIVE MODEL TEST FAILED.')
    } finally {
      if (wasRunning && bridge.status === 'paused') await bridge.resume()
      setModelBusy(false)
    }
  }

  async function runRemoteDriveProbe() {
    if (!bridge || !supported) return
    setRemoteBusy(true)
    setRemoteResult(null)
    const wasRunning = bridge.status === 'running'
    let original: OriginalActorPose | null = null

    try {
      if (!wasRunning) throw new Error('Remote native actor test requires melonDS to be running.')
      const startPresence = presenceRef.current
      if (!startPresence.local || !startPresence.remote) throw new Error('Remote native actor test requires two live multiplayer player states.')
      if (startPresence.local.location.mapId !== startPresence.remote.location.mapId) throw new Error('Both players must be on the same map before starting the remote native actor test.')
      const startMap = startPresence.local.location.mapId

      await bridge.pause()
      const actorSystem = new White2ActorSystemProbe(bridge)
      const scan = await actorSystem.scanHeap()
      if (scan.suspiciousSlots.length) throw new Error('Remote native actor test blocked because suspicious actor slots are present.')
      const player = scan.entries.find(entry => entry.state === 'player')
      if (!player || player.uid !== PLAYER_UID) throw new Error('Remote native actor test blocked because the live player actor was not found.')
      const candidate = chooseStandardNpc(scan.entries, player)
      if (!candidate) throw new Error('No standard live NPC actor is available to use as the temporary remote-player proxy on this map.')

      const [face, wposX, wposY, wposZ] = await Promise.all([
        bridge.read16(candidate.address + ACTOR_FACE_DIR),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x00),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x04),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x08),
      ])
      original = { slot: candidate.index, address: candidate.address, uid: candidate.uid, modelId: candidate.modelId, tcb: candidate.tcb, face, wposX, wposY, wposZ }

      await bridge.resume()
      const deadline = Date.now() + REMOTE_TEST_MS
      let updates = 0
      let lastDx = 0
      let lastDy = 0
      let lastTargetX = 0
      let lastTargetZ = 0

      while (Date.now() < deadline) {
        const current = presenceRef.current
        if (!current.local || !current.remote) throw new Error('Remote player state disappeared while the native actor test was running.')
        if (current.local.location.mapId !== startMap || current.remote.location.mapId !== startMap) throw new Error('Map changed while the remote native actor test was running; stopping before touching a replacement actor.')

        const dx = current.remote.x - current.local.x
        const dy = current.remote.y - current.local.y
        if (Math.abs(dx) > MAX_REMOTE_DX || Math.abs(dy) > MAX_REMOTE_DY) throw new Error(`Remote player moved outside the native proxy test window (${dx}, ${dy}); keep both players within ${MAX_REMOTE_DX}x${MAX_REMOTE_DY} tiles.`)

        const [candidateMatches, playerMatches] = await Promise.all([
          identityStillMatches(candidate),
          identityStillMatches(player),
        ])
        if (!candidateMatches) throw new Error(`Native NPC slot ${candidate.index} changed identity during the remote test; no further writes were made.`)
        if (!playerMatches) throw new Error(`Player slot ${player.index} changed identity during the remote test; no further writes were made.`)

        const [playerWPosX, playerWPosY, playerWPosZ] = await Promise.all([
          bridge.read32(player.address + ACTOR_WPOS + 0x00),
          bridge.read32(player.address + ACTOR_WPOS + 0x04),
          bridge.read32(player.address + ACTOR_WPOS + 0x08),
        ])
        const targetX = (playerWPosX + dx * TILE_FX32) >>> 0
        const targetY = playerWPosY >>> 0
        const targetZ = (playerWPosZ + dy * TILE_FX32) >>> 0
        const face = FACE_BY_DIRECTION[current.remote.direction]

        await Promise.all([
          bridge.write16(candidate.address + ACTOR_FACE_DIR, face),
          bridge.write32(candidate.address + ACTOR_WPOS + 0x00, targetX),
          bridge.write32(candidate.address + ACTOR_WPOS + 0x04, targetY),
          bridge.write32(candidate.address + ACTOR_WPOS + 0x08, targetZ),
        ])

        updates += 1
        lastDx = dx
        lastDy = dy
        lastTargetX = targetX
        lastTargetZ = targetZ
        await delay(REMOTE_REAPPLY_MS)
      }

      await bridge.pause()
      const restored = await restorePose(original)
      if (!restored) throw new Error(`Remote proxy NPC slot ${candidate.index} could not be verified after restoring its original pose.`)

      setRemoteResult(`PASS • REMOTE→NATIVE NPC SLOT ${candidate.index} • UID ${candidate.uid} • MODEL ${candidate.modelId} • ${updates} UPDATES / ${REMOTE_TEST_MS}MS • LAST Δ ${lastDx},${lastDy} • TARGET X/Z 0x${hex(lastTargetX)}/0x${hex(lastTargetZ)} • ORIGINAL POSE RESTORED`)
    } catch (reason) {
      if (original) {
        try {
          if (bridge.status === 'running') await bridge.pause()
          await restorePose(original)
        } catch { /* best-effort restore; identity guard prevents touching a replacement actor */ }
      }
      setRemoteResult(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • REMOTE NATIVE ACTOR TEST FAILED.')
    } finally {
      if (wasRunning && bridge.status === 'paused') await bridge.resume()
      setRemoteBusy(false)
    }
  }

  const remoteReady = !!presence.local && !!presence.remote && presence.local.location.mapId === presence.remote.location.mapId
  const anyBusy = busy || modelBusy || remoteBusy

  return <section className="white2-memory-research pixel-border">
    <h2>WHITE 2 NATIVE SECOND-ACTOR CONTROL</h2>
    <p>Temporary native-actor proofs. Movement tests borrow an already-live standard NPC and change WPos + FaceDir. The model-field test temporarily writes the live player's ModelID into that NPC while moving it beside the player. Every test restores the original values; UID, GPos, collision, scripts and TCB are never changed.</p>
    <div className="memory-compare">
      <PixelButton tone="danger" disabled={!bridge || !supported || anyBusy} onClick={() => void runProbe()}>{busy ? 'MOVING NPC + RESTORING...' : 'MOVE NEAREST NPC BESIDE PLAYER 1.5S + RESTORE'}</PixelButton>
      <PixelButton tone="danger" disabled={!bridge || !supported || anyBusy} onClick={() => void runModelProbe()}>{modelBusy ? 'SWAPPING MODEL FIELD + RESTORING...' : 'TEST NPC MODEL→PLAYER 1.5S + RESTORE'}</PixelButton>
      <PixelButton tone="danger" disabled={!bridge || !supported || !remoteReady || anyBusy} onClick={() => void runRemoteDriveProbe()}>{remoteBusy ? 'DRIVING NATIVE NPC FROM REMOTE...' : 'DRIVE NPC FROM REMOTE 8S + RESTORE'}</PixelButton>
    </div>
    {!supported && <span className="form-error">DISABLED FOR THIS ROM FINGERPRINT.</span>}
    {presence.local && presence.remote ? <code>REMOTE LINK • LOCAL MAP {presence.local.location.mapId} X {presence.local.x} Y {presence.local.y} • REMOTE MAP {presence.remote.location.mapId} X {presence.remote.x} Y {presence.remote.y} {remoteReady ? '• SAME MAP' : '• DIFFERENT MAP'}</code> : <span>REMOTE NATIVE TEST WAITING FOR BOTH PLAYER STATES.</span>}
    {result && <span className={result.startsWith('PASS') ? 'memory-ok' : 'form-error'}>{result}</span>}
    {modelResult && <span className={modelResult.startsWith('PASS') ? 'memory-ok' : 'form-error'}>{modelResult}</span>}
    {remoteResult && <span className={remoteResult.startsWith('PASS') ? 'memory-ok' : 'form-error'}>{remoteResult}</span>}
    <span>MODEL TEST: WATCH THE NPC BESIDE YOU. IF IT VISIBLY BECOMES THE PLAYER TRAINER FOR 1.5S, THE LIVE RENDER OBJECT RESPONDS TO FIELD ACTOR MODELID. IF THE RESULT SAYS PASS BUT THE NPC'S APPEARANCE DOES NOT CHANGE, MODELID IS ONLY METADATA AFTER ACTOR CREATION AND WE NEED THE G3D/SCENE-NODE REBIND PATH.</span>
    <span>REMOTE TEST: PUT BOTH PLAYERS ON THE SAME MAP WITHIN 7 HORIZONTAL / 5 VERTICAL TILES. START THE 8-SECOND TEST IN ONE TAB, THEN MOVE THE OTHER PLAYER. THE BORROWED REAL NPC SHOULD FOLLOW THAT REMOTE PLAYER'S RELATIVE TILE POSITION AND FACING, THEN RETURN TO ITS ORIGINAL POSE.</span>
  </section>
}
