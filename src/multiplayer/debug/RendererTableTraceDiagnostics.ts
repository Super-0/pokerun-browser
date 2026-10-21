import { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import { POKERUN_NATIVE_TEST_UID } from '../games/White2NativeActor'
import { White2ActorSystemProbe } from '../games/White2ActorSystem'
import { multiplayerMovementTrace } from './MultiplayerMovementTrace'

type TraceData = Record<string, string | number | boolean | null>
type TraceApi = {
  isActive(): boolean
  record(stage: string, data: TraceData): void
  subscribe(listener: (snapshot: { active: boolean }) => void): () => void
}
type RendererWindow = Window & { __POKERUN_RENDERER_TABLE_TRACE_INSTALLED__?: boolean }
type WatchState = {
  busy: boolean
  lastSnapshotAt: number
  lastRangeClass: string
  lastActorAddress: number
  lastNativeBlActIndex: number
  lastHandleSignature: string
}

const trace = multiplayerMovementTrace as unknown as TraceApi
const rendererWindow = window as RendererWindow
const bridges = new Map<MelonDsBridge, WatchState>()
let latestPresence: MultiplayerPresenceSnapshot = { local: null, remote: null }
let timer: number | null = null

const SAMPLE_MS = 100
const PERIODIC_SNAPSHOT_MS = 750
const FX32_TILE = 0x10000
const NEARBY_RADIUS_FX32 = 4 * FX32_TILE

const ACTOR_UID = 0x08
const ACTOR_MODEL_ID = 0x0c
const ACTOR_FACE_DIR = 0x18
const ACTOR_GPOS = 0x3c
const ACTOR_WPOS = 0x44
const ACTOR_SYSTEM_BACKPTR = 0x88
const ACTOR_SCENE_NODE_VTABLE = 0x90
const SCENE_NODE_GET_BLACT_INDEX = 0x14
const ACTOR_SYSTEM_FIELD_BLACT = 0x28

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

const FLDACT_GET_BLACT_IDX = 0x02167240
const NATIVE_STACK_RESERVE = 0x400
const BLACT_NONE = 0xffff
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000

function record(stage: string, data: TraceData) {
  if (trace.isActive()) trace.record(stage, data)
}

function newWatchState(): WatchState {
  return {
    busy: false,
    lastSnapshotAt: 0,
    lastRangeClass: '',
    lastActorAddress: 0,
    lastNativeBlActIndex: -1,
    lastHandleSignature: '',
  }
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 3) === 0
}

function signed32(value: number) {
  return value | 0
}

function rangeClass(snapshot: MultiplayerPresenceSnapshot) {
  const local = snapshot.local
  const remote = snapshot.remote
  if (!local || !remote) return 'missing-presence'
  if (String(local.location.mapId) !== String(remote.location.mapId)) return 'different-map'
  const dx = Math.abs(remote.x - local.x)
  const dy = Math.abs(remote.y - local.y)
  if (dx <= 6 && dy <= 4) return 'inside-enter-range'
  if (dx > 7 || dy > 5) return 'outside-exit-range'
  return 'hysteresis-band'
}

async function nativeBlActIndex(bridge: MelonDsBridge, actorAddress: number) {
  const sceneNodeVTable = await bridge.read32(actorAddress + ACTOR_SCENE_NODE_VTABLE)
  if (!isMainRamPointer(sceneNodeVTable)) return BLACT_NONE
  const getter = await bridge.read32(sceneNodeVTable + SCENE_NODE_GET_BLACT_INDEX)
  const getterAddress = getter & ~1
  if (getterAddress < MAIN_RAM_START || getterAddress >= MAIN_RAM_END) return BLACT_NONE
  const call = await bridge.callArm9Thumb4(FLDACT_GET_BLACT_IDX, actorAddress, 0, 0, 0, NATIVE_STACK_RESERVE)
  return call.status === 1 ? call.result & 0xffff : BLACT_NONE
}

async function snapshotRendererTable(bridge: MelonDsBridge, state: WatchState, reason: string) {
  if (state.busy || !trace.isActive() || bridge.status !== 'running') return
  state.busy = true
  const startedAt = performance.now()
  try {
    const scan = await new White2ActorSystemProbe(bridge).scanHeap()
    const remoteActor = scan.entries.find(entry => entry.uid === POKERUN_NATIVE_TEST_UID)
    if (!remoteActor) {
      record('renderer_table_snapshot', {
        reason,
        actorPresent: false,
        actorSystem: scan.actorSystem,
        rangeClass: rangeClass(latestPresence),
        ...presenceFields(),
      })
      return
    }

    const actorAddress = remoteActor.address
    const [uid, modelId, faceDir, gridX, gridY, worldXRaw, worldYRaw, worldZRaw, actorSystem, claimedBlActIndex] = await Promise.all([
      bridge.read16(actorAddress + ACTOR_UID),
      bridge.read16(actorAddress + ACTOR_MODEL_ID),
      bridge.read16(actorAddress + ACTOR_FACE_DIR),
      bridge.read16(actorAddress + ACTOR_GPOS + 0x00),
      bridge.read16(actorAddress + ACTOR_GPOS + 0x04),
      bridge.read32(actorAddress + ACTOR_WPOS + 0x00),
      bridge.read32(actorAddress + ACTOR_WPOS + 0x04),
      bridge.read32(actorAddress + ACTOR_WPOS + 0x08),
      bridge.read32(actorAddress + ACTOR_SYSTEM_BACKPTR),
      nativeBlActIndex(bridge, actorAddress),
    ])

    if (!isMainRamPointer(actorSystem)) {
      record('renderer_table_snapshot', {
        reason,
        actorPresent: true,
        actorAddress,
        uid,
        modelId,
        actorSystem,
        claimedBlActIndex,
        result: 'invalid-actor-system',
        rangeClass: rangeClass(latestPresence),
        ...presenceFields(),
      })
      return
    }

    const fieldBlAct = await bridge.read32(actorSystem + ACTOR_SYSTEM_FIELD_BLACT)
    const blActSystem = isMainRamPointer(fieldBlAct) ? await bridge.read32(fieldBlAct + FIELD_BLACT_SYSTEM) : 0
    if (!isMainRamPointer(blActSystem)) {
      record('renderer_table_snapshot', {
        reason,
        actorPresent: true,
        actorAddress,
        uid,
        modelId,
        actorSystem,
        claimedBlActIndex,
        fieldBlAct,
        blActSystem,
        result: 'invalid-blact-system',
        rangeClass: rangeClass(latestPresence),
        ...presenceFields(),
      })
      return
    }

    const [scene, actorHandles, handleCount] = await Promise.all([
      bridge.read32(blActSystem + BLACT_SYSTEM_SCENE),
      bridge.read32(blActSystem + BLACT_SYSTEM_ACTOR_HANDLES),
      bridge.read16(blActSystem + BLACT_SYSTEM_ACTOR_COUNT),
    ])
    if (!isMainRamPointer(scene) || !isMainRamPointer(actorHandles)) throw new Error('Renderer scene/handle table pointers are invalid.')

    const [sceneActors, sceneActorCount] = await Promise.all([
      bridge.read32(scene + BLACT_SCENE_ACTORS),
      bridge.read16(scene + BLACT_SCENE_CONFIG_ACTOR_COUNT),
    ])
    if (!isMainRamPointer(sceneActors)) throw new Error('Renderer scene actor table pointer is invalid.')

    const allOwners: string[] = []
    const activeHandles: Array<{ slot: number; address: number; owner: number; matEntry: number }> = []
    const handlesByOwner = new Map<number, Array<{ slot: number; address: number; matEntry: number }>>()
    for (let slot = 0; slot < handleCount; slot += 1) {
      const address = actorHandles + slot * HANDLE_SIZE
      const owner = await bridge.read32(address + HANDLE_BLACT_INDEX)
      allOwners.push(`${slot}:${owner}`)
      if (owner >= sceneActorCount) continue
      const matEntry = await bridge.read16(address + HANDLE_MAT_ENTRY)
      const active = { slot, address, owner, matEntry }
      activeHandles.push(active)
      const list = handlesByOwner.get(owner) ?? []
      list.push({ slot, address, matEntry })
      handlesByOwner.set(owner, list)
    }

    const worldX = signed32(worldXRaw)
    const worldY = signed32(worldYRaw)
    const worldZ = signed32(worldZRaw)
    const nearbyScene: Array<Record<string, unknown>> = []
    let exactPositionCount = 0
    for (let index = 0; index < sceneActorCount; index += 1) {
      const address = sceneActors + index * BLACT_SIZE
      const [xRaw, zRaw] = await Promise.all([
        bridge.read32(address + BLACT_POSITION + 0x00),
        bridge.read32(address + BLACT_POSITION + 0x08),
      ])
      const x = signed32(xRaw)
      const z = signed32(zRaw)
      const dx = Math.abs(x - worldX)
      const dz = Math.abs(z - worldZ)
      if (index !== claimedBlActIndex && (dx > NEARBY_RADIUS_FX32 || dz > NEARBY_RADIUS_FX32)) continue
      const [yRaw, geomFlags, faceIndex, matFlags] = await Promise.all([
        bridge.read32(address + BLACT_POSITION + 0x04),
        bridge.read16(address + BLACT_GEOM_FLAGS),
        bridge.read16(address + BLACT_FACE_INDEX),
        bridge.read16(address + BLACT_MAT_FLAGS),
      ])
      const ownerHandles = handlesByOwner.get(index) ?? []
      if (dx <= FX32_TILE / 4 && dz <= FX32_TILE / 4) exactPositionCount += 1
      nearbyScene.push({
        index,
        address,
        x,
        y: signed32(yRaw),
        z,
        deltaX: x - worldX,
        deltaZ: z - worldZ,
        geomFlags,
        faceIndex,
        matFlags,
        handles: ownerHandles,
      })
    }

    const matchingHandles = activeHandles.filter(entry => entry.owner === claimedBlActIndex)
    const handleSignature = activeHandles.map(entry => `${entry.slot}:${entry.owner}:${entry.matEntry}`).join('|')
    const currentRangeClass = rangeClass(latestPresence)

    record('renderer_table_snapshot', {
      reason,
      result: 'ok',
      actorPresent: true,
      actorAddress,
      uid,
      modelId,
      faceDir,
      gridX,
      gridY,
      worldX,
      worldY,
      worldZ,
      actorSystem,
      claimedBlActIndex,
      handleCount,
      sceneActorCount,
      matchingHandleCount: matchingHandles.length,
      matchingHandlesJson: JSON.stringify(matchingHandles),
      activeHandleCount: activeHandles.length,
      activeHandlesJson: JSON.stringify(activeHandles),
      allHandleOwnersCsv: allOwners.join(','),
      nearbySceneCount: nearbyScene.length,
      exactPositionCount,
      nearbySceneJson: JSON.stringify(nearbyScene),
      rangeClass: currentRangeClass,
      durationMs: performance.now() - startedAt,
      ...presenceFields(),
    })

    const nativeIndexChanged = state.lastNativeBlActIndex !== claimedBlActIndex
    const handleTableChanged = state.lastHandleSignature !== handleSignature
    if (nativeIndexChanged || handleTableChanged) {
      record('renderer_table_change', {
        reason,
        actorAddress,
        previousBlActIndex: state.lastNativeBlActIndex,
        claimedBlActIndex,
        nativeIndexChanged,
        handleTableChanged,
        previousHandleSignature: state.lastHandleSignature,
        handleSignature,
        matchingHandleCount: matchingHandles.length,
        exactPositionCount,
        rangeClass: currentRangeClass,
      })
    }

    state.lastActorAddress = actorAddress
    state.lastNativeBlActIndex = claimedBlActIndex
    state.lastHandleSignature = handleSignature
    state.lastRangeClass = currentRangeClass
    state.lastSnapshotAt = performance.now()
  } catch (error) {
    record('renderer_table_error', {
      reason,
      error: error instanceof Error ? error.message : String(error),
      rangeClass: rangeClass(latestPresence),
      ...presenceFields(),
    })
  } finally {
    state.busy = false
  }
}

function presenceFields(): TraceData {
  const local = latestPresence.local
  const remote = latestPresence.remote
  return {
    localPresent: Boolean(local),
    localMapId: local ? String(local.location.mapId) : '',
    localGridX: local?.x ?? 0,
    localGridY: local?.y ?? 0,
    localDirection: local?.direction ?? '',
    localMovementState: local?.movementState ?? '',
    localWorldX: local?.worldPosition?.x ?? 0,
    localWorldY: local?.worldPosition?.y ?? 0,
    localWorldZ: local?.worldPosition?.z ?? 0,
    remotePresent: Boolean(remote),
    remoteMapId: remote ? String(remote.location.mapId) : '',
    remoteGridX: remote?.x ?? 0,
    remoteGridY: remote?.y ?? 0,
    remoteDirection: remote?.direction ?? '',
    remoteMovementState: remote?.movementState ?? '',
    remoteWorldX: remote?.worldPosition?.x ?? 0,
    remoteWorldY: remote?.worldPosition?.y ?? 0,
    remoteWorldZ: remote?.worldPosition?.z ?? 0,
    gridDx: local && remote ? Math.abs(remote.x - local.x) : -1,
    gridDy: local && remote ? Math.abs(remote.y - local.y) : -1,
  }
}

function registerBridge(bridge: MelonDsBridge) {
  if (!bridges.has(bridge)) bridges.set(bridge, newWatchState())
}

function tick() {
  if (!trace.isActive()) return
  const nextRangeClass = rangeClass(latestPresence)
  for (const [bridge, state] of bridges) {
    if (bridge.status !== 'running' || state.busy) continue
    const rangeChanged = state.lastRangeClass !== nextRangeClass
    const periodicDue = performance.now() - state.lastSnapshotAt >= PERIODIC_SNAPSHOT_MS
    if (rangeChanged || periodicDue) {
      void snapshotRendererTable(bridge, state, rangeChanged ? `range:${state.lastRangeClass || 'unknown'}->${nextRangeClass}` : 'periodic')
    }
  }
}

export function installRendererTableTraceDiagnostics() {
  if (rendererWindow.__POKERUN_RENDERER_TABLE_TRACE_INSTALLED__) return
  rendererWindow.__POKERUN_RENDERER_TABLE_TRACE_INSTALLED__ = true

  multiplayerPresence.subscribe(snapshot => {
    const previousRange = rangeClass(latestPresence)
    latestPresence = snapshot
    const nextRange = rangeClass(snapshot)
    if (trace.isActive() && previousRange !== nextRange) {
      for (const [bridge, state] of bridges) void snapshotRendererTable(bridge, state, `presence-range:${previousRange}->${nextRange}`)
    }
  })

  const originalAttachScreens = MelonDsBridge.prototype.attachScreens
  MelonDsBridge.prototype.attachScreens = function tracedRendererAttachScreens(top, bottom) {
    const result = originalAttachScreens.call(this, top, bottom)
    registerBridge(this)
    return result
  }

  trace.subscribe(snapshot => {
    if (!snapshot.active) return
    for (const [bridge, state] of bridges) {
      state.lastSnapshotAt = 0
      state.lastRangeClass = ''
      state.lastActorAddress = 0
      state.lastNativeBlActIndex = -1
      state.lastHandleSignature = ''
      void snapshotRendererTable(bridge, state, 'trace-start')
    }
  })

  timer = window.setInterval(tick, SAMPLE_MS)
}
