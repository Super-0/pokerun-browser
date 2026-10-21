import { MelonDsBridge, type Arm9NativeCallResult } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import { POKERUN_NATIVE_TEST_UID, White2NativeActorBridge, type White2NativeSpawn } from '../games/White2NativeActor'
import { White2ActorSystemProbe } from '../games/White2ActorSystem'
import { multiplayerMovementTrace } from './MultiplayerMovementTrace'

type TraceData = Record<string, string | number | boolean | null>
type TraceApi = {
  isActive(): boolean
  record(stage: string, data: TraceData): void
  subscribe(listener: (snapshot: { active: boolean }) => void): () => void
}
type RuntimeWindow = Window & { __POKERUN_WHITE2_DEDICATED_TRACE_INSTALLED__?: boolean }

type RemoteBinding = {
  actorSystem: number
  blActIndex: number
  blActAddress: number
  handleAddress: number
  handleCount: number
  sceneActorCount: number
}

type BridgeState = {
  actorAddress: number | null
  blActIndex: number | null
  binding: RemoteBinding | null
  sampling: boolean
  refreshing: boolean
  lastRefreshAt: number
  lastActorSignature: string
  lastBindingSignature: string
  lastProfileSignature: string
}

const trace = multiplayerMovementTrace as unknown as TraceApi
const runtimeWindow = window as RuntimeWindow
const bridges = new Map<MelonDsBridge, BridgeState>()

const SAMPLE_MS = 50
const BINDING_REFRESH_MS = 250
const DISCOVERY_MS = 500

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
const BLACT_NONE = 0xffff
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000

let samplerTimer: number | null = null
let latestPresence: MultiplayerPresenceSnapshot = { local: null, remote: null }
let lastPresenceSignature = ''
let lastDiscoveryAt = 0

function newState(): BridgeState {
  return {
    actorAddress: null,
    blActIndex: null,
    binding: null,
    sampling: false,
    refreshing: false,
    lastRefreshAt: 0,
    lastActorSignature: '',
    lastBindingSignature: '',
    lastProfileSignature: '',
  }
}

function record(stage: string, data: TraceData) {
  if (trace.isActive()) trace.record(stage, data)
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 3) === 0
}

function stateData(prefix: string, state: MultiplayerPresenceSnapshot['local']) {
  const world = state?.worldPosition
  return {
    [`${prefix}Present`]: Boolean(state),
    [`${prefix}MapId`]: state ? String(state.location.mapId) : '',
    [`${prefix}GridX`]: state?.x ?? 0,
    [`${prefix}GridY`]: state?.y ?? 0,
    [`${prefix}Direction`]: state?.direction ?? '',
    [`${prefix}MovementState`]: state?.movementState ?? '',
    [`${prefix}WorldX`]: world?.x ?? 0,
    [`${prefix}WorldY`]: world?.y ?? 0,
    [`${prefix}WorldZ`]: world?.z ?? 0,
  } satisfies TraceData
}

function presenceSignature(snapshot: MultiplayerPresenceSnapshot) {
  const local = snapshot.local
  const remote = snapshot.remote
  return [
    local?.location.mapId ?? '', local?.x ?? '', local?.y ?? '', local?.direction ?? '', local?.movementState ?? '',
    local?.worldPosition?.x ?? '', local?.worldPosition?.y ?? '', local?.worldPosition?.z ?? '',
    remote?.location.mapId ?? '', remote?.x ?? '', remote?.y ?? '', remote?.direction ?? '', remote?.movementState ?? '',
    remote?.worldPosition?.x ?? '', remote?.worldPosition?.y ?? '', remote?.worldPosition?.z ?? '',
  ].join('|')
}

async function refreshBinding(bridge: MelonDsBridge, state: BridgeState, force = false) {
  if (state.refreshing || !state.actorAddress || state.blActIndex === null || state.blActIndex === BLACT_NONE) return
  const now = performance.now()
  if (!force && now - state.lastRefreshAt < BINDING_REFRESH_MS) return
  state.refreshing = true
  state.lastRefreshAt = now
  try {
    const actorAddress = state.actorAddress
    const blActIndex = state.blActIndex
    const actorSystem = await bridge.read32(actorAddress + ACTOR_SYSTEM_BACKPTR)
    if (!isMainRamPointer(actorSystem)) {
      record('dedicated_binding_probe', { result: 'invalid_actor_system', actorAddress, actorSystem, blActIndex })
      return
    }
    const fieldBlAct = await bridge.read32(actorSystem + ACTOR_SYSTEM_FIELD_BLACT)
    if (!isMainRamPointer(fieldBlAct)) {
      record('dedicated_binding_probe', { result: 'invalid_field_blact', actorAddress, actorSystem, fieldBlAct, blActIndex })
      return
    }
    const blActSystem = await bridge.read32(fieldBlAct + FIELD_BLACT_SYSTEM)
    if (!isMainRamPointer(blActSystem)) {
      record('dedicated_binding_probe', { result: 'invalid_blact_system', actorAddress, actorSystem, blActSystem, blActIndex })
      return
    }
    const [scene, actorHandles, handleCount] = await Promise.all([
      bridge.read32(blActSystem + BLACT_SYSTEM_SCENE),
      bridge.read32(blActSystem + BLACT_SYSTEM_ACTOR_HANDLES),
      bridge.read16(blActSystem + BLACT_SYSTEM_ACTOR_COUNT),
    ])
    if (!isMainRamPointer(scene) || !isMainRamPointer(actorHandles)) {
      record('dedicated_binding_probe', { result: 'invalid_scene_or_handles', actorAddress, scene, actorHandles, handleCount, blActIndex })
      return
    }
    const [sceneActors, sceneActorCount] = await Promise.all([
      bridge.read32(scene + BLACT_SCENE_ACTORS),
      bridge.read16(scene + BLACT_SCENE_CONFIG_ACTOR_COUNT),
    ])
    if (!isMainRamPointer(sceneActors) || blActIndex >= sceneActorCount) {
      record('dedicated_binding_probe', { result: 'invalid_scene_actor', actorAddress, sceneActors, sceneActorCount, handleCount, blActIndex })
      return
    }

    const matches: number[] = []
    for (let index = 0; index < handleCount; index += 1) {
      const handleAddress = actorHandles + index * HANDLE_SIZE
      if ((await bridge.read32(handleAddress + HANDLE_BLACT_INDEX)) === blActIndex) matches.push(handleAddress)
    }

    if (matches.length !== 1) {
      record('dedicated_binding_probe', {
        result: matches.length ? 'ambiguous_handles' : 'missing_handle',
        actorAddress,
        actorSystem,
        blActIndex,
        handleCount,
        sceneActorCount,
        matchCount: matches.length,
      })
      state.binding = null
      return
    }

    const next: RemoteBinding = {
      actorSystem,
      blActIndex,
      blActAddress: sceneActors + blActIndex * BLACT_SIZE,
      handleAddress: matches[0],
      handleCount,
      sceneActorCount,
    }
    const signature = `${next.actorSystem}:${next.blActIndex}:${next.blActAddress}:${next.handleAddress}`
    if (signature !== state.lastBindingSignature) {
      record('dedicated_binding_resolved', {
        actorAddress,
        actorSystem: next.actorSystem,
        blActIndex: next.blActIndex,
        blActAddress: next.blActAddress,
        handleAddress: next.handleAddress,
        handleCount,
        sceneActorCount,
      })
      state.lastBindingSignature = signature
    }
    state.binding = next
  } catch (error) {
    record('dedicated_binding_probe', { result: 'error', error: error instanceof Error ? error.message : String(error) })
  } finally {
    state.refreshing = false
  }
}

async function discoverRemoteActor(bridge: MelonDsBridge, state: BridgeState) {
  if (performance.now() - lastDiscoveryAt < DISCOVERY_MS) return
  lastDiscoveryAt = performance.now()
  try {
    const scan = await new White2ActorSystemProbe(bridge).scanHeap()
    const remote = scan.entries.find(entry => entry.uid === POKERUN_NATIVE_TEST_UID)
    if (!remote) return
    if (state.actorAddress !== remote.address) {
      record('dedicated_actor_discovered', {
        actorAddress: remote.address,
        modelId: remote.modelId,
        zoneId: remote.zoneId,
        gridX: remote.x,
        gridY: remote.y,
        actorSystem: scan.actorSystem,
      })
      state.actorAddress = remote.address
      state.blActIndex = null
      state.binding = null
      state.lastActorSignature = ''
      state.lastBindingSignature = ''
      state.lastProfileSignature = ''
    }
  } catch (error) {
    record('dedicated_actor_discovery_error', { error: error instanceof Error ? error.message : String(error) })
  }
}

async function sampleBridge(bridge: MelonDsBridge, state: BridgeState) {
  if (state.sampling || bridge.status !== 'running' || !trace.isActive()) return
  state.sampling = true
  try {
    if (!state.actorAddress) await discoverRemoteActor(bridge, state)
    const actorAddress = state.actorAddress
    if (!actorAddress) {
      record('dedicated_runtime_sample', { actorPresent: false, ...stateData('local', latestPresence.local), ...stateData('remote', latestPresence.remote) })
      return
    }

    const [uid, modelId, faceDir, gridX, gridY, worldX, worldY, worldZ, actorSystem, sceneNodeVTable] = await Promise.all([
      bridge.read16(actorAddress + ACTOR_UID),
      bridge.read16(actorAddress + ACTOR_MODEL_ID),
      bridge.read16(actorAddress + ACTOR_FACE_DIR),
      bridge.read16(actorAddress + ACTOR_GPOS + 0x00),
      bridge.read16(actorAddress + ACTOR_GPOS + 0x04),
      bridge.read32(actorAddress + ACTOR_WPOS + 0x00),
      bridge.read32(actorAddress + ACTOR_WPOS + 0x04),
      bridge.read32(actorAddress + ACTOR_WPOS + 0x08),
      bridge.read32(actorAddress + ACTOR_SYSTEM_BACKPTR),
      bridge.read32(actorAddress + ACTOR_SCENE_NODE_VTABLE),
    ])
    const sceneNodeGetter = isMainRamPointer(sceneNodeVTable) ? await bridge.read32(sceneNodeVTable + SCENE_NODE_GET_BLACT_INDEX) : 0
    const actorSignature = `${uid}:${modelId}:${faceDir}:${gridX}:${gridY}:${worldX}:${worldY}:${worldZ}:${actorSystem}:${sceneNodeVTable}:${sceneNodeGetter}`
    if (actorSignature !== state.lastActorSignature) {
      record('dedicated_actor_state_change', { actorAddress, uid, modelId, faceDir, gridX, gridY, worldX, worldY, worldZ, actorSystem, sceneNodeVTable, sceneNodeGetter })
      state.lastActorSignature = actorSignature
    }

    if (uid !== POKERUN_NATIVE_TEST_UID) {
      record('dedicated_actor_lost', { actorAddress, observedUid: uid, expectedUid: POKERUN_NATIVE_TEST_UID })
      state.actorAddress = null
      state.blActIndex = null
      state.binding = null
      return
    }

    if (!state.binding) await refreshBinding(bridge, state)
    const binding = state.binding
    let bindingOwner = -1
    let matEntry = -1
    let geomFlags = -1
    let faceIndex = -1
    let matFlags = -1
    let blActX = 0
    let blActY = 0
    let blActZ = 0

    if (binding) {
      [bindingOwner, matEntry, geomFlags, faceIndex, matFlags, blActX, blActY, blActZ] = await Promise.all([
        bridge.read32(binding.handleAddress + HANDLE_BLACT_INDEX),
        bridge.read16(binding.handleAddress + HANDLE_MAT_ENTRY),
        bridge.read16(binding.blActAddress + BLACT_GEOM_FLAGS),
        bridge.read16(binding.blActAddress + BLACT_FACE_INDEX),
        bridge.read16(binding.blActAddress + BLACT_MAT_FLAGS),
        bridge.read32(binding.blActAddress + BLACT_POSITION + 0x00),
        bridge.read32(binding.blActAddress + BLACT_POSITION + 0x04),
        bridge.read32(binding.blActAddress + BLACT_POSITION + 0x08),
      ])
      if (bindingOwner !== binding.blActIndex) {
        record('dedicated_binding_invalid', {
          actorAddress,
          expectedBlActIndex: binding.blActIndex,
          observedOwner: bindingOwner,
          handleAddress: binding.handleAddress,
          blActAddress: binding.blActAddress,
        })
        state.binding = null
      }
      const profileSignature = `${matEntry}:${faceIndex}:${geomFlags}:${matFlags}`
      if (profileSignature !== state.lastProfileSignature) {
        record('dedicated_render_state_change', {
          actorAddress,
          blActIndex: binding.blActIndex,
          handleAddress: binding.handleAddress,
          blActAddress: binding.blActAddress,
          matEntry,
          faceIndex,
          geomFlags,
          matFlags,
        })
        state.lastProfileSignature = profileSignature
      }
    }

    record('dedicated_runtime_sample', {
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
      sceneNodeVTable,
      sceneNodeGetter,
      blActIndex: state.blActIndex ?? -1,
      bindingPresent: Boolean(binding),
      bindingOwner,
      handleAddress: binding?.handleAddress ?? 0,
      blActAddress: binding?.blActAddress ?? 0,
      matEntry,
      faceIndex,
      geomFlags,
      matFlags,
      blActX,
      blActY,
      blActZ,
      ...stateData('local', latestPresence.local),
      ...stateData('remote', latestPresence.remote),
    })
  } catch (error) {
    record('dedicated_runtime_sample_error', { error: error instanceof Error ? error.message : String(error) })
  } finally {
    state.sampling = false
  }
}

function observeWrite16(bridge: MelonDsBridge, address: number, value: number) {
  if (!trace.isActive()) return
  const state = bridges.get(bridge)
  const binding = state?.binding
  const actorAddress = state?.actorAddress
  if (!state || !actorAddress) return

  if (address === actorAddress + ACTOR_FACE_DIR) {
    record('dedicated_actor_write', { actorAddress, field: 'faceDir', address, value })
    return
  }
  if (!binding) return

  let field = ''
  if (address === binding.handleAddress + HANDLE_MAT_ENTRY) field = 'matEntry'
  else if (address === binding.blActAddress + BLACT_GEOM_FLAGS) field = 'geomFlags'
  else if (address === binding.blActAddress + BLACT_FACE_INDEX) field = 'faceIndex'
  else if (address === binding.blActAddress + BLACT_MAT_FLAGS) field = 'matFlags'
  if (!field) return

  record('dedicated_render_write', {
    actorAddress,
    blActIndex: binding.blActIndex,
    handleAddress: binding.handleAddress,
    blActAddress: binding.blActAddress,
    field,
    address,
    value,
  })
}

function startSampler() {
  if (samplerTimer !== null) return
  lastPresenceSignature = ''
  samplerTimer = window.setInterval(() => {
    for (const [bridge, state] of bridges) void sampleBridge(bridge, state)
  }, SAMPLE_MS)
  for (const [bridge, state] of bridges) void sampleBridge(bridge, state)
}

function stopSampler() {
  if (samplerTimer !== null) window.clearInterval(samplerTimer)
  samplerTimer = null
}

export function installWhite2DedicatedTraceDiagnostics() {
  if (runtimeWindow.__POKERUN_WHITE2_DEDICATED_TRACE_INSTALLED__) return
  runtimeWindow.__POKERUN_WHITE2_DEDICATED_TRACE_INSTALLED__ = true

  trace.subscribe(snapshot => snapshot.active ? startSampler() : stopSampler())

  multiplayerPresence.subscribe(snapshot => {
    latestPresence = snapshot
    if (!trace.isActive()) return
    const signature = presenceSignature(snapshot)
    if (signature === lastPresenceSignature) return
    lastPresenceSignature = signature
    record('dedicated_presence', { ...stateData('local', snapshot.local), ...stateData('remote', snapshot.remote) })
  })

  const originalAttachScreens = MelonDsBridge.prototype.attachScreens
  MelonDsBridge.prototype.attachScreens = function(top: HTMLCanvasElement, bottom: HTMLCanvasElement) {
    bridges.set(this, newState())
    return originalAttachScreens.call(this, top, bottom)
  }

  const originalDispose = MelonDsBridge.prototype.dispose
  MelonDsBridge.prototype.dispose = async function() {
    bridges.delete(this)
    return originalDispose.call(this)
  }

  const originalWrite16 = MelonDsBridge.prototype.write16
  MelonDsBridge.prototype.write16 = async function(address: number, value: number) {
    await originalWrite16.call(this, address, value)
    observeWrite16(this, address, value)
  }

  const originalNativeCall = MelonDsBridge.prototype.callArm9Thumb4
  MelonDsBridge.prototype.callArm9Thumb4 = async function(
    functionAddress: number,
    r0 = 0,
    r1 = 0,
    r2 = 0,
    r3 = 0,
    stackReserve = 0x1000,
  ): Promise<Arm9NativeCallResult> {
    const started = performance.now()
    const result = await originalNativeCall.call(this, functionAddress, r0, r1, r2, r3, stackReserve)
    if (trace.isActive() && (functionAddress >>> 0) === FLDACT_GET_BLACT_IDX) {
      let uid = -1
      try { uid = await this.read16((r0 >>> 0) + ACTOR_UID) } catch { /* actor may be unloading */ }
      record('dedicated_blact_lookup', {
        actorAddress: r0 >>> 0,
        uid,
        result: result.result & 0xffff,
        status: result.status,
        pc: result.pc,
        lr: result.lr,
        instructions: result.instructions,
        durationMs: performance.now() - started,
      })
      if (uid === POKERUN_NATIVE_TEST_UID && result.status === 1) {
        const state = bridges.get(this)
        if (state) {
          state.actorAddress = r0 >>> 0
          state.blActIndex = result.result & 0xffff
          if (state.binding?.blActIndex !== state.blActIndex) state.binding = null
          void refreshBinding(this, state, true)
        }
      }
    }
    return result
  }

  const originalSpawn = White2NativeActorBridge.prototype.spawnTestActor
  White2NativeActorBridge.prototype.spawnTestActor = async function(): Promise<White2NativeSpawn> {
    const bridge = (this as unknown as { bridge: MelonDsBridge }).bridge
    const started = performance.now()
    record('dedicated_actor_spawn', { phase: 'begin' })
    try {
      const spawned = await originalSpawn.call(this)
      const state = bridges.get(bridge)
      if (state) {
        state.actorAddress = spawned.actorAddress
        state.blActIndex = null
        state.binding = null
        state.lastActorSignature = ''
        state.lastBindingSignature = ''
        state.lastProfileSignature = ''
      }
      record('dedicated_actor_spawn', {
        phase: 'end',
        durationMs: performance.now() - started,
        actorAddress: spawned.actorAddress,
        uid: spawned.uid,
        modelId: spawned.modelId,
        zoneId: spawned.zoneId,
        gridX: spawned.x,
        gridY: spawned.z,
      })
      return spawned
    } catch (error) {
      record('dedicated_actor_spawn', { phase: 'error', durationMs: performance.now() - started, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  const originalDelete = White2NativeActorBridge.prototype.deleteTestActor
  White2NativeActorBridge.prototype.deleteTestActor = async function(actorAddress?: number) {
    const bridge = (this as unknown as { bridge: MelonDsBridge }).bridge
    const state = bridges.get(bridge)
    const address = actorAddress ?? state?.actorAddress ?? 0
    const started = performance.now()
    record('dedicated_actor_delete', { phase: 'begin', actorAddress: address })
    try {
      const deleted = await originalDelete.call(this, actorAddress)
      record('dedicated_actor_delete', { phase: 'end', actorAddress: address, deleted, durationMs: performance.now() - started })
      if (deleted && state) {
        state.actorAddress = null
        state.blActIndex = null
        state.binding = null
        state.lastActorSignature = ''
        state.lastBindingSignature = ''
        state.lastProfileSignature = ''
      }
      return deleted
    } catch (error) {
      record('dedicated_actor_delete', { phase: 'error', actorAddress: address, durationMs: performance.now() - started, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
}
