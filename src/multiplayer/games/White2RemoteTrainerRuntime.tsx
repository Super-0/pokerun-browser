import { useEffect, useRef } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerPlayerState, MultiplayerRomIdentity, MultiplayerWorldPosition } from '../core/protocol'
import { White2ActorSystemProbe, type White2ActorHeapEntry } from './White2ActorSystem'

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

const UPDATE_MS = 40
const MOVING_HOLD_MS = 120
const ENTER_REMOTE_DX = 6
const ENTER_REMOTE_DY = 4
const EXIT_REMOTE_DX = 7
const EXIT_REMOTE_DY = 5
const MAP_STABLE_MS = 280
const MISSING_STATE_GRACE_MS = 160
const REACQUIRE_COOLDOWN_MS = 250
const TURN_CAPTURE_MS = 240
const MAX_STEP_HOLD_MS = 250
const CACHE_VERSION = 1

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

type Binding = {
  actor: White2ActorHeapEntry
  blActIndex: number
  blActAddress: number
  handleIndex: number
  handleAddress: number
}

type RenderProfile = {
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

type OriginalNpcState = {
  uid: number
  modelId: number
  tcb: number
  faceDir: number
  wposX: number
  wposY: number
  wposZ: number
  blActX: number
  blActY: number
  blActZ: number
  matEntry: number
  geomFlags: number
  faceIndex: number
  matFlags: number
}

type BorrowedNpc = {
  binding: Binding
  original: OriginalNpcState
}

type CachedRenderProfile = {
  version: number
  directions: Record<Direction, { idle: RenderProfile | null; movingSequence: RenderSequenceStep[] }>
  turns?: Record<string, RenderSequenceStep[]>
}

function delay(ms: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms))
}

function signed32(value: number) {
  return value | 0
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 0x3) === 0
}

function chooseStandardNpc(entries: White2ActorHeapEntry[], player: White2ActorHeapEntry) {
  return entries
    .filter(entry => entry.state === 'active' && entry.uid !== SPECIAL_PLAYER_COMPANION_UID && entry.sceneNodeVTable === STANDARD_NPC_SCENE_VTABLE)
    .sort((a, b) => (Math.abs(a.x - player.x) + Math.abs(a.y - player.y)) - (Math.abs(b.x - player.x) + Math.abs(b.y - player.y)))[0]
}

function profileKey(profile: RenderProfile) {
  return `${profile.faceIndex}:${profile.geomFlags}:${profile.matFlags}`
}

function turnKey(from: Direction, to: Direction): TurnKey {
  return `${from}->${to}`
}

function emptyKnowledge(): Record<Direction, DirectionKnowledge> {
  return Object.fromEntries(DIRECTIONS.map(direction => [direction, {
    idle: null,
    idleCounts: new Map<string, { count: number; profile: RenderProfile }>(),
    movingSequence: [],
    currentRun: [],
  }])) as Record<Direction, DirectionKnowledge>
}

function appendStep(sequence: RenderSequenceStep[], profile: RenderProfile) {
  const previous = sequence[sequence.length - 1]
  if (previous && profileKey(previous) === profileKey(profile)) {
    previous.holdMs = Math.min(MAX_STEP_HOLD_MS, previous.holdMs + UPDATE_MS)
  } else {
    sequence.push({ ...profile, holdMs: UPDATE_MS })
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
    // Cache is an optimization only; ignore stale or malformed data.
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
    // Multiplayer keeps running even if localStorage is unavailable.
  }
}

async function resolveBinding(bridge: MelonDsBridge, entry: White2ActorHeapEntry, sceneActors: number, actorCount: number, actorHandles: number, handleCount: number): Promise<Binding> {
  const [wposX, wposY, wposZ] = await Promise.all([
    bridge.read32(entry.address + ACTOR_WPOS + 0x00),
    bridge.read32(entry.address + ACTOR_WPOS + 0x04),
    bridge.read32(entry.address + ACTOR_WPOS + 0x08),
  ])

  let bestIndex = -1
  let bestAddress = 0
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
      bestIndex = index
      bestAddress = address
    }
  }
  if (bestIndex < 0) throw new Error(`Could not resolve billboard actor for slot ${entry.index}.`)

  const matches: Array<{ index: number; address: number }> = []
  for (let index = 0; index < handleCount; index += 1) {
    const address = actorHandles + index * HANDLE_SIZE
    if ((await bridge.read32(address + HANDLE_BLACT_INDEX)) === bestIndex) matches.push({ index, address })
  }
  if (matches.length !== 1) throw new Error(`Expected one billboard handle for BlAct ${bestIndex}, found ${matches.length}.`)
  return { actor: entry, blActIndex: bestIndex, blActAddress: bestAddress, handleIndex: matches[0].index, handleAddress: matches[0].address }
}

async function prepareBindings(bridge: MelonDsBridge) {
  const scan = await new White2ActorSystemProbe(bridge).scanHeap()
  if (scan.suspiciousSlots.length) throw new Error('Remote trainer runtime blocked because suspicious actor slots are present.')
  const player = scan.entries.find(entry => entry.state === 'player')
  if (!player || player.uid !== PLAYER_UID) throw new Error('Live player actor was not found.')
  const npc = chooseStandardNpc(scan.entries, player)

  const fieldBlAct = await bridge.read32(scan.actorSystem + ACTOR_SYSTEM_FIELD_BLACT)
  if (!isMainRamPointer(fieldBlAct)) throw new Error('FieldBlAct pointer is invalid.')
  const blActSystem = await bridge.read32(fieldBlAct + FIELD_BLACT_SYSTEM)
  if (!isMainRamPointer(blActSystem)) throw new Error('BlActSystem pointer is invalid.')
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

  const playerBinding = await resolveBinding(bridge, player, sceneActors, actorCount, actorHandles, handleCount)
  const npcBinding = npc ? await resolveBinding(bridge, npc, sceneActors, actorCount, actorHandles, handleCount) : null
  return { playerBinding, npcBinding }
}

async function bindingIdentityMatches(bridge: MelonDsBridge, binding: Binding, uid: number, modelId: number, tcb: number) {
  const [uidNow, modelNow, tcbNow, owner] = await Promise.all([
    bridge.read16(binding.actor.address + ACTOR_UID),
    bridge.read16(binding.actor.address + ACTOR_MODEL_ID),
    bridge.read32(binding.actor.address + ACTOR_TCB),
    bridge.read32(binding.handleAddress + HANDLE_BLACT_INDEX),
  ])
  return uidNow === uid && modelNow === modelId && tcbNow === tcb && owner === binding.blActIndex
}

async function captureOriginalNpc(bridge: MelonDsBridge, binding: Binding): Promise<OriginalNpcState> {
  const [faceDir, wposX, wposY, wposZ, blActX, blActY, blActZ, matEntry, geomFlags, faceIndex, matFlags] = await Promise.all([
    bridge.read16(binding.actor.address + ACTOR_FACE_DIR),
    bridge.read32(binding.actor.address + ACTOR_WPOS + 0x00),
    bridge.read32(binding.actor.address + ACTOR_WPOS + 0x04),
    bridge.read32(binding.actor.address + ACTOR_WPOS + 0x08),
    bridge.read32(binding.blActAddress + BLACT_POSITION + 0x00),
    bridge.read32(binding.blActAddress + BLACT_POSITION + 0x04),
    bridge.read32(binding.blActAddress + BLACT_POSITION + 0x08),
    bridge.read16(binding.handleAddress + HANDLE_MAT_ENTRY),
    bridge.read16(binding.blActAddress + BLACT_GEOM_FLAGS),
    bridge.read16(binding.blActAddress + BLACT_FACE_INDEX),
    bridge.read16(binding.blActAddress + BLACT_MAT_FLAGS),
  ])
  return { uid: binding.actor.uid, modelId: binding.actor.modelId, tcb: binding.actor.tcb, faceDir, wposX, wposY, wposZ, blActX, blActY, blActZ, matEntry, geomFlags, faceIndex, matFlags }
}

async function restoreNpc(bridge: MelonDsBridge, borrowed: BorrowedNpc) {
  const { binding, original } = borrowed
  if (!(await bindingIdentityMatches(bridge, binding, original.uid, original.modelId, original.tcb))) return false
  await Promise.all([
    bridge.write16(binding.actor.address + ACTOR_FACE_DIR, original.faceDir),
    bridge.write32(binding.actor.address + ACTOR_WPOS + 0x00, original.wposX),
    bridge.write32(binding.actor.address + ACTOR_WPOS + 0x04, original.wposY),
    bridge.write32(binding.actor.address + ACTOR_WPOS + 0x08, original.wposZ),
    bridge.write32(binding.blActAddress + BLACT_POSITION + 0x00, original.blActX),
    bridge.write32(binding.blActAddress + BLACT_POSITION + 0x04, original.blActY),
    bridge.write32(binding.blActAddress + BLACT_POSITION + 0x08, original.blActZ),
    bridge.write16(binding.handleAddress + HANDLE_MAT_ENTRY, original.matEntry),
    bridge.write16(binding.blActAddress + BLACT_GEOM_FLAGS, original.geomFlags),
    bridge.write16(binding.blActAddress + BLACT_FACE_INDEX, original.faceIndex),
    bridge.write16(binding.blActAddress + BLACT_MAT_FLAGS, original.matFlags),
  ])
  return true
}

/**
 * Production White 2 multiplayer avatar bridge.
 *
 * V6.1 keeps the validated continuous WPos path, synchronizes FieldActor and
 * billboard horizontal position, learns turning-in-place render transitions, and
 * debounces map/range lifecycle churn. BlAct Y remains game-owned so native
 * vertical sprite/shadow animation is not flattened or re-applied every tick.
 * It still borrows one ordinary NPC as the renderer; a dedicated native actor
 * remains the next architecture milestone.
 */
export function White2RemoteTrainerRuntime({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const presenceRef = useRef<MultiplayerPresenceSnapshot>({ local: null, remote: null })

  useEffect(() => multiplayerPresence.subscribe(snapshot => {
    presenceRef.current = snapshot
  }), [])

  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return

    let cancelled = false
    let playerBinding: Binding | null = null
    let borrowed: BorrowedNpc | null = null
    let playerModelId: number | null = null
    let playerMatEntry: number | null = null
    let cacheStorageKey: string | null = null
    let lastCacheSave = 0

    let lastPlayerX: number | null = null
    let lastPlayerZ: number | null = null
    let playerMovingUntil = 0
    let activePlayerRunDirection: Direction | null = null
    let lastPlayerDirection: Direction | null = null
    let lastPlayerMoving = false
    let activeTurnCapture: TurnCapture | null = null

    let lastRemoteWorld: MultiplayerWorldPosition | null = null
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

    const knowledge = emptyKnowledge()
    const turns = new Map<TurnKey, RenderSequenceStep[]>()

    async function releaseBorrowed(cooldown = true) {
      const current = borrowed
      borrowed = null
      if (!current) return
      if (cooldown) reacquireAfter = Math.max(reacquireAfter, Date.now() + REACQUIRE_COOLDOWN_MS)
      try {
        await restoreNpc(bridge, current)
      } catch {
        // Map lifecycle may already have destroyed/replaced the borrowed actor.
      }
    }

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

    function resetPlayerBinding() {
      playerBinding = null
      lastPlayerX = null
      lastPlayerZ = null
      playerMovingUntil = 0
      activePlayerRunDirection = null
      lastPlayerDirection = null
      lastPlayerMoving = false
      finishTurnCapture()
      for (const direction of DIRECTIONS) finalizeRun(knowledge[direction])
    }

    function resetRemoteAnimation() {
      lastRemoteWorld = null
      remoteMovingUntil = 0
      activeRemoteDirection = null
      remoteSequenceIndex = 0
      remoteStepStartedAt = 0
      remoteWasMoving = false
      remoteTurn = null
    }

    async function ensurePlayerBinding() {
      if (playerBinding && await bindingIdentityMatches(bridge, playerBinding, PLAYER_UID, playerBinding.actor.modelId, playerBinding.actor.tcb)) return playerBinding
      resetPlayerBinding()
      const prepared = await prepareBindings(bridge)
      playerBinding = prepared.playerBinding
      if (playerModelId !== playerBinding.actor.modelId) {
        playerModelId = playerBinding.actor.modelId
        cacheStorageKey = cacheKey(rom, playerModelId)
        loadCachedKnowledge(cacheStorageKey, knowledge, turns)
      }
      return playerBinding
    }

    function finalizeActivePlayerRun() {
      if (!activePlayerRunDirection) return
      finalizeRun(knowledge[activePlayerRunDirection])
      activePlayerRunDirection = null
    }

    async function learnLocalRender(now: number) {
      const binding = await ensurePlayerBinding()
      const [faceDir, x, z, faceIndex, geomFlags, matFlags, matEntry] = await Promise.all([
        bridge.read16(binding.actor.address + ACTOR_FACE_DIR),
        bridge.read32(binding.actor.address + ACTOR_WPOS + 0x00),
        bridge.read32(binding.actor.address + ACTOR_WPOS + 0x08),
        bridge.read16(binding.blActAddress + BLACT_FACE_INDEX),
        bridge.read16(binding.blActAddress + BLACT_GEOM_FLAGS),
        bridge.read16(binding.blActAddress + BLACT_MAT_FLAGS),
        bridge.read16(binding.handleAddress + HANDLE_MAT_ENTRY),
      ])
      playerMatEntry = matEntry

      if (lastPlayerX !== null && (x !== lastPlayerX || z !== lastPlayerZ)) playerMovingUntil = now + MOVING_HOLD_MS
      lastPlayerX = x
      lastPlayerZ = z

      const direction = DIRECTION_BY_FIELD_FACE[faceDir]
      if (!direction) return
      const moving = now < playerMovingUntil
      const profile: RenderProfile = { faceIndex, geomFlags, matFlags }

      if (activeTurnCapture) {
        if (moving || now - activeTurnCapture.startedAt >= TURN_CAPTURE_MS) {
          finishTurnCapture()
        } else {
          appendStep(activeTurnCapture.sequence, profile)
          lastPlayerDirection = direction
          lastPlayerMoving = moving
          return
        }
      }

      if (lastPlayerDirection && direction !== lastPlayerDirection && !moving && !lastPlayerMoving) {
        finalizeActivePlayerRun()
        activeTurnCapture = { key: turnKey(lastPlayerDirection, direction), startedAt: now, sequence: [] }
        appendStep(activeTurnCapture.sequence, profile)
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
        appendStep(directionKnowledge.currentRun, profile)
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

    async function ensureBorrowed() {
      if (borrowed && await bindingIdentityMatches(bridge, borrowed.binding, borrowed.original.uid, borrowed.original.modelId, borrowed.original.tcb)) return borrowed
      borrowed = null
      const prepared = await prepareBindings(bridge)
      playerBinding = prepared.playerBinding
      if (!prepared.npcBinding) return null
      borrowed = { binding: prepared.npcBinding, original: await captureOriginalNpc(bridge, prepared.npcBinding) }
      return borrowed
    }

    async function tick() {
      const now = Date.now()
      await learnLocalRender(now)

      const presence = presenceRef.current
      const local = presence.local
      const remote = presence.remote

      if (!local?.worldPosition || !remote?.worldPosition) {
        if (borrowed && now - lastCompletePresenceAt > MISSING_STATE_GRACE_MS) {
          rangeLatched = false
          stableMapId = null
          stableMapSince = 0
          resetRemoteAnimation()
          await releaseBorrowed()
        }
        return
      }
      lastCompletePresenceAt = now

      if (local.location.mapId !== remote.location.mapId) {
        rangeLatched = false
        stableMapId = null
        stableMapSince = 0
        resetRemoteAnimation()
        await releaseBorrowed()
        return
      }

      const currentMapId = local.location.mapId
      if (stableMapId !== currentMapId) {
        stableMapId = currentMapId
        stableMapSince = now
        rangeLatched = false
        resetRemoteAnimation()
        await releaseBorrowed()
        return
      }

      if (now - stableMapSince < MAP_STABLE_MS) {
        await releaseBorrowed()
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
        resetRemoteAnimation()
        await releaseBorrowed()
        return
      }

      const profile = remoteProfile(now, remote)
      if (!profile || playerMatEntry === null) {
        await releaseBorrowed()
        return
      }

      if (!borrowed && now < reacquireAfter) return

      const proxy = await ensureBorrowed()
      if (!proxy) return
      const binding = proxy.binding
      const world = remote.worldPosition

      await Promise.all([
        bridge.write16(binding.actor.address + ACTOR_FACE_DIR, FIELD_FACE_BY_DIRECTION[remote.direction]),
        bridge.write32(binding.actor.address + ACTOR_WPOS + 0x00, world.x >>> 0),
        bridge.write32(binding.actor.address + ACTOR_WPOS + 0x04, world.y >>> 0),
        bridge.write32(binding.actor.address + ACTOR_WPOS + 0x08, world.z >>> 0),
        // Keep billboard X/Z in lock-step with WPos to prevent sprite/shadow lag.
        // BlAct Y is intentionally left to White 2's renderer/animation system.
        bridge.write32(binding.blActAddress + BLACT_POSITION + 0x00, world.x >>> 0),
        bridge.write32(binding.blActAddress + BLACT_POSITION + 0x08, world.z >>> 0),
        bridge.write16(binding.handleAddress + HANDLE_MAT_ENTRY, playerMatEntry),
        bridge.write16(binding.blActAddress + BLACT_GEOM_FLAGS, profile.geomFlags),
        bridge.write16(binding.blActAddress + BLACT_FACE_INDEX, profile.faceIndex),
        bridge.write16(binding.blActAddress + BLACT_MAT_FLAGS, profile.matFlags),
      ])
    }

    async function run() {
      while (!cancelled) {
        try {
          if (bridge.status === 'running') {
            await tick()
            lastError = ''
          } else if (borrowed) {
            rangeLatched = false
            resetRemoteAnimation()
            await releaseBorrowed()
          }
        } catch (reason) {
          rangeLatched = false
          stableMapId = null
          stableMapSince = 0
          resetRemoteAnimation()
          await releaseBorrowed()
          resetPlayerBinding()
          const message = reason instanceof Error ? reason.message : String(reason)
          if (message !== lastError) {
            lastError = message
            console.warn('White 2 remote trainer runtime paused:', reason)
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
      if (cacheStorageKey) saveCachedKnowledge(cacheStorageKey, knowledge, turns)
      void releaseBorrowed(false)
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
