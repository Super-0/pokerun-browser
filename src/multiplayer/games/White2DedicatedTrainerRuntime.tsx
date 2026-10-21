import { useEffect, useRef } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerPlayerState, MultiplayerRomIdentity, MultiplayerWorldPosition } from '../core/protocol'
import { POKERUN_NATIVE_TEST_UID, White2NativeActorBridge, White2NativeActorUnsafeStateError } from './White2NativeActor'
import { White2ActorSystemProbe, White2ActorSystemUnavailableError } from './White2ActorSystem'

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
const HANDLE_ANIMS = 0x08
const HANDLE_ANIM_COUNT = 0x0c
const HANDLE_ANIM = 0x0e
const HANDLE_STEP = 0x10
const HANDLE_WAIT = 0x12
const HANDLE_LOOPS = 0x14
const HANDLE_ANIMATE = 0x18

const FLDACT_GET_BLACT_IDX = 0x02167240
const NATIVE_STACK_RESERVE = 0x400
const BLACT_NONE = 0xffff
const PLAYER_UID = 0x00ff
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000

const UPDATE_MS = 20
const LEARN_SAMPLE_MS = 40
const MOVING_HOLD_MS = 120
const ENTER_REMOTE_DX = 6
const ENTER_REMOTE_DY = 4
const MAP_STABLE_MS = 280
const MISSING_STATE_GRACE_MS = 160
const REACQUIRE_COOLDOWN_MS = 250
const BIND_TIMEOUT_MS = 1800
const TURN_CAPTURE_MS = 240
const MAX_STEP_HOLD_MS = 250
const SMOOTHING_ALPHA = 0.72
const SMOOTHING_SNAP_FX32 = 16 * 4096
const SMOOTHING_EPSILON_FX32 = 64
// Trace data shows White 2 walking at roughly 248 FX32 units/ms and running at
// roughly 482 FX32 units/ms. Keep the threshold between those two stable bands.
const RUN_SPEED_THRESHOLD_FX32_PER_MS = 360
// V4 separates walk/run animation knowledge and refuses cached frames whose
// geometry does not match the trusted idle renderer for that direction.
const CACHE_VERSION = 4

const FIELD_FACE_BY_DIRECTION = { north: 0, south: 1, west: 2, east: 3 } as const
const DIRECTION_BY_FIELD_FACE: Partial<Record<number, MultiplayerPlayerState['direction']>> = {
  0: 'north',
  1: 'south',
  2: 'west',
  3: 'east',
}
const DIRECTIONS: MultiplayerPlayerState['direction'][] = ['north', 'south', 'west', 'east']

type Direction = MultiplayerPlayerState['direction']
type MotionKind = 'walk' | 'run'
type TurnKey = `${Direction}->${Direction}`

// White 2's normal protagonist walk frames are grouped by direction in the
// renderer atlas. Learned sequences always win; these indices are only a
// temporary cold-start fallback until the local protagonist demonstrates them.
const WALK_FACE_START_BY_DIRECTION: Record<Direction, number> = {
  north: 0,
  south: 3,
  west: 6,
  east: 9,
}

type ActorBinding = {
  actorAddress: number
  uid: number
  actorSystem: number
  blActIndex: number
  blActAddress: number
  handleAddress: number
}

type RenderProfile = {
  matEntry: number
  faceIndex: number
  geomFlags: number
  matFlags: number
}

type RenderSequenceStep = RenderProfile & {
  holdMs: number
}

type DirectionKnowledge = {
  idle: RenderProfile | null
  idleCounts: Map<string, { count: number; profile: RenderProfile }>
  walkSequence: RenderSequenceStep[]
  runSequence: RenderSequenceStep[]
  currentSequence: RenderSequenceStep[]
}

type TurnCapture = {
  key: TurnKey
  startedAt: number
  sequence: RenderSequenceStep[]
}

type RemoteTurnPlayback = {
  sequence: RenderSequenceStep[]
  index: number
  stepStartedAt: number
}

type CachedDirectionKnowledge = {
  idle: RenderProfile | null
  walkSequence: RenderSequenceStep[]
  runSequence: RenderSequenceStep[]
}

type CachedRenderProfile = {
  version: number
  directions: Record<Direction, CachedDirectionKnowledge>
  turns?: Record<string, RenderSequenceStep[]>
}

type DedicatedBinding = ActorBinding & {
  nativeRender: RenderProfile
}

function delay(ms: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms))
}

function signed32(value: number) {
  return value | 0
}

function hex(value: number) {
  return `0x${value.toString(16).padStart(8, '0').toUpperCase()}`
}

function smoothFx32(current: number, target: number) {
  const currentSigned = signed32(current)
  const targetSigned = signed32(target)
  const delta = targetSigned - currentSigned
  if (Math.abs(delta) >= SMOOTHING_SNAP_FX32 || Math.abs(delta) <= SMOOTHING_EPSILON_FX32) return target >>> 0
  return Math.round(currentSigned + delta * SMOOTHING_ALPHA) >>> 0
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 0x3) === 0
}

function isMainRamFunctionPointer(value: number) {
  const address = value & ~1
  return Number.isInteger(value) && address >= MAIN_RAM_START && address < MAIN_RAM_END
    && ((value & 1) === 1 || (address & 3) === 0)
}

function assertMainRamPointer(value: number, label: string) {
  if (!isMainRamPointer(value)) throw new Error(`${label} is not a valid White 2 main-RAM pointer.`)
}

function profileKey(profile: RenderProfile) {
  return `${profile.matEntry}:${profile.faceIndex}:${profile.geomFlags}:${profile.matFlags}`
}

function turnKey(from: Direction, to: Direction): TurnKey {
  return `${from}->${to}`
}

function createDirectionKnowledge(): DirectionKnowledge {
  return {
    idle: null,
    idleCounts: new Map<string, { count: number; profile: RenderProfile }>(),
    walkSequence: [],
    runSequence: [],
    currentSequence: [],
  }
}

function emptyKnowledge(): Record<Direction, DirectionKnowledge> {
  return {
    north: createDirectionKnowledge(),
    south: createDirectionKnowledge(),
    west: createDirectionKnowledge(),
    east: createDirectionKnowledge(),
  }
}

function trustedBootstrapProfile(knowledge: Record<Direction, DirectionKnowledge>, direction: Direction): RenderProfile | null {
  const directionIdle = knowledge[direction].idle
  if (directionIdle) return directionIdle
  for (const candidate of DIRECTIONS) {
    const idle = knowledge[candidate].idle
    if (idle) return idle
  }
  return null
}

function bootstrapIdleProfile(knowledge: Record<Direction, DirectionKnowledge>, direction: Direction): RenderProfile | null {
  const trustedProfile = trustedBootstrapProfile(knowledge, direction)
  if (!trustedProfile) return null
  return {
    ...trustedProfile,
    faceIndex: WALK_FACE_START_BY_DIRECTION[direction],
  }
}

function bootstrapWalkSequence(knowledge: Record<Direction, DirectionKnowledge>, direction: Direction): RenderSequenceStep[] {
  const trustedProfile = trustedBootstrapProfile(knowledge, direction)
  if (!trustedProfile) return []

  const baseFaceIndex = WALK_FACE_START_BY_DIRECTION[direction]
  // The recorded White 2 cadence is step pose -> idle -> opposite step pose -> idle.
  // West was observed at roughly 7 (117 ms) -> 6 (118 ms) -> 8 (84 ms) -> 6,
  // so mirror that timing for the other directional frame groups during bootstrap.
  return [
    { ...trustedProfile, faceIndex: baseFaceIndex + 1, holdMs: 120 },
    { ...trustedProfile, faceIndex: baseFaceIndex, holdMs: 120 },
    { ...trustedProfile, faceIndex: baseFaceIndex + 2, holdMs: 90 },
    { ...trustedProfile, faceIndex: baseFaceIndex, holdMs: 120 },
  ]
}

function appendStep(sequence: RenderSequenceStep[], profile: RenderProfile) {
  const previous = sequence[sequence.length - 1]
  if (previous && profileKey(previous) === profileKey(profile)) {
    previous.holdMs = Math.min(MAX_STEP_HOLD_MS, previous.holdMs + LEARN_SAMPLE_MS)
  } else {
    sequence.push({ ...profile, holdMs: LEARN_SAMPLE_MS })
  }
}

function sequenceDuration(sequence: RenderSequenceStep[]) {
  return sequence.reduce((total, step) => total + step.holdMs, 0)
}

function finalizeMotion(knowledge: DirectionKnowledge, motionKind: MotionKind) {
  const target = motionKind === 'run' ? knowledge.runSequence : knowledge.walkSequence
  if (knowledge.currentSequence.length > target.length) {
    const next = knowledge.currentSequence.map(step => ({ ...step }))
    if (motionKind === 'run') knowledge.runSequence = next
    else knowledge.walkSequence = next
  }
  knowledge.currentSequence = []
}

function observeIdle(knowledge: DirectionKnowledge, profile: RenderProfile) {
  const key = profileKey(profile)
  const current = knowledge.idleCounts.get(key)
  if (current) current.count += 1
  else knowledge.idleCounts.set(key, { count: 1, profile: { ...profile } })
  knowledge.idle = [...knowledge.idleCounts.values()].sort((a, b) => b.count - a.count)[0]?.profile ?? knowledge.idle
}

function profileMatchesIdle(idle: RenderProfile, profile: RenderProfile) {
  return profile.geomFlags === idle.geomFlags && profile.matFlags === idle.matFlags
}

function hasStableGeometry(knowledge: DirectionKnowledge, profile: RenderProfile) {
  const idle = knowledge.idle
  if (!idle) return true
  return profileMatchesIdle(idle, profile)
}

function sanitizeSequence(sequence: RenderSequenceStep[] | undefined, idle: RenderProfile | null) {
  if (!idle || !Array.isArray(sequence)) return []
  return sequence
    .filter(step => Number.isFinite(step?.holdMs)
      && step.holdMs > 0
      && step.holdMs <= MAX_STEP_HOLD_MS
      && profileMatchesIdle(idle, step))
    .map(step => ({ ...step }))
}

function motionKindForVelocity(velocityFx32PerMs: number): MotionKind {
  return velocityFx32PerMs >= RUN_SPEED_THRESHOLD_FX32_PER_MS ? 'run' : 'walk'
}

function motionVelocity(a: MultiplayerWorldPosition, b: MultiplayerWorldPosition, elapsedMs: number) {
  const dx = signed32(b.x) - signed32(a.x)
  const dz = signed32(b.z) - signed32(a.z)
  return Math.hypot(dx, dz) / Math.max(1, elapsedMs)
}

function worldChanged(a: MultiplayerWorldPosition | null, b: MultiplayerWorldPosition) {
  return !a || a.x !== b.x || a.y !== b.y || a.z !== b.z
}

function cacheKey(rom: MultiplayerRomIdentity, modelId: number) {
  return `pokerun-white2-trainer-render-v${CACHE_VERSION}:${rom.sha256 ?? 'unknown'}:${modelId}`
}

function loadCachedKnowledge(key: string, knowledge: Record<Direction, DirectionKnowledge>, turns: Map<TurnKey, RenderSequenceStep[]>) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return
    const cached = JSON.parse(raw) as CachedRenderProfile
    if (cached.version !== CACHE_VERSION) return

    for (const direction of DIRECTIONS) {
      const saved = cached.directions?.[direction]
      if (!saved) continue
      const idle = saved.idle ?? null
      knowledge[direction].idle = idle
      knowledge[direction].walkSequence = sanitizeSequence(saved.walkSequence, idle)
      knowledge[direction].runSequence = sanitizeSequence(saved.runSequence, idle)
      if (idle) knowledge[direction].idleCounts.set(profileKey(idle), { count: 1, profile: { ...idle } })
    }

    for (const [keyValue, sequence] of Object.entries(cached.turns ?? {})) {
      if (!Array.isArray(sequence)) continue
      const to = keyValue.split('->')[1] as Direction | undefined
      if (!to || !DIRECTIONS.includes(to)) continue
      const safe = sanitizeSequence(sequence, knowledge[to].idle)
      if (safe.length) turns.set(keyValue as TurnKey, safe)
    }
  } catch {
    // Cache is optional. Live learning will rebuild it.
  }
}

function saveCachedKnowledge(key: string, knowledge: Record<Direction, DirectionKnowledge>, turns: Map<TurnKey, RenderSequenceStep[]>) {
  try {
    const directions = Object.fromEntries(DIRECTIONS.map(direction => [direction, {
      idle: knowledge[direction].idle,
      walkSequence: knowledge[direction].walkSequence,
      runSequence: knowledge[direction].runSequence,
    }])) as CachedRenderProfile['directions']
    const savedTurns = Object.fromEntries([...turns.entries()].map(([keyValue, sequence]) => [keyValue, sequence.map(step => ({ ...step }))]))
    localStorage.setItem(key, JSON.stringify({ version: CACHE_VERSION, directions, turns: savedTurns } satisfies CachedRenderProfile))
  } catch {
    // Multiplayer continues if localStorage is unavailable.
  }
}

async function getNativeBlActIndex(bridge: MelonDsBridge, actorAddress: number) {
  // IRDO's FldAct_GetBlActIdx dereferences actor->sceneNodeVTable (+0x90),
  // then its +0x14 method entry. A loading actor can have a valid UID and
  // actor-system backpointer before that table is ready; calling the game
  // routine then raises an ARM9 data abort at 0x02167248.
  const sceneNodeVTable = await bridge.read32(actorAddress + ACTOR_SCENE_NODE_VTABLE)
  if (!isMainRamPointer(sceneNodeVTable)) {
    throw new White2ActorSystemUnavailableError(`White 2 actor ${hex(actorAddress)} scene-node method table is not ready (${hex(sceneNodeVTable)}).`)
  }
  const getter = await bridge.read32(sceneNodeVTable + SCENE_NODE_GET_BLACT_INDEX)
  if (!isMainRamFunctionPointer(getter)) {
    throw new White2ActorSystemUnavailableError(`White 2 actor ${hex(actorAddress)} billboard-index method is not ready (${hex(getter)} at table ${hex(sceneNodeVTable)}).`)
  }
  const call = await bridge.callArm9Thumb4(FLDACT_GET_BLACT_IDX, actorAddress, 0, 0, 0, NATIVE_STACK_RESERVE)
  if (call.status !== 1) throw new White2NativeActorUnsafeStateError(`FldAct_GetBlActIdx native call failed with status ${call.status}, PC 0x${call.pc.toString(16).toUpperCase()}, after ${call.instructions} instructions. Reload the tab before retrying native actor calls.`)
  return call.result & 0xffff
}

async function resolveActorBinding(bridge: MelonDsBridge, actorAddress: number, expectedUid: number, timeoutMs = BIND_TIMEOUT_MS): Promise<ActorBinding> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (await bridge.read16(actorAddress + ACTOR_UID) !== expectedUid) {
      throw new Error(`White 2 actor UID 0x${expectedUid.toString(16).toUpperCase()} disappeared before its billboard binding was ready.`)
    }

    const actorSystem = await bridge.read32(actorAddress + ACTOR_SYSTEM_BACKPTR)
    assertMainRamPointer(actorSystem, 'Actor system')
    const blActIndex = await getNativeBlActIndex(bridge, actorAddress)
    if (blActIndex !== BLACT_NONE) {
      const fieldBlAct = await bridge.read32(actorSystem + ACTOR_SYSTEM_FIELD_BLACT)
      assertMainRamPointer(fieldBlAct, 'FieldBlAct')
      const blActSystem = await bridge.read32(fieldBlAct + FIELD_BLACT_SYSTEM)
      assertMainRamPointer(blActSystem, 'BlActSystem')
      const [scene, actorHandles, handleCount] = await Promise.all([
        bridge.read32(blActSystem + BLACT_SYSTEM_SCENE),
        bridge.read32(blActSystem + BLACT_SYSTEM_ACTOR_HANDLES),
        bridge.read16(blActSystem + BLACT_SYSTEM_ACTOR_COUNT),
      ])
      assertMainRamPointer(scene, 'BlAct scene')
      assertMainRamPointer(actorHandles, 'BlAct handle array')
      const [sceneActors, sceneActorCount] = await Promise.all([
        bridge.read32(scene + BLACT_SCENE_ACTORS),
        bridge.read16(scene + BLACT_SCENE_CONFIG_ACTOR_COUNT),
      ])
      assertMainRamPointer(sceneActors, 'BlAct actor array')

      if (blActIndex < sceneActorCount) {
        const matches: number[] = []
        for (let index = 0; index < handleCount; index += 1) {
          const handleAddress = actorHandles + index * HANDLE_SIZE
          if ((await bridge.read32(handleAddress + HANDLE_BLACT_INDEX)) === blActIndex) matches.push(handleAddress)
        }
        if (matches.length === 1) {
          return {
            actorAddress,
            uid: expectedUid,
            actorSystem,
            blActIndex,
            blActAddress: sceneActors + blActIndex * BLACT_SIZE,
            handleAddress: matches[0],
          }
        }
      }
    }
    await delay(16)
  }
  throw new Error(`White 2 actor UID 0x${expectedUid.toString(16).toUpperCase()} billboard binding did not become ready in time.`)
}

async function bindingStillValid(bridge: MelonDsBridge, binding: ActorBinding) {
  const [uid, actorSystem, owner] = await Promise.all([
    bridge.read16(binding.actorAddress + ACTOR_UID),
    bridge.read32(binding.actorAddress + ACTOR_SYSTEM_BACKPTR),
    bridge.read32(binding.handleAddress + HANDLE_BLACT_INDEX),
  ])
  return uid === binding.uid && actorSystem === binding.actorSystem && owner === binding.blActIndex
}

async function readRenderProfile(bridge: MelonDsBridge, binding: ActorBinding): Promise<RenderProfile> {
  const [matEntry, faceIndex, geomFlags, matFlags] = await Promise.all([
    bridge.read16(binding.handleAddress + HANDLE_MAT_ENTRY),
    bridge.read16(binding.blActAddress + BLACT_FACE_INDEX),
    bridge.read16(binding.blActAddress + BLACT_GEOM_FLAGS),
    bridge.read16(binding.blActAddress + BLACT_MAT_FLAGS),
  ])
  return { matEntry, faceIndex, geomFlags, matFlags }
}

async function writeRenderProfile(bridge: MelonDsBridge, binding: ActorBinding, profile: RenderProfile) {
  await Promise.all([
    // Material and face index are an atomic pair. Never replay a frame against a
    // different texture atlas; doing so previously corrupted the DS renderer.
    bridge.write16(binding.handleAddress + HANDLE_MAT_ENTRY, profile.matEntry),
    bridge.write16(binding.blActAddress + BLACT_GEOM_FLAGS, profile.geomFlags),
    bridge.write16(binding.blActAddress + BLACT_FACE_INDEX, profile.faceIndex),
    bridge.write16(binding.blActAddress + BLACT_MAT_FLAGS, profile.matFlags),
  ])
}

/**
 * Production White 2 multiplayer avatar bridge.
 *
 * A real game-created FieldActor owns the remote player lifecycle. PokéRun drives
 * its logical/continuous position and replays render states learned from the local
 * protagonist onto that dedicated actor. No map NPC is borrowed. The remote
 * billboard mirrors the local protagonist's native BlAct-Y minus WPos-Y offset
 * instead of assuming those Y coordinates are identical.
 */
export function White2DedicatedTrainerRuntime({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const presenceRef = useRef<MultiplayerPresenceSnapshot>({ local: null, remote: null })

  useEffect(() => multiplayerPresence.subscribe(snapshot => {
    presenceRef.current = snapshot
  }), [])

  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return
    const runtimeBridge = bridge
    const nativeActors = new White2NativeActorBridge(runtimeBridge, rom)

    let cancelled = false
    let ownsActor = false
    let nativeStateUnsafe = false
    let binding: DedicatedBinding | null = null
    let playerBinding: ActorBinding | null = null
    let playerModelId: number | null = null
    let cacheStorageKey: string | null = null
    let lastCacheSave = 0
    let lastLearnAt = 0

    let lastPlayerX: number | null = null
    let lastPlayerZ: number | null = null
    let lastPlayerSampleAt = 0
    let playerBillboardYOffset = 0
    let playerMovingUntil = 0
    let playerMotionKind: MotionKind = 'walk'
    let activePlayerMotionDirection: Direction | null = null
    let activePlayerMotionKind: MotionKind | null = null
    let lastPlayerDirection: Direction | null = null
    let lastPlayerMoving = false
    let activeTurnCapture: TurnCapture | null = null

    let lastRemoteWorld: MultiplayerWorldPosition | null = null
    let lastRemoteWorldAt = 0
    let renderedWorld: MultiplayerWorldPosition | null = null
    let remoteMovingUntil = 0
    let remoteMotionKind: MotionKind = 'walk'
    let activeRemoteDirection: Direction | null = null
    let activeRemoteMotionKind: MotionKind | null = null
    let remoteSequenceIndex = 0
    let remoteStepStartedAt = 0
    let remoteWasMoving = false
    let remoteTurn: RemoteTurnPlayback | null = null
    let latestRemoteProfile: RenderProfile | null = null

    let stableMapId: MultiplayerPlayerState['location']['mapId'] | null = null
    let stableMapSince = 0
    let lastCompletePresenceAt = 0
    let rangeLatched = false
    let reacquireAfter = 0
    let lastError = ''
    let unavailableSince = 0
    let unavailableReported = false

    let knowledge = emptyKnowledge()
    let turns = new Map<TurnKey, RenderSequenceStep[]>()

    function finishTurnCapture() {
      const capture = activeTurnCapture
      activeTurnCapture = null
      if (!capture || capture.sequence.length === 0) return
      const distinctProfiles = new Set(capture.sequence.map(profileKey)).size
      if (distinctProfiles < 2) return
      const existing = turns.get(capture.key)
      if (!existing || sequenceDuration(capture.sequence) > sequenceDuration(existing)) {
        turns.set(capture.key, capture.sequence.map(step => ({ ...step })))
      }
    }

    function finalizeActivePlayerMotion() {
      if (!activePlayerMotionDirection || !activePlayerMotionKind) return
      finalizeMotion(knowledge[activePlayerMotionDirection], activePlayerMotionKind)
      activePlayerMotionDirection = null
      activePlayerMotionKind = null
    }

    function resetPlayerBinding() {
      playerBinding = null
      lastPlayerX = null
      lastPlayerZ = null
      lastPlayerSampleAt = 0
      playerBillboardYOffset = 0
      playerMovingUntil = 0
      playerMotionKind = 'walk'
      finalizeActivePlayerMotion()
      finishTurnCapture()
      lastPlayerDirection = null
      lastPlayerMoving = false
    }

    function resetRemoteAnimation() {
      lastRemoteWorld = null
      lastRemoteWorldAt = 0
      renderedWorld = null
      remoteMovingUntil = 0
      remoteMotionKind = 'walk'
      activeRemoteDirection = null
      activeRemoteMotionKind = null
      remoteSequenceIndex = 0
      remoteStepStartedAt = 0
      remoteWasMoving = false
      remoteTurn = null
      latestRemoteProfile = null
    }

    async function ensurePlayerBinding() {
      if (playerBinding && await bindingStillValid(runtimeBridge, playerBinding)) return playerBinding
      resetPlayerBinding()
      const scan = await new White2ActorSystemProbe(runtimeBridge).scanHeap()
      const player = scan.entries.find(entry => entry.state === 'player')
      if (!player || player.uid !== PLAYER_UID) throw new White2ActorSystemUnavailableError('Live White 2 player actor was not found for render learning.')
      playerBinding = await resolveActorBinding(runtimeBridge, player.address, PLAYER_UID)

      if (playerModelId !== player.modelId) {
        if (cacheStorageKey) saveCachedKnowledge(cacheStorageKey, knowledge, turns)
        playerModelId = player.modelId
        cacheStorageKey = cacheKey(rom, playerModelId)
        knowledge = emptyKnowledge()
        turns = new Map<TurnKey, RenderSequenceStep[]>()
        loadCachedKnowledge(cacheStorageKey, knowledge, turns)
      }
      return playerBinding
    }

    async function learnLocalRender(now: number) {
      const current = await ensurePlayerBinding()
      const [faceDir, x, worldY, billboardY, z, profile] = await Promise.all([
        runtimeBridge.read16(current.actorAddress + ACTOR_FACE_DIR),
        runtimeBridge.read32(current.actorAddress + ACTOR_WPOS + 0x00),
        runtimeBridge.read32(current.actorAddress + ACTOR_WPOS + 0x04),
        runtimeBridge.read32(current.blActAddress + BLACT_POSITION + 0x04),
        runtimeBridge.read32(current.actorAddress + ACTOR_WPOS + 0x08),
        readRenderProfile(runtimeBridge, current),
      ])

      playerBillboardYOffset = signed32(billboardY) - signed32(worldY)
      if (lastPlayerX !== null && lastPlayerZ !== null && lastPlayerSampleAt > 0 && (x !== lastPlayerX || z !== lastPlayerZ)) {
        const velocity = Math.hypot(signed32(x) - signed32(lastPlayerX), signed32(z) - signed32(lastPlayerZ)) / Math.max(1, now - lastPlayerSampleAt)
        playerMotionKind = motionKindForVelocity(velocity)
        playerMovingUntil = now + MOVING_HOLD_MS
      }
      lastPlayerX = x
      lastPlayerZ = z
      lastPlayerSampleAt = now

      const direction = DIRECTION_BY_FIELD_FACE[faceDir]
      if (!direction) return
      const moving = now < playerMovingUntil

      if (activeTurnCapture) {
        if (moving || now - activeTurnCapture.startedAt >= TURN_CAPTURE_MS) {
          finishTurnCapture()
        } else {
          if (hasStableGeometry(knowledge[direction], profile)) appendStep(activeTurnCapture.sequence, profile)
          lastPlayerDirection = direction
          lastPlayerMoving = moving
          return
        }
      }

      if (lastPlayerDirection && direction !== lastPlayerDirection && !moving && !lastPlayerMoving) {
        finalizeActivePlayerMotion()
        activeTurnCapture = { key: turnKey(lastPlayerDirection, direction), startedAt: now, sequence: [] }
        if (hasStableGeometry(knowledge[direction], profile)) appendStep(activeTurnCapture.sequence, profile)
        lastPlayerDirection = direction
        lastPlayerMoving = moving
        return
      }

      const directionKnowledge = knowledge[direction]
      if (moving) {
        if (activePlayerMotionDirection !== direction || activePlayerMotionKind !== playerMotionKind) {
          finalizeActivePlayerMotion()
          activePlayerMotionDirection = direction
          activePlayerMotionKind = playerMotionKind
        }
        if (hasStableGeometry(directionKnowledge, profile)) appendStep(directionKnowledge.currentSequence, profile)
      } else {
        finalizeActivePlayerMotion()
        observeIdle(directionKnowledge, profile)
      }

      lastPlayerDirection = direction
      lastPlayerMoving = moving

      if (cacheStorageKey && now - lastCacheSave >= 2000) {
        lastCacheSave = now
        saveCachedKnowledge(cacheStorageKey, knowledge, turns)
      }
    }

    function remoteProfile(now: number, remote: MultiplayerPlayerState) {
      const remoteWorld = remote.worldPosition
      if (!remoteWorld) return null

      if (worldChanged(lastRemoteWorld, remoteWorld)) {
        if (lastRemoteWorld && lastRemoteWorldAt > 0) {
          const velocity = motionVelocity(lastRemoteWorld, remoteWorld, now - lastRemoteWorldAt)
          if (velocity > 0) remoteMotionKind = motionKindForVelocity(velocity)
        }
        lastRemoteWorld = { ...remoteWorld }
        lastRemoteWorldAt = now
        remoteMovingUntil = now + MOVING_HOLD_MS
      }
      const moving = remote.movementState === 'moving'
        ? true
        : remote.movementState === 'idle'
          ? false
          : now < remoteMovingUntil

      if (activeRemoteDirection === null) {
        activeRemoteDirection = remote.direction
        remoteSequenceIndex = 0
        remoteStepStartedAt = now
      } else if (activeRemoteDirection !== remote.direction) {
        const previousDirection = activeRemoteDirection
        activeRemoteDirection = remote.direction
        activeRemoteMotionKind = null
        remoteSequenceIndex = 0
        remoteStepStartedAt = now
        remoteWasMoving = false
        const sequence = !moving ? turns.get(turnKey(previousDirection, remote.direction)) : null
        remoteTurn = sequence?.length ? { sequence, index: 0, stepStartedAt: now } : null
      }

      if (moving) remoteTurn = null

      if (remoteTurn) {
        let safety = remoteTurn.sequence.length + 1
        while (safety > 0 && now - remoteTurn.stepStartedAt >= remoteTurn.sequence[remoteTurn.index].holdMs) {
          remoteTurn.stepStartedAt += remoteTurn.sequence[remoteTurn.index].holdMs
          if (remoteTurn.index >= remoteTurn.sequence.length - 1) {
            remoteTurn = null
            break
          }
          remoteTurn.index += 1
          safety -= 1
        }
        if (remoteTurn) return remoteTurn.sequence[remoteTurn.index]
      }

      const directionKnowledge = knowledge[remote.direction]
      const requestedMotionKind = remoteMotionKind
      const fallbackWalkSequence = directionKnowledge.walkSequence.length
        ? directionKnowledge.walkSequence
        : bootstrapWalkSequence(knowledge, remote.direction)
      const sequence = requestedMotionKind === 'run'
        ? (directionKnowledge.runSequence.length ? directionKnowledge.runSequence : fallbackWalkSequence)
        : fallbackWalkSequence

      if (moving && sequence.length) {
        if (!remoteWasMoving || activeRemoteMotionKind !== requestedMotionKind) {
          remoteSequenceIndex = 0
          remoteStepStartedAt = now
        }
        activeRemoteMotionKind = requestedMotionKind
        let safety = sequence.length + 1
        while (safety > 0 && now - remoteStepStartedAt >= sequence[remoteSequenceIndex].holdMs) {
          remoteStepStartedAt += sequence[remoteSequenceIndex].holdMs
          remoteSequenceIndex = (remoteSequenceIndex + 1) % sequence.length
          safety -= 1
        }
        remoteWasMoving = true
        return sequence[remoteSequenceIndex]
      }

      if (!moving) {
        remoteWasMoving = false
        activeRemoteMotionKind = null
      }
      return directionKnowledge.idle ?? bootstrapIdleProfile(knowledge, remote.direction) ?? null
    }

    function applyRemoteFrame(current: DedicatedBinding, remote: MultiplayerPlayerState, world: MultiplayerWorldPosition, profile: RenderProfile | null) {
      const billboardY = (signed32(world.y) + playerBillboardYOffset) >>> 0
      const writes: Promise<void>[] = [
        runtimeBridge.write16(current.actorAddress + ACTOR_FACE_DIR, FIELD_FACE_BY_DIRECTION[remote.direction]),
        runtimeBridge.write16(current.actorAddress + ACTOR_GPOS + 0x00, remote.x),
        runtimeBridge.write16(current.actorAddress + ACTOR_GPOS + 0x04, remote.y),
        runtimeBridge.write32(current.actorAddress + ACTOR_WPOS + 0x00, world.x >>> 0),
        runtimeBridge.write32(current.actorAddress + ACTOR_WPOS + 0x04, world.y >>> 0),
        runtimeBridge.write32(current.actorAddress + ACTOR_WPOS + 0x08, world.z >>> 0),
        runtimeBridge.write32(current.blActAddress + BLACT_POSITION + 0x00, world.x >>> 0),
        runtimeBridge.write32(current.blActAddress + BLACT_POSITION + 0x04, billboardY),
        runtimeBridge.write32(current.blActAddress + BLACT_POSITION + 0x08, world.z >>> 0),
      ]
      if (profile) writes.push(writeRenderProfile(runtimeBridge, current, profile))
      return Promise.all(writes).then(() => undefined)
    }

    const unsubscribeEmulatedFrame = runtimeBridge.subscribeEmulatedFrame(() => {
      if (cancelled || nativeStateUnsafe || runtimeBridge.status !== 'running') return
      const current = binding
      const local = presenceRef.current.local
      const remote = presenceRef.current.remote
      const world = renderedWorld
      if (!current || !local || !remote || !world || local.location.mapId !== remote.location.mapId) return
      void applyRemoteFrame(current, remote, world, latestRemoteProfile)
    })

    async function releaseActor(cooldown = true) {
      const current = binding
      const hadActor = ownsActor || current !== null
      if (!hadActor) return
      // Keep ownership until deletion succeeds. A zero GameData pointer during
      // a transition means cleanup cannot run yet, not that our actor vanished.
      if (current) {
        const liveSystem = await new White2ActorSystemProbe(runtimeBridge).inspect()
        if (liveSystem.actorSystem !== current.actorSystem) {
          binding = null
          ownsActor = false
          resetRemoteAnimation()
          return
        }
      }
      if (current && await bindingStillValid(runtimeBridge, current)) {
        await writeRenderProfile(runtimeBridge, current, current.nativeRender)
      }
      await nativeActors.deleteTestActor()
      binding = null
      ownsActor = false
      resetRemoteAnimation()
      if (cooldown) reacquireAfter = Math.max(reacquireAfter, Date.now() + REACQUIRE_COOLDOWN_MS)
    }

    async function ensureActor(remote: MultiplayerPlayerState) {
      if (binding) {
        if (await bindingStillValid(runtimeBridge, binding)) return binding
        await releaseActor()
        return null
      }
      if (ownsActor) {
        await releaseActor()
        return null
      }
      resetRemoteAnimation()
      if (Date.now() < reacquireAfter) return null

      const spawned = await nativeActors.spawnTestActor()
      ownsActor = true
      if (cancelled) {
        await releaseActor(false)
        return null
      }
      try {
        const rawBinding = await resolveActorBinding(runtimeBridge, spawned.actorAddress, POKERUN_NATIVE_TEST_UID)
        const next: DedicatedBinding = { ...rawBinding, nativeRender: await readRenderProfile(runtimeBridge, rawBinding) }

        // The BlAct billboard owns its own face animation independently of the
        // FieldActor movement system. White 2's scene-node update repeatedly
        // enables that animation, which can overwrite PokéRun's faceIndex for
        // one rendered frame. Detach the native animation set entirely; the
        // dedicated remote's frames are driven exclusively by PokéRun.
        await Promise.all([
          runtimeBridge.write32(next.handleAddress + HANDLE_ANIMS, 0),
          runtimeBridge.write16(next.handleAddress + HANDLE_ANIM_COUNT, 0),
          runtimeBridge.write16(next.handleAddress + HANDLE_ANIM, 0),
          runtimeBridge.write16(next.handleAddress + HANDLE_STEP, 0),
          runtimeBridge.write16(next.handleAddress + HANDLE_WAIT, 0),
          runtimeBridge.write16(next.handleAddress + HANDLE_LOOPS, 0),
          runtimeBridge.write32(next.handleAddress + HANDLE_ANIMATE, 0),
        ])

        const world = remote.worldPosition
        if (!world) {
          await releaseActor()
          return null
        }
        const initialProfile = remoteProfile(Date.now(), remote)
        latestRemoteProfile = initialProfile
        await applyRemoteFrame(next, remote, world, initialProfile)
        renderedWorld = { ...world }
        binding = next
        return next
      } catch (error) {
        if (error instanceof White2NativeActorUnsafeStateError) throw error
        await releaseActor()
        throw error
      }
    }

    async function tick() {
      const now = Date.now()
      if (now - lastLearnAt >= LEARN_SAMPLE_MS) {
        lastLearnAt = now
        await learnLocalRender(now)
      }

      const presence = presenceRef.current
      const local = presence.local
      const remote = presence.remote

      if (!local?.worldPosition || !remote?.worldPosition) {
        if (ownsActor && now - lastCompletePresenceAt > MISSING_STATE_GRACE_MS) {
          rangeLatched = false
          stableMapId = null
          stableMapSince = 0
          await releaseActor()
        }
        return
      }
      lastCompletePresenceAt = now

      if (local.location.mapId !== remote.location.mapId) {
        rangeLatched = false
        stableMapId = null
        stableMapSince = 0
        await releaseActor()
        return
      }

      const currentMapId = local.location.mapId
      if (stableMapId !== currentMapId) {
        stableMapId = currentMapId
        stableMapSince = now
        rangeLatched = false
        resetPlayerBinding()
        await releaseActor()
        return
      }

      if (now - stableMapSince < MAP_STABLE_MS) {
        await releaseActor(false)
        return
      }

      const dx = Math.abs(remote.x - local.x)
      const dy = Math.abs(remote.y - local.y)

      // Distance only gates the initial spawn. Once this map owns a dedicated
      // remote FieldActor, keep it alive and let White 2 handle off-camera culling.
      // Deleting/recreating the actor on distance transitions corrupts its renderer.
      if (!rangeLatched) {
        if (dx > ENTER_REMOTE_DX || dy > ENTER_REMOTE_DY) return
        rangeLatched = true
      }

      const current = await ensureActor(remote)
      if (!current) return
      const profile = remoteProfile(now, remote)
      const targetWorld = remote.worldPosition
      renderedWorld = renderedWorld ? {
        x: smoothFx32(renderedWorld.x, targetWorld.x),
        y: targetWorld.y,
        z: smoothFx32(renderedWorld.z, targetWorld.z),
      } : { ...targetWorld }
      const world = renderedWorld
      latestRemoteProfile = profile
      await applyRemoteFrame(current, remote, world, profile)
    }

    async function run() {
      while (!cancelled) {
        try {
          if (runtimeBridge.status === 'running') {
            await tick()
            lastError = ''
            unavailableSince = 0
            unavailableReported = false
          }
        } catch (reason) {
          if (reason instanceof White2ActorSystemUnavailableError) {
            unavailableSince ||= Date.now()
            if (!unavailableReported && Date.now() - unavailableSince >= 3000) {
              unavailableReported = true
              console.warn('White 2 dedicated trainer runtime is waiting for field actor initialization:', reason)
            }
            await delay(200)
            continue
          }
          if (reason instanceof White2NativeActorUnsafeStateError) {
            nativeStateUnsafe = true
            console.warn('White 2 dedicated trainer runtime stopped native calls:', reason)
            break
          }
          rangeLatched = false
          stableMapId = null
          stableMapSince = 0
          resetPlayerBinding()
          try {
            await releaseActor()
          } catch (cleanupError) {
            if (cleanupError instanceof White2ActorSystemUnavailableError) {
              await delay(200)
              continue
            }
            nativeStateUnsafe = true
            console.warn('White 2 dedicated trainer runtime stopped after actor cleanup failed:', cleanupError)
            break
          }
          const message = reason instanceof Error ? reason.message : String(reason)
          if (message !== lastError) {
            lastError = message
            console.warn('White 2 dedicated trainer runtime paused:', reason)
          }
          await delay(200)
        }
        await delay(UPDATE_MS)
      }
    }

    void run()
    return () => {
      cancelled = true
      unsubscribeEmulatedFrame()
      finishTurnCapture()
      finalizeActivePlayerMotion()
      if (cacheStorageKey) saveCachedKnowledge(cacheStorageKey, knowledge, turns)
      if (!nativeStateUnsafe && runtimeBridge.status === 'running') void releaseActor(false).catch(() => undefined)
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
