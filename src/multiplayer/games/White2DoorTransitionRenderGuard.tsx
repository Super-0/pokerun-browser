import { useEffect } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerMapTransition, MultiplayerRomIdentity } from '../core/protocol'
import { White2ActorSystemProbe } from './White2ActorSystem'
import { POKERUN_NATIVE_TEST_UID } from './White2NativeActor'

const PLAYER_UID = 0x00ff
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
const BLACT_FACE_INDEX = 0x10
const BLACT_MAT_FLAGS = 0x18
const BLACT_VISIBLE_MASK = 0x0200
const HANDLE_SIZE = 0x28
const HANDLE_BLACT_INDEX = 0x00
const HANDLE_MAT_ENTRY = 0x04
const FLDACT_GET_BLACT_IDX = 0x02167240
const NATIVE_STACK_RESERVE = 0x400
const BLACT_NONE = 0xffff
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000

// Keep departure frame timing aligned with White2DedicatedTrainerRuntime.
const DEPARTURE_LEAD_MS = 430
// The visual handoff itself is shorter, but keep the render family protected
// through the complete hide/reveal edge so no native/fallback model gets a frame.
const TRANSITION_RENDER_GUARD_MS = 1100

const FACE_START = {
  north: 0,
  south: 3,
  west: 6,
  east: 9,
} as const

type Direction = keyof typeof FACE_START
type TransitionMode = 'departure' | 'arrival'

type Binding = {
  actorAddress: number
  blActAddress: number
  handleAddress: number
}

type RenderFamily = {
  matEntry: number
  geomFlags: number
  matFlags: number
}

type ActiveTransition = {
  id: string
  mode: TransitionMode
  detectedAt: number
  activatedAt: number
  direction: Direction
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 0x3) === 0
}

function isMainRamFunctionPointer(value: number) {
  const address = value & ~1
  return Number.isInteger(value)
    && address >= MAIN_RAM_START
    && address < MAIN_RAM_END
    && ((value & 1) === 1 || (address & 3) === 0)
}

async function resolveBinding(bridge: MelonDsBridge, actorAddress: number, actorSystem: number): Promise<Binding | null> {
  const sceneNodeVTable = await bridge.read32(actorAddress + ACTOR_SCENE_NODE_VTABLE)
  if (!isMainRamPointer(sceneNodeVTable)) return null
  const getter = await bridge.read32(sceneNodeVTable + SCENE_NODE_GET_BLACT_INDEX)
  if (!isMainRamFunctionPointer(getter)) return null

  const call = await bridge.callArm9Thumb4(FLDACT_GET_BLACT_IDX, actorAddress, 0, 0, 0, NATIVE_STACK_RESERVE)
  if (call.status !== 1) return null
  const blActIndex = call.result & 0xffff
  if (blActIndex === BLACT_NONE) return null

  const fieldBlAct = await bridge.read32(actorSystem + ACTOR_SYSTEM_FIELD_BLACT)
  if (!isMainRamPointer(fieldBlAct)) return null
  const blActSystem = await bridge.read32(fieldBlAct + FIELD_BLACT_SYSTEM)
  if (!isMainRamPointer(blActSystem)) return null

  const [scene, handles, handleCount] = await Promise.all([
    bridge.read32(blActSystem + BLACT_SYSTEM_SCENE),
    bridge.read32(blActSystem + BLACT_SYSTEM_ACTOR_HANDLES),
    bridge.read16(blActSystem + BLACT_SYSTEM_ACTOR_COUNT),
  ])
  if (!isMainRamPointer(scene) || !isMainRamPointer(handles)) return null

  const [sceneActors, sceneActorCount] = await Promise.all([
    bridge.read32(scene + BLACT_SCENE_ACTORS),
    bridge.read16(scene + BLACT_SCENE_CONFIG_ACTOR_COUNT),
  ])
  if (!isMainRamPointer(sceneActors) || blActIndex >= sceneActorCount) return null

  let handleAddress = 0
  for (let index = 0; index < handleCount; index += 1) {
    const candidate = handles + index * HANDLE_SIZE
    if ((await bridge.read32(candidate + HANDLE_BLACT_INDEX)) !== blActIndex) continue
    if (handleAddress !== 0) return null
    handleAddress = candidate
  }
  if (!handleAddress) return null

  return {
    actorAddress,
    blActAddress: sceneActors + blActIndex * BLACT_SIZE,
    handleAddress,
  }
}

async function readFamily(bridge: MelonDsBridge, binding: Binding): Promise<RenderFamily> {
  const [matEntry, geomFlags, matFlags] = await Promise.all([
    bridge.read16(binding.handleAddress + HANDLE_MAT_ENTRY),
    bridge.read16(binding.blActAddress + BLACT_GEOM_FLAGS),
    bridge.read16(binding.blActAddress + BLACT_MAT_FLAGS),
  ])
  return { matEntry, geomFlags, matFlags }
}

function departureFace(direction: Direction, detectedAt: number) {
  const base = FACE_START[direction]
  const age = Date.now() - detectedAt
  if (age < DEPARTURE_LEAD_MS) return base
  const travelAge = age - DEPARTURE_LEAD_MS
  const phase = Math.floor(Math.max(0, travelAge) / 85) % 4
  if (phase === 0) return base + 1
  if (phase === 1) return base
  if (phase === 2) return base + 2
  return base
}

function transitionMode(snapshot: MultiplayerPresenceSnapshot, transition: MultiplayerMapTransition): TransitionMode | null {
  const { local, remote } = snapshot
  if (!local || !remote) return null

  if (
    local.location.mapId === transition.fromMapId
    && remote.location.mapId === transition.toMapId
    && local.location.mapId !== remote.location.mapId
  ) return 'departure'

  if (
    local.location.mapId === transition.toMapId
    && remote.location.mapId === transition.toMapId
    && transition.fromMapId !== transition.toMapId
  ) return 'arrival'

  return null
}

/**
 * Keeps the protagonist billboard family authoritative across both edges of a
 * White 2 door transition. The dedicated actor intentionally has a native NPC
 * model underneath it, so even a one-frame gap in PokéRun's renderer ownership
 * exposes the rival/orange-hat fallback. This guard subscribes before the actor
 * runtime and preserves the last known-good local protagonist family while the
 * remote is off-map, then normalizes competing writes during departure/arrival.
 */
export function White2DoorTransitionRenderGuard({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return

    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    const originalWrite16 = runtimeBridge.write16.bind(runtimeBridge)

    let cancelled = false
    let reading = false
    let latest: MultiplayerPresenceSnapshot = { local: null, remote: null }
    let preparedFamily: RenderFamily | null = null
    let preparedRemoteBinding: Binding | null = null
    let preparedMapId: number | string | null = null
    let active: ActiveTransition | null = null

    function activateFromSnapshot(snapshot: MultiplayerPresenceSnapshot) {
      const transition = snapshot.remote?.transition
      if (!transition) return
      const mode = transitionMode(snapshot, transition)
      if (!mode) return
      if (active?.id === transition.id && active.mode === mode) return

      active = {
        id: transition.id,
        mode,
        detectedAt: transition.detectedAt,
        activatedAt: Date.now(),
        direction: (mode === 'departure' ? transition.fromDirection : transition.toDirection) as Direction,
      }
      console.info('[PokéRun door] ACTIVATED TRANSITION RENDER GUARD', {
        id: transition.id,
        mode,
        direction: active.direction,
        prepared: Boolean(preparedFamily && preparedRemoteBinding),
      })
    }

    const unsubscribePresence = multiplayerPresence.subscribe(snapshot => {
      latest = snapshot
      // This callback runs before the trainer runtime's subscription because the
      // guard is mounted first. Activate synchronously so its very first render
      // write cannot expose the actor's native fallback model.
      activateFromSnapshot(snapshot)
    })

    function activeGuard() {
      activateFromSnapshot(latest)
      if (!active) return null
      if (Date.now() - active.activatedAt >= TRANSITION_RENDER_GUARD_MS) {
        active = null
        return null
      }
      return active
    }

    runtimeBridge.write16 = async (address: number, value: number) => {
      const current = activeGuard()
      const binding = preparedRemoteBinding
      const family = preparedFamily
      if (!current || !binding || !family) return originalWrite16(address, value)

      if (address === binding.handleAddress + HANDLE_MAT_ENTRY) {
        return originalWrite16(address, family.matEntry)
      }
      if (address === binding.blActAddress + BLACT_GEOM_FLAGS) {
        return originalWrite16(address, family.geomFlags)
      }
      if (address === binding.blActAddress + BLACT_FACE_INDEX && current.mode === 'departure') {
        return originalWrite16(address, departureFace(current.direction, current.detectedAt))
      }
      if (address === binding.blActAddress + BLACT_MAT_FLAGS) {
        const normalized = (family.matFlags & ~BLACT_VISIBLE_MASK) | (value & BLACT_VISIBLE_MASK)
        return originalWrite16(address, normalized)
      }
      return originalWrite16(address, value)
    }

    async function refreshPreparedFamily() {
      const { local, remote } = latest
      if (!local || !remote || local.location.mapId !== remote.location.mapId) return
      if (activeGuard()) return

      const scan = await probe.scanHeap()
      const player = scan.entries.find(entry => entry.uid === PLAYER_UID && entry.state === 'player')
      const remoteActor = scan.entries.find(entry => entry.uid === POKERUN_NATIVE_TEST_UID && entry.state === 'active')
      if (!player || !remoteActor) return

      if (
        preparedFamily
        && preparedRemoteBinding
        && preparedMapId === local.location.mapId
        && preparedRemoteBinding.actorAddress === remoteActor.address
      ) return

      const [playerBinding, remoteBinding] = await Promise.all([
        resolveBinding(runtimeBridge, player.address, scan.actorSystem),
        resolveBinding(runtimeBridge, remoteActor.address, scan.actorSystem),
      ])
      if (!playerBinding || !remoteBinding) return

      preparedFamily = await readFamily(runtimeBridge, playerBinding)
      preparedRemoteBinding = remoteBinding
      preparedMapId = local.location.mapId
      console.info('[PokéRun door] PREPARED TRANSITION RENDER', {
        mapId: local.location.mapId,
        actor: remoteBinding.actorAddress,
        ...preparedFamily,
      })
    }

    async function refreshRemoteBindingDuringGuard() {
      if (!activeGuard() || !preparedFamily) return
      const scan = await probe.scanHeap()
      const remoteActor = scan.entries.find(entry => entry.uid === POKERUN_NATIVE_TEST_UID && entry.state === 'active')
      if (!remoteActor || preparedRemoteBinding?.actorAddress === remoteActor.address) return
      const next = await resolveBinding(runtimeBridge, remoteActor.address, scan.actorSystem)
      if (next) preparedRemoteBinding = next
    }

    async function writeLockedFamily() {
      const current = activeGuard()
      const binding = preparedRemoteBinding
      const family = preparedFamily
      if (!current || !binding || !family) return

      const currentMatFlags = await runtimeBridge.read16(binding.blActAddress + BLACT_MAT_FLAGS)
      const normalizedMatFlags = (family.matFlags & ~BLACT_VISIBLE_MASK) | (currentMatFlags & BLACT_VISIBLE_MASK)
      const writes: Promise<unknown>[] = [
        originalWrite16(binding.handleAddress + HANDLE_MAT_ENTRY, family.matEntry),
        originalWrite16(binding.blActAddress + BLACT_GEOM_FLAGS, family.geomFlags),
        originalWrite16(binding.blActAddress + BLACT_MAT_FLAGS, normalizedMatFlags),
      ]
      if (current.mode === 'departure') {
        writes.push(originalWrite16(
          binding.blActAddress + BLACT_FACE_INDEX,
          departureFace(current.direction, current.detectedAt),
        ))
      }
      await Promise.all(writes)
    }

    async function service() {
      if (cancelled || reading || runtimeBridge.status !== 'running') return
      reading = true
      try {
        if (activeGuard()) {
          await refreshRemoteBindingDuringGuard()
          await writeLockedFamily()
        } else {
          await refreshPreparedFamily()
        }
      } catch {
        // Render protection is best-effort; the dedicated runtime owns recovery.
      } finally {
        reading = false
      }
    }

    const unsubscribeFrame = runtimeBridge.subscribeEmulatedFrame(() => {
      void service()
    })
    const timer = window.setInterval(() => void service(), 24)

    return () => {
      cancelled = true
      unsubscribePresence()
      unsubscribeFrame()
      window.clearInterval(timer)
      runtimeBridge.write16 = originalWrite16
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
