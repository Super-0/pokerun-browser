import { useEffect, useRef, useState } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../multiplayer/core/MultiplayerPresence'
import type { MultiplayerPlayerState, MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2ActorSystemProbe, type White2ActorHeapEntry } from '../multiplayer/games/White2ActorSystem'
import { PixelButton } from './PixelButton'

const ACTOR_SYSTEM_FIELD_BLACT = 0x28
const ACTOR_UID = 0x08
const ACTOR_MODEL_ID = 0x0c
const ACTOR_FACE_DIR = 0x18
const ACTOR_WPOS = 0x44
const ACTOR_TCB = 0x84

const FIELD_BLACT_SYSTEM = 0x04
const BLACT_SYSTEM_SCENE = 0x04
const BLACT_SYSTEM_ACTOR_HANDLES = 0x18
const BLACT_SYSTEM_ACTOR_COUNT = 0x1c
const BLACT_SCENE_ACTORS = 0x08
const BLACT_SCENE_CONFIG_ACTOR_COUNT = 0x0e

const BLACT_SIZE = 0x1c
const BLACT_GEOM_FLAGS = 0x00
const BLACT_POSITION = 0x04
const BLACT_FACE_INDEX = 0x10
const BLACT_MAT_FLAGS = 0x18

const HANDLE_SIZE = 0x28
const HANDLE_BLACT_INDEX = 0x00
const HANDLE_MAT_ENTRY = 0x04

const STANDARD_NPC_SCENE_VTABLE = 0x021cf92c
const SPECIAL_PLAYER_COMPANION_UID = 0x00fe
const PLAYER_UID = 0x00ff
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000
const TILE_FX32 = 16 * 4096
const STATIC_TEST_MS = 1500
const PROXY_TEST_MS = 10_000
const UPDATE_MS = 50
const MOVING_HOLD_MS = 350
const MAX_REMOTE_DX = 7
const MAX_REMOTE_DY = 5
const WALK_CYCLE = [0, 1, 2, 1] as const

const FIELD_FACE_BY_DIRECTION = { north: 0, south: 1, west: 2, east: 3 } as const
const TRAINER_FACE_BASE = { north: 0, south: 3, west: 6, east: 9 } as const

type Binding = {
  actor: White2ActorHeapEntry
  blActIndex: number
  blActAddress: number
  handleIndex: number
  handleAddress: number
}

type ActorPose = {
  faceDir: number
  wposX: number
  wposY: number
  wposZ: number
}

type RenderState = {
  matEntry: number
  geomFlags: number
  faceIndex: number
  matFlags: number
}

type OriginalState = {
  pose: ActorPose
  render: RenderState
  uid: number
  modelId: number
  tcb: number
}

function hex(value: number, width = 8) {
  return (value >>> 0).toString(16).toUpperCase().padStart(width, '0')
}

function signed32(value: number) {
  return value | 0
}

function delay(ms: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms))
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 0x3) === 0
}

function chooseStandardNpc(entries: White2ActorHeapEntry[], player: White2ActorHeapEntry) {
  return entries
    .filter(entry => entry.state === 'active' && entry.uid !== SPECIAL_PLAYER_COMPANION_UID && entry.sceneNodeVTable === STANDARD_NPC_SCENE_VTABLE)
    .sort((a, b) => (Math.abs(a.x - player.x) + Math.abs(a.y - player.y)) - (Math.abs(b.x - player.x) + Math.abs(b.y - player.y)))[0]
}

function trainerFace(direction: MultiplayerPlayerState['direction'], moving: boolean, walkTick: number) {
  const base = TRAINER_FACE_BASE[direction]
  return moving ? base + WALK_CYCLE[walkTick % WALK_CYCLE.length] : base + 1
}

export function White2TrainerRenderIsolationProbe({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const [busy, setBusy] = useState<'static' | 'proxy' | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [presence, setPresence] = useState<MultiplayerPresenceSnapshot>({ local: null, remote: null })
  const presenceRef = useRef<MultiplayerPresenceSnapshot>(presence)
  const supported = White2ActorSystemProbe.supportsRom(rom)

  useEffect(() => multiplayerPresence.subscribe(snapshot => {
    presenceRef.current = snapshot
    setPresence(snapshot)
  }), [])

  async function resolveBinding(entry: White2ActorHeapEntry, sceneActors: number, actorCount: number, actorHandles: number, handleCount: number): Promise<Binding> {
    if (!bridge) throw new Error('melonDS bridge is unavailable.')
    const [wposX, wposY, wposZ] = await Promise.all([
      bridge.read32(entry.address + ACTOR_WPOS + 0x00),
      bridge.read32(entry.address + ACTOR_WPOS + 0x04),
      bridge.read32(entry.address + ACTOR_WPOS + 0x08),
    ])

    let blActIndex = -1
    let blActAddress = 0
    let bestDistance = Number.POSITIVE_INFINITY
    for (let index = 0; index < actorCount; index += 1) {
      const address = sceneActors + index * BLACT_SIZE
      const [x, y, z] = await Promise.all([
        bridge.read32(address + BLACT_POSITION + 0x00),
        bridge.read32(address + BLACT_POSITION + 0x04),
        bridge.read32(address + BLACT_POSITION + 0x08),
      ])
      const distance = Math.abs(signed32(x) - signed32(wposX)) + Math.abs(signed32(y) - signed32(wposY)) + Math.abs(signed32(z) - signed32(wposZ))
      if (distance < bestDistance) {
        bestDistance = distance
        blActIndex = index
        blActAddress = address
      }
    }
    if (blActIndex < 0) throw new Error(`Could not resolve billboard actor for slot ${entry.index}.`)

    const matches: Array<{ index: number; address: number }> = []
    for (let index = 0; index < handleCount; index += 1) {
      const address = actorHandles + index * HANDLE_SIZE
      if ((await bridge.read32(address + HANDLE_BLACT_INDEX)) === blActIndex) matches.push({ index, address })
    }
    if (matches.length !== 1) throw new Error(`Expected one billboard handle for BlAct ${blActIndex}, found ${matches.length}.`)

    return { actor: entry, blActIndex, blActAddress, handleIndex: matches[0].index, handleAddress: matches[0].address }
  }

  async function capturePose(binding: Binding): Promise<ActorPose> {
    if (!bridge) throw new Error('melonDS bridge is unavailable.')
    const [faceDir, wposX, wposY, wposZ] = await Promise.all([
      bridge.read16(binding.actor.address + ACTOR_FACE_DIR),
      bridge.read32(binding.actor.address + ACTOR_WPOS + 0x00),
      bridge.read32(binding.actor.address + ACTOR_WPOS + 0x04),
      bridge.read32(binding.actor.address + ACTOR_WPOS + 0x08),
    ])
    return { faceDir, wposX, wposY, wposZ }
  }

  async function captureRender(binding: Binding): Promise<RenderState> {
    if (!bridge) throw new Error('melonDS bridge is unavailable.')
    const [matEntry, geomFlags, faceIndex, matFlags] = await Promise.all([
      bridge.read16(binding.handleAddress + HANDLE_MAT_ENTRY),
      bridge.read16(binding.blActAddress + BLACT_GEOM_FLAGS),
      bridge.read16(binding.blActAddress + BLACT_FACE_INDEX),
      bridge.read16(binding.blActAddress + BLACT_MAT_FLAGS),
    ])
    return { matEntry, geomFlags, faceIndex, matFlags }
  }

  async function identityMatches(binding: Binding, original: OriginalState) {
    if (!bridge) return false
    const [uid, modelId, tcb, owner] = await Promise.all([
      bridge.read16(binding.actor.address + ACTOR_UID),
      bridge.read16(binding.actor.address + ACTOR_MODEL_ID),
      bridge.read32(binding.actor.address + ACTOR_TCB),
      bridge.read32(binding.handleAddress + HANDLE_BLACT_INDEX),
    ])
    return uid === original.uid && modelId === original.modelId && tcb === original.tcb && owner === binding.blActIndex
  }

  async function restore(binding: Binding, original: OriginalState) {
    if (!bridge) return false
    if (!(await identityMatches(binding, original))) return false
    await Promise.all([
      bridge.write16(binding.actor.address + ACTOR_FACE_DIR, original.pose.faceDir),
      bridge.write32(binding.actor.address + ACTOR_WPOS + 0x00, original.pose.wposX),
      bridge.write32(binding.actor.address + ACTOR_WPOS + 0x04, original.pose.wposY),
      bridge.write32(binding.actor.address + ACTOR_WPOS + 0x08, original.pose.wposZ),
      bridge.write16(binding.handleAddress + HANDLE_MAT_ENTRY, original.render.matEntry),
      bridge.write16(binding.blActAddress + BLACT_GEOM_FLAGS, original.render.geomFlags),
      bridge.write16(binding.blActAddress + BLACT_FACE_INDEX, original.render.faceIndex),
      bridge.write16(binding.blActAddress + BLACT_MAT_FLAGS, original.render.matFlags),
    ])
    const restored = await captureRender(binding)
    return restored.matEntry === original.render.matEntry && restored.geomFlags === original.render.geomFlags && restored.faceIndex === original.render.faceIndex && restored.matFlags === original.render.matFlags
  }

  async function prepare() {
    if (!bridge) throw new Error('melonDS bridge is unavailable.')
    const scan = await new White2ActorSystemProbe(bridge).scanHeap()
    if (scan.suspiciousSlots.length) throw new Error('Trainer render test blocked because suspicious actor slots are present.')
    const player = scan.entries.find(entry => entry.state === 'player')
    if (!player || player.uid !== PLAYER_UID) throw new Error('Live player actor was not found.')
    const npc = chooseStandardNpc(scan.entries, player)
    if (!npc) throw new Error('No standard live NPC is available on this map.')

    const fieldBlAct = await bridge.read32(scan.actorSystem + ACTOR_SYSTEM_FIELD_BLACT)
    if (!isMainRamPointer(fieldBlAct)) throw new Error(`FieldBlAct pointer is invalid (0x${hex(fieldBlAct)}).`)
    const blActSystem = await bridge.read32(fieldBlAct + FIELD_BLACT_SYSTEM)
    if (!isMainRamPointer(blActSystem)) throw new Error(`BlActSystem pointer is invalid (0x${hex(blActSystem)}).`)
    const [scene, actorHandles, handleCount] = await Promise.all([
      bridge.read32(blActSystem + BLACT_SYSTEM_SCENE),
      bridge.read32(blActSystem + BLACT_SYSTEM_ACTOR_HANDLES),
      bridge.read16(blActSystem + BLACT_SYSTEM_ACTOR_COUNT),
    ])
    if (!isMainRamPointer(scene) || !isMainRamPointer(actorHandles)) throw new Error('Billboard scene/handle pointers are invalid.')
    const [sceneActors, actorCount] = await Promise.all([
      bridge.read32(scene + BLACT_SCENE_ACTORS),
      bridge.read16(scene + BLACT_SCENE_CONFIG_ACTOR_COUNT),
    ])
    if (!isMainRamPointer(sceneActors)) throw new Error('Billboard actor array pointer is invalid.')

    const [playerBinding, npcBinding] = await Promise.all([
      resolveBinding(player, sceneActors, actorCount, actorHandles, handleCount),
      resolveBinding(npc, sceneActors, actorCount, actorHandles, handleCount),
    ])
    const [playerRender, npcRender, npcPose] = await Promise.all([
      captureRender(playerBinding),
      captureRender(npcBinding),
      capturePose(npcBinding),
    ])
    const original: OriginalState = { pose: npcPose, render: npcRender, uid: npc.uid, modelId: npc.modelId, tcb: npc.tcb }
    return { playerBinding, npcBinding, playerRender, original }
  }

  async function runStatic() {
    if (!bridge || !supported) return
    setBusy('static')
    setResult(null)
    const wasRunning = bridge.status === 'running'
    let npcBinding: Binding | null = null
    let original: OriginalState | null = null
    try {
      if (!wasRunning) throw new Error('Static render isolation test requires melonDS to be running.')
      await bridge.pause()
      const prepared = await prepare()
      npcBinding = prepared.npcBinding
      original = prepared.original
      const target = prepared.playerRender

      await Promise.all([
        bridge.write16(npcBinding.handleAddress + HANDLE_MAT_ENTRY, target.matEntry),
        bridge.write16(npcBinding.blActAddress + BLACT_GEOM_FLAGS, target.geomFlags),
        bridge.write16(npcBinding.blActAddress + BLACT_FACE_INDEX, target.faceIndex),
        bridge.write16(npcBinding.blActAddress + BLACT_MAT_FLAGS, target.matFlags),
      ])

      await bridge.resume()
      const deadline = Date.now() + STATIC_TEST_MS
      while (Date.now() < deadline) {
        if (!(await identityMatches(npcBinding, original))) throw new Error('Borrowed NPC changed identity during the static render test.')
        await Promise.all([
          bridge.write16(npcBinding.handleAddress + HANDLE_MAT_ENTRY, target.matEntry),
          bridge.write16(npcBinding.blActAddress + BLACT_GEOM_FLAGS, target.geomFlags),
          bridge.write16(npcBinding.blActAddress + BLACT_FACE_INDEX, target.faceIndex),
          bridge.write16(npcBinding.blActAddress + BLACT_MAT_FLAGS, target.matFlags),
        ])
        await delay(UPDATE_MS)
      }
      await bridge.pause()
      const restored = await restore(npcBinding, original)
      if (!restored) throw new Error('Original NPC render state could not be verified after restoration.')
      setResult(`PASS • SHARED RENDER STATE ONLY • NPC SLOT ${npcBinding.actor.index} / BLACT ${npcBinding.blActIndex} • MAT ${target.matEntry} • GEOM 0x${hex(target.geomFlags, 4)} • MATFLAGS 0x${hex(target.matFlags, 4)} • FACE ${target.faceIndex} • +08/+0C UNTOUCHED • ORIGINAL NPC STATE RESTORED`)
    } catch (reason) {
      if (npcBinding && original) {
        try {
          if (bridge.status === 'running') await bridge.pause()
          await restore(npcBinding, original)
        } catch { /* guarded best-effort restore */ }
      }
      setResult(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • STATIC RENDER ISOLATION TEST FAILED.')
    } finally {
      if (wasRunning && bridge.status === 'paused') await bridge.resume()
      setBusy(null)
    }
  }

  async function runProxy() {
    if (!bridge || !supported) return
    setBusy('proxy')
    setResult(null)
    const wasRunning = bridge.status === 'running'
    let npcBinding: Binding | null = null
    let original: OriginalState | null = null
    try {
      if (!wasRunning) throw new Error('Remote proxy v2 requires melonDS to be running.')
      const startPresence = presenceRef.current
      if (!startPresence.local || !startPresence.remote) throw new Error('Two live multiplayer player states are required.')
      if (startPresence.local.location.mapId !== startPresence.remote.location.mapId) throw new Error('Both players must be on the same map.')
      const startMap = startPresence.local.location.mapId

      await bridge.pause()
      const prepared = await prepare()
      npcBinding = prepared.npcBinding
      original = prepared.original
      const playerBinding = prepared.playerBinding
      const playerRender = prepared.playerRender
      await bridge.resume()

      const deadline = Date.now() + PROXY_TEST_MS
      let updates = 0
      let walkTick = 0
      let movingUntil = 0
      let previousRemoteX = startPresence.remote.x
      let previousRemoteY = startPresence.remote.y
      let lastDx = 0
      let lastDy = 0
      let lastFrame = trainerFace(startPresence.remote.direction, false, 0)

      while (Date.now() < deadline) {
        const current = presenceRef.current
        if (!current.local || !current.remote) throw new Error('Remote player state disappeared while the proxy was active.')
        if (current.local.location.mapId !== startMap || current.remote.location.mapId !== startMap) throw new Error('Map changed while the proxy was active.')
        if (!(await identityMatches(npcBinding, original))) throw new Error('Borrowed NPC changed identity while the proxy was active.')

        const dx = current.remote.x - current.local.x
        const dy = current.remote.y - current.local.y
        if (Math.abs(dx) > MAX_REMOTE_DX || Math.abs(dy) > MAX_REMOTE_DY) throw new Error(`Remote player moved outside the proxy window (${dx}, ${dy}).`)

        if (current.remote.x !== previousRemoteX || current.remote.y !== previousRemoteY) {
          previousRemoteX = current.remote.x
          previousRemoteY = current.remote.y
          movingUntil = Date.now() + MOVING_HOLD_MS
          walkTick += 1
        }
        const moving = Date.now() < movingUntil
        const frame = trainerFace(current.remote.direction, moving, walkTick)
        const fieldFace = FIELD_FACE_BY_DIRECTION[current.remote.direction]
        const [playerWPosX, playerWPosY, playerWPosZ] = await Promise.all([
          bridge.read32(playerBinding.actor.address + ACTOR_WPOS + 0x00),
          bridge.read32(playerBinding.actor.address + ACTOR_WPOS + 0x04),
          bridge.read32(playerBinding.actor.address + ACTOR_WPOS + 0x08),
        ])
        const targetX = (playerWPosX + dx * TILE_FX32) >>> 0
        const targetY = playerWPosY >>> 0
        const targetZ = (playerWPosZ + dy * TILE_FX32) >>> 0

        await Promise.all([
          bridge.write16(npcBinding.actor.address + ACTOR_FACE_DIR, fieldFace),
          bridge.write32(npcBinding.actor.address + ACTOR_WPOS + 0x00, targetX),
          bridge.write32(npcBinding.actor.address + ACTOR_WPOS + 0x04, targetY),
          bridge.write32(npcBinding.actor.address + ACTOR_WPOS + 0x08, targetZ),
          bridge.write16(npcBinding.handleAddress + HANDLE_MAT_ENTRY, playerRender.matEntry),
          bridge.write16(npcBinding.blActAddress + BLACT_GEOM_FLAGS, playerRender.geomFlags),
          bridge.write16(npcBinding.blActAddress + BLACT_FACE_INDEX, frame),
          bridge.write16(npcBinding.blActAddress + BLACT_MAT_FLAGS, playerRender.matFlags),
        ])

        updates += 1
        lastDx = dx
        lastDy = dy
        lastFrame = frame
        await delay(UPDATE_MS)
      }

      await bridge.pause()
      const restored = await restore(npcBinding, original)
      if (!restored) throw new Error('Original NPC pose/render state could not be verified after restoration.')
      setResult(`PASS • REMOTE TRAINER PROXY V2 • NPC SLOT ${npcBinding.actor.index} / BLACT ${npcBinding.blActIndex} • ${updates} UPDATES / ${PROXY_TEST_MS}MS • LAST Δ ${lastDx},${lastDy} • LAST FRAME ${lastFrame} • +08/+0C UNTOUCHED • ORIGINAL NPC STATE RESTORED`)
    } catch (reason) {
      if (npcBinding && original) {
        try {
          if (bridge.status === 'running') await bridge.pause()
          await restore(npcBinding, original)
        } catch { /* guarded best-effort restore */ }
      }
      setResult(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • REMOTE TRAINER PROXY V2 FAILED.')
    } finally {
      if (wasRunning && bridge.status === 'paused') await bridge.resume()
      setBusy(null)
    }
  }

  const remoteReady = !!presence.local && !!presence.remote && presence.local.location.mapId === presence.remote.location.mapId

  return <section className="white2-memory-research pixel-border">
    <h2>WHITE 2 TRAINER RENDER ISOLATION</h2>
    <p>Both +0x08 and +0x0C tests produced the protagonist, but both also copied the same player MatEntry, GeomFlags, MatFlags and FaceIdx. This isolates that shared render state first. The proxy v2 then drives multiplayer position/facing while deliberately leaving handle +0x08 and +0x0C untouched so the NPC controller cannot be replaced by the player's controller state.</p>
    <div className="memory-compare">
      <PixelButton tone="danger" disabled={!bridge || !supported || busy !== null} onClick={() => void runStatic()}>{busy === 'static' ? 'TESTING SHARED RENDER STATE...' : 'TEST SHARED RENDER STATE ONLY 1.5S'}</PixelButton>
      <PixelButton tone="danger" disabled={!bridge || !supported || !remoteReady || busy !== null} onClick={() => void runProxy()}>{busy === 'proxy' ? 'RUNNING REMOTE PROXY V2...' : 'RUN REMOTE PROXY V2 10S + RESTORE'}</PixelButton>
    </div>
    {!supported && <span className="form-error">DISABLED FOR THIS ROM FINGERPRINT.</span>}
    {presence.local && presence.remote ? <code>REMOTE LINK • LOCAL MAP {presence.local.location.mapId} X {presence.local.x} Y {presence.local.y} • REMOTE MAP {presence.remote.location.mapId} X {presence.remote.x} Y {presence.remote.y} {remoteReady ? '• SAME MAP' : '• DIFFERENT MAP'}</code> : <span>REMOTE PROXY V2 WAITING FOR BOTH PLAYER STATES.</span>}
    {result && <span className={result.startsWith('PASS') ? 'memory-ok' : 'form-error'}>{result}</span>}
    <span>FIRST RUN THE 1.5S SHARED-STATE TEST. IF IT ALONE SHOWS THE CORRECT PROTAGONIST, +0x08/+0x0C WERE NOT REQUIRED FOR APPEARANCE. THEN RUN PROXY V2 AND CHECK WHETHER REMOTE FACING/WALKING NOW TRACKS CORRECTLY.</span>
  </section>
}
