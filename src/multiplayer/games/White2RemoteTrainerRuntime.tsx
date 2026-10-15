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
const MAX_REMOTE_DX = 7
const MAX_REMOTE_DY = 5
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

type OriginalNpcState = {
  uid: number
  modelId: number
  tcb: number
  faceDir: number
  wposX: number
  wposY: number
  wposZ: number
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

function loadCachedKnowledge(key: string, knowledge: Record<Direction, DirectionKnowledge>) {
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
  } catch {
    // Cache is an optimization only; ignore stale or malformed data.
  }
}

function saveCachedKnowledge(key: string, knowledge: Record<Direction, DirectionKnowledge>) {
  try {
    const directions = Object.fromEntries(DIRECTIONS.map(direction => [direction, {
      idle: knowledge[direction].idle,
      movingSequence: knowledge[direction].movingSequence,
    }])) as CachedRenderProfile['directions']
    localStorage.setItem(key, JSON.stringify({ version: CACHE_VERSION, directions } satisfies CachedRenderProfile))
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
  const [faceDir, wposX, wposY, wposZ, matEntry, geomFlags, faceIndex, matFlags] = await Promise.all([
    bridge.read16(binding.actor.address + ACTOR_FACE_DIR),
    bridge.read32(binding.actor.address + ACTOR_WPOS + 0x00),
    bridge.read32(binding.actor.address + ACTOR_WPOS + 0x04),
    bridge.read32(binding.actor.address + ACTOR_WPOS + 0x08),
    bridge.read16(binding.handleAddress + HANDLE_MAT_ENTRY),
    bridge.read16(binding.blActAddress + BLACT_GEOM_FLAGS),
    bridge.read16(binding.blActAddress + BLACT_FACE_INDEX),
    bridge.read16(binding.blActAddress + BLACT_MAT_FLAGS),
  ])
  return { uid: binding.actor.uid, modelId: binding.actor.modelId, tcb: binding.actor.tcb, faceDir, wposX, wposY, wposZ, matEntry, geomFlags, faceIndex, matFlags }
}

async function restoreNpc(bridge: MelonDsBridge, borrowed: BorrowedNpc) {
  const { binding, original } = borrowed
  if (!(await bindingIdentityMatches(bridge, binding, original.uid, original.modelId, original.tcb))) return false
  await Promise.all([
    bridge.write16(binding.actor.address + ACTOR_FACE_DIR, original.faceDir),
    bridge.write32(binding.actor.address + ACTOR_WPOS + 0x00, original.wposX),
    bridge.write32(binding.actor.address + ACTOR_WPOS + 0x04, original.wposY),
    bridge.write32(binding.actor.address + ACTOR_WPOS + 0x08, original.wposZ),
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
 * This promotes the validated V6 path: continuous networked FieldActor.WPos plus
 * the game's own learned billboard frames. It still borrows one ordinary NPC as
 * the renderer; a dedicated native actor remains the next architecture milestone.
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
    let lastRemoteWorld: MultiplayerWorldPosition | null = null
    let remoteMovingUntil = 0
    let activeRemoteDirection: Direction | null = null
    let remoteSequenceIndex = 0
    let remoteStepStartedAt = 0
    let remoteWasMoving = false
    let lastError = ''
    const knowledge = emptyKnowledge()

    async function releaseBorrowed() {
      const current = borrowed
      borrowed = null
      if (!current) return
      try {
        await restoreNpc(bridge, current)
      } catch {
        // Map lifecycle may already have destroyed/replaced the borrowed actor.
      }
    }

    function resetPlayerBinding() {
      playerBinding = null
      lastPlayerX = null
      lastPlayerZ = null
      playerMovingUntil = 0
      activePlayerRunDirection = null
      for (const direction of DIRECTIONS) finalizeRun(knowledge[direction])
    }

    async function ensurePlayerBinding() {
      if (playerBinding && await bindingIdentityMatches(bridge, playerBinding, PLAYER_UID, playerBinding.actor.modelId, playerBinding.actor.tcb)) return playerBinding
      resetPlayerBinding()
      const prepared = await prepareBindings(bridge)
      playerBinding = prepared.playerBinding
      if (playerModelId !== playerBinding.actor.modelId) {
        playerModelId = playerBinding.actor.modelId
        cacheStorageKey = cacheKey(rom, playerModelId)
        loadCachedKnowledge(cacheStorageKey, knowledge)
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

      if (cacheStorageKey && now - lastCacheSave >= 2000) {
        lastCacheSave = now
        saveCachedKnowledge(cacheStorageKey, knowledge)
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
      const directionKnowledge = knowledge[remote.direction]

      if (activeRemoteDirection !== remote.direction) {
        activeRemoteDirection = remote.direction
        remoteSequenceIndex = 0
        remoteStepStartedAt = now
        remoteWasMoving = false
      }

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
      const sameMap = Boolean(local && remote && local.location.mapId === remote.location.mapId)
      const inRange = Boolean(local && remote && Math.abs(remote.x - local.x) <= MAX_REMOTE_DX && Math.abs(remote.y - local.y) <= MAX_REMOTE_DY)
      const profile = remote ? remoteProfile(now, remote) : null
      const eligible = Boolean(local?.worldPosition && remote?.worldPosition && sameMap && inRange && profile && playerMatEntry !== null)

      if (!eligible || !remote?.worldPosition || !profile || playerMatEntry === null) {
        await releaseBorrowed()
        return
      }

      const proxy = await ensureBorrowed()
      if (!proxy) return
      const binding = proxy.binding
      const world = remote.worldPosition

      await Promise.all([
        bridge.write16(binding.actor.address + ACTOR_FACE_DIR, FIELD_FACE_BY_DIRECTION[remote.direction]),
        bridge.write32(binding.actor.address + ACTOR_WPOS + 0x00, world.x >>> 0),
        bridge.write32(binding.actor.address + ACTOR_WPOS + 0x04, world.y >>> 0),
        bridge.write32(binding.actor.address + ACTOR_WPOS + 0x08, world.z >>> 0),
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
            await releaseBorrowed()
          }
        } catch (reason) {
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
      if (cacheStorageKey) saveCachedKnowledge(cacheStorageKey, knowledge)
      void releaseBorrowed()
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
