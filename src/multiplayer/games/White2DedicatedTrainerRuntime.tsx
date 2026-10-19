import { useEffect, useRef } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerPlayerState, MultiplayerRomIdentity, MultiplayerWorldPosition } from '../core/protocol'
import { POKERUN_NATIVE_TEST_UID, White2NativeActorBridge } from './White2NativeActor'
import { White2ActorSystemProbe } from './White2ActorSystem'

const ACTOR_UID = 0x08
const ACTOR_MODEL_ID = 0x0c
const ACTOR_FACE_DIR = 0x18
const ACTOR_GPOS = 0x3c
const ACTOR_WPOS = 0x44
const ACTOR_SYSTEM_BACKPTR = 0x88
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
const PLAYER_UID = 0x00ff
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000

const UPDATE_MS = 20
const LEARN_SAMPLE_MS = 40
const MOVING_HOLD_MS = 120
const ENTER_REMOTE_DX = 6
const ENTER_REMOTE_DY = 4
const EXIT_REMOTE_DX = 7
const EXIT_REMOTE_DY = 5
const MAP_STABLE_MS = 280
const MISSING_STATE_GRACE_MS = 160
const REACQUIRE_COOLDOWN_MS = 250
const BIND_TIMEOUT_MS = 1800
const TURN_CAPTURE_MS = 240
const MAX_STEP_HOLD_MS = 250
const SMOOTHING_ALPHA = 0.72
const SMOOTHING_SNAP_FX32 = 16 * 4096
const SMOOTHING_EPSILON_FX32 = 64
// V3 rejects doorway/clipping-only renderer geometry from reusable walk/turn animation knowledge.
const CACHE_VERSION = 3

const FIELD_FACE_BY_DIRECTION = { north: 0, south: 1, west: 2, east: 3 } as const
const DIRECTION_BY_FIELD_FACE: Partial<Record<number, MultiplayerPlayerState['direction']>> = {
  0: 'north',
  1: 'south',
  2: 'west',
  3: 'east',
}
const DIRECTIONS: MultiplayerPlayerState['direction'][] = ['north', 'south', 'west', 'east']

type Direction = MultiplayerPlayerState['direction']
type TurnKey = `${Direction}->${Direction}`

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
  movingSequence: RenderSequenceStep[]
  currentRun: RenderSequenceStep[]
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

type CachedRenderProfile = {
  version: number
  directions: Record<Direction, { idle: RenderProfile | null; movingSequence: RenderSequenceStep[] }>
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
    movingSequence: [],
    currentRun: [],
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

function finalizeRun(knowledge: DirectionKnowledge) {
  if (knowledge.currentRun.length > knowledge.movingSequence.length) {
    knowledge.movingSequence = knowledge.currentRun.map(step => ({ ...step }))
  }
  knowledge.currentRun = []
}

function observeIdle(knowledge: DirectionKnowledge, profile: RenderProfile) {
  const key = profileKey(profile)
  const current = knowledge.idleCounts.get(key)
  if (current) current.count += 1
  else knowledge.idleCounts.set(key, { count: 1, profile: { ...profile } })
  knowledge.idle = [...knowledge.idleCounts.values()].sort((a, b) => b.count - a.count)[0]?.profile ?? knowledge.idle
}

function hasStableGeometry(knowledge: DirectionKnowledge, profile: RenderProfile) {
  const idle = knowledge.idle
  if (!idle) return true
  return profile.geomFlags === idle.geomFlags && profile.matFlags === idle.matFlags
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
      knowledge[direction].idle = saved.idle ?? null
      knowledge[direction].movingSequence = Array.isArray(saved.movingSequence) ? saved.movingSequence : []
      if (saved.idle) knowledge[direction].idleCounts.set(profileKey(saved.idle), { count: 1, profile: saved.idle })
    }
    for (const [keyValue, sequence] of Object.entries(cached.turns ?? {})) {
      if (Array.isArray(sequence)) turns.set(keyValue as TurnKey, sequence)
    }
  } catch {
    // Cache is optional. Live learning will rebuild it.
  }
}

function saveCachedKnowledge(key: string, knowledge: Record<Direction, DirectionKnowledge>, turns: Map<TurnKey, RenderSequenceStep[]>) {
  try {
    const directions = Object.fromEntries(DIRECTIONS.map(direction => [direction, {
      idle: knowledge[direction].idle,
      movingSequence: knowledge[direction].movingSequence,
    }])) as CachedRenderProfile['directions']
    const savedTurns = Object.fromEntries([...turns.entries()].map(([keyValue, sequence]) => [keyValue, sequence.map(step => ({ ...step }))]))
    localStorage.setItem(key, JSON.stringify({ version: CACHE_VERSION, directions, turns: savedTurns } satisfies CachedRenderProfile))
  } catch {
    // Multiplayer continues if localStorage is unavailable.
  }
}

async function getNativeBlActIndex(bridge: MelonDsBridge, actorAddress: number) {
  const call = await bridge.callArm9Thumb4(FLDACT_GET_BLACT_IDX, actorAddress, 0, 0, 0, NATIVE_STACK_RESERVE)
  if (call.status !== 1) throw new Error(`FldAct_GetBlActIdx native call failed with status ${call.status}.`)
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
 * protagonist onto that dedicated actor. No map NPC is borrowed. BlAct X/Y/Z is
 * kept aligned with the replicated WPos so scripted vertical doorway movement
 * cannot leave the billboard at a stale game-owned height.
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
    let binding: DedicatedBinding | null = null
    let playerBinding: ActorBinding | null = null
    let playerModelId: number | null = null
    let cacheStorageKey: string | null = null
    let lastCacheSave = 0
    let lastLearnAt = 0

    let lastPlayerX: number | null = null
    let lastPlayerZ: number | null = null
    let playerMovingUntil = 0
    let activePlayerRunDirection: Direction | null = null
    let lastPlayerDirection: Direction | null = null
    let lastPlayerMoving = false
    let activeTurnCapture: TurnCapture | null = null

    let lastRemoteWorld: MultiplayerWorldPosition | null = null
    let renderedWorld: MultiplayerWorldPosition | null = null
    let remoteMovingUntil = 0
    let activeRemoteDirection: Direction | null = null
    let remoteSequenceIndex = 0
    let remoteStepStartedAt = 0
    let remoteWasMoving = false
    let remoteTurn: RemoteTurnPlayback | null = null

    let stableMapId: MultiplayerPlayerState['location']['mapId'] | null = null
    let stableMapSince = 0
    let lastCompletePresenceAt = 0
    let rangeLatched = false
    let reacquireAfter = 0
    let lastError = ''

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

    function finalizeActivePlayerRun() {
      if (!activePlayerRunDirection) return
      finalizeRun(knowledge[activePlayerRunDirection])
      activePlayerRunDirection = null
    }

    function resetPlayerBinding() {
      playerBinding = null
      lastPlayerX = null
      lastPlayerZ = null
      playerMovingUntil = 0
      finalizeActivePlayerRun()
      finishTurnCapture()
      lastPlayerDirection = null
      lastPlayerMoving = false
    }

    function resetRemoteAnimation() {
      lastRemoteWorld = null
      renderedWorld = null
      remoteMovingUntil = 0
      activeRemoteDirection = null
      remoteSequenceIndex = 0
      remoteStepStartedAt = 0
      remoteWasMoving = false
      remoteTurn = null
    }

    async function ensurePlayerBinding() {
      if (playerBinding && await bindingStillValid(runtimeBridge, playerBinding)) return playerBinding
      resetPlayerBinding()
      const scan = await new White2ActorSystemProbe(runtimeBridge).scanHeap()
      const player = scan.entries.find(entry => entry.state === 'player')
      if (!player || player.uid !== PLAYER_UID) throw new Error('Live White 2 player actor was not found for render learning.')
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
      const [faceDir, x, z, profile] = await Promise.all([
        runtimeBridge.read16(current.actorAddress + ACTOR_FACE_DIR),
        runtimeBridge.read32(current.actorAddress + ACTOR_WPOS + 0x00),
        runtimeBridge.read32(current.actorAddress + ACTOR_WPOS + 0x08),
        readRenderProfile(runtimeBridge, current),
      ])

      if (lastPlayerX !== null && (x !== lastPlayerX || z !== lastPlayerZ)) playerMovingUntil = now + MOVING_HOLD_MS
      lastPlayerX = x
      lastPlayerZ = z

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
        finalizeActivePlayerRun()
        activeTurnCapture = { key: turnKey(lastPlayerDirection, direction), startedAt: now, sequence: [] }
        if (hasStableGeometry(knowledge[direction], profile)) appendStep(activeTurnCapture.sequence, profile)
        lastPlayerDirection = direction
        lastPlayerMoving = moving
        return
      }

      const directionKnowledge = knowledge[direction]
      if (moving) {
        if (activePlayerRunDirection !== direction) {
          finalizeActivePlayerRun()
          activePlayerRunDirection = direction
        }
        if (hasStableGeometry(directionKnowledge, profile)) appendStep(directionKnowledge.currentRun, profile)
      } else {
        finalizeActivePlayerRun()
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
        lastRemoteWorld = { ...remoteWorld }
        remoteMovingUntil = now + MOVING_HOLD_MS
      }
      const moving = now < remoteMovingUntil

      if (activeRemoteDirection === null) {
        activeRemoteDirection = remote.direction
        remoteSequenceIndex = 0
        remoteStepStartedAt = now
      } else if (activeRemoteDirection !== remote.direction) {
        const previousDirection = activeRemoteDirection
        activeRemoteDirection = remote.direction
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
      if (moving && directionKnowledge.movingSequence.length) {
        if (!remoteWasMoving) {
          remoteSequenceIndex = 0
          remoteStepStartedAt = now
        }
        const sequence = directionKnowledge.movingSequence
        let safety = sequence.length + 1
        while (safety > 0 && now - remoteStepStartedAt >= sequence[remoteSequenceIndex].holdMs) {
          remoteStepStartedAt += sequence[remoteSequenceIndex].holdMs
          remoteSequenceIndex = (remoteSequenceIndex + 1) % sequence.length
          safety -= 1
        }
        remoteWasMoving = true
        return sequence[remoteSequenceIndex]
      }

      if (!moving) remoteWasMoving = false
      return directionKnowledge.idle ?? directionKnowledge.movingSequence[0] ?? null
    }

    async function releaseActor(cooldown = true) {
      const current = binding
      const hadActor = ownsActor || current !== null
      binding = null
      ownsActor = false
      resetRemoteAnimation()
      if (!hadActor) return
      if (cooldown) reacquireAfter = Math.max(reacquireAfter, Date.now() + REACQUIRE_COOLDOWN_MS)
      try {
        // Put the owned actor back onto its native model-11 material before
        // White 2 deletes it, so native renderer/resource teardown sees the
        // material relationship it created rather than our protagonist override.
        if (current && await bindingStillValid(runtimeBridge, current)) {
          await writeRenderProfile(runtimeBridge, current, current.nativeRender)
        }
        await nativeActors.deleteTestActor()
      } catch {
        // A map transition may already have destroyed the old actor system.
      }
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
      try {
        const rawBinding = await resolveActorBinding(runtimeBridge, spawned.actorAddress, POKERUN_NATIVE_TEST_UID)
        const next: DedicatedBinding = { ...rawBinding, nativeRender: await readRenderProfile(runtimeBridge, rawBinding) }
        const world = remote.worldPosition
        if (!world) {
          await releaseActor()
          return null
        }
        await Promise.all([
          runtimeBridge.write16(next.actorAddress + ACTOR_FACE_DIR, FIELD_FACE_BY_DIRECTION[remote.direction]),
          runtimeBridge.write16(next.actorAddress + ACTOR_GPOS + 0x00, remote.x),
          runtimeBridge.write16(next.actorAddress + ACTOR_GPOS + 0x04, remote.y),
          runtimeBridge.write32(next.actorAddress + ACTOR_WPOS + 0x00, world.x >>> 0),
          runtimeBridge.write32(next.actorAddress + ACTOR_WPOS + 0x04, world.y >>> 0),
          runtimeBridge.write32(next.actorAddress + ACTOR_WPOS + 0x08, world.z >>> 0),
          runtimeBridge.write32(next.blActAddress + BLACT_POSITION + 0x00, world.x >>> 0),
          runtimeBridge.write32(next.blActAddress + BLACT_POSITION + 0x04, world.y >>> 0),
          runtimeBridge.write32(next.blActAddress + BLACT_POSITION + 0x08, world.z >>> 0),
        ])
        renderedWorld = { ...world }
        binding = next
        return next
      } catch (error) {
        await releaseActor().catch(() => undefined)
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
      if (rangeLatched) {
        if (dx > EXIT_REMOTE_DX || dy > EXIT_REMOTE_DY) rangeLatched = false
      } else if (dx <= ENTER_REMOTE_DX && dy <= ENTER_REMOTE_DY) {
        rangeLatched = true
      }

      if (!rangeLatched) {
        await releaseActor()
        return
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

      const writes: Promise<void>[] = [
        runtimeBridge.write16(current.actorAddress + ACTOR_FACE_DIR, FIELD_FACE_BY_DIRECTION[remote.direction]),
        runtimeBridge.write16(current.actorAddress + ACTOR_GPOS + 0x00, remote.x),
        runtimeBridge.write16(current.actorAddress + ACTOR_GPOS + 0x04, remote.y),
        runtimeBridge.write32(current.actorAddress + ACTOR_WPOS + 0x00, world.x >>> 0),
        runtimeBridge.write32(current.actorAddress + ACTOR_WPOS + 0x04, world.y >>> 0),
        runtimeBridge.write32(current.actorAddress + ACTOR_WPOS + 0x08, world.z >>> 0),
        // Keep the native billboard aligned on all three axes. White 2's doorway
        // scripts can change vertical render position while the actor slow-walks.
        runtimeBridge.write32(current.blActAddress + BLACT_POSITION + 0x00, world.x >>> 0),
        runtimeBridge.write32(current.blActAddress + BLACT_POSITION + 0x04, world.y >>> 0),
        runtimeBridge.write32(current.blActAddress + BLACT_POSITION + 0x08, world.z >>> 0),
      ]
      await Promise.all(writes)
      if (profile) await writeRenderProfile(runtimeBridge, current, profile)
    }

    async function run() {
      while (!cancelled) {
        try {
          if (runtimeBridge.status === 'running') {
            await tick()
            lastError = ''
          }
        } catch (reason) {
          rangeLatched = false
          stableMapId = null
          stableMapSince = 0
          resetPlayerBinding()
          await releaseActor()
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
      finishTurnCapture()
      finalizeActivePlayerRun()
      if (cacheStorageKey) saveCachedKnowledge(cacheStorageKey, knowledge, turns)
      if (runtimeBridge.status === 'running') void releaseActor(false)
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
