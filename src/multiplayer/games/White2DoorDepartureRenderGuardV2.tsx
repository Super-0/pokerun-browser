import { useEffect, useRef } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerRomIdentity } from '../core/protocol'
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

// Keep these in sync with White2DedicatedTrainerRuntime's departure window.
const DEPARTURE_LEAD_MS = 430
const DEPARTURE_TRAVEL_MS = 260
const DEPARTURE_TOTAL_MS = DEPARTURE_LEAD_MS + DEPARTURE_TRAVEL_MS
// White 2 can rebuild a FieldActor's BlAct/handle without changing the actor's
// UID or map. Revalidate often enough that a captured door never starts with a
// stale billboard binding from an earlier transition cycle.
const PREPARED_BINDING_REVALIDATE_MS = 100
// The fake/real peer reaches the threshold and briefly reports idle before its
// map-change packet. Door pre-open happens inside this beat, so hold the known
// protagonist renderer across it rather than letting the native NPC billboard
// surface for a frame before the formal departure guard activates.
const THRESHOLD_PRELOCK_MS = 220

const FACE_START = {
  north: 0,
  south: 3,
  west: 6,
  east: 9,
} as const

type Direction = keyof typeof FACE_START

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

function sameBinding(a: Binding | null, b: Binding) {
  return Boolean(a)
    && a!.actorAddress === b.actorAddress
    && a!.blActAddress === b.blActAddress
    && a!.handleAddress === b.handleAddress
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

function departureFace(direction: Direction, age: number) {
  const base = FACE_START[direction]
  if (age < DEPARTURE_LEAD_MS) return base
  const travelAge = age - DEPARTURE_LEAD_MS
  const phase = Math.floor(travelAge / 85) % 4
  if (phase === 0) return base + 1
  if (phase === 1) return base
  if (phase === 2) return base + 2
  return base
}

/**
 * Pre-locks the protagonist render while the remote is still on the local map.
 * That removes the one-frame race at the exact moment the replay packet changes
 * the remote map and White2DedicatedTrainerRuntime enters its synthetic departure.
 */
export function White2DoorDepartureRenderGuardV2({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const presenceRef = useRef<MultiplayerPresenceSnapshot>({ local: null, remote: null })

  useEffect(() => multiplayerPresence.subscribe(snapshot => {
    presenceRef.current = snapshot
  }), [])

  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return
    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    const originalWrite16 = runtimeBridge.write16.bind(runtimeBridge)

    let cancelled = false
    let reading = false
    let preparedFamily: RenderFamily | null = null
    let preparedRemoteBinding: Binding | null = null
    let preparedMapId: number | string | null = null
    let lastPreparedValidationAt = 0
    let activeTransitionId = ''
    let activeDetectedAt = 0
    let activeDirection: Direction = 'north'
    let previousRemoteMovementState: string | null = presenceRef.current.remote?.movementState ?? null
    let thresholdPrelockUntil = 0
    let thresholdPrelockDirection: Direction = presenceRef.current.remote?.direction ?? 'north'

    function clearPrepared() {
      preparedFamily = null
      preparedRemoteBinding = null
      preparedMapId = null
      lastPreparedValidationAt = 0
    }

    function clearActive() {
      activeTransitionId = ''
      activeDetectedAt = 0
    }

    function departureSnapshot() {
      const { local, remote } = presenceRef.current
      const transition = remote?.transition
      if (!local || !remote || !transition) return null
      if (transition.fromMapId !== local.location.mapId) return null
      if (transition.toMapId !== remote.location.mapId) return null
      const age = Date.now() - transition.detectedAt
      if (age < 0 || age >= DEPARTURE_TOTAL_MS) return null
      return { transition, age }
    }

    function thresholdPrelockActive() {
      const { local, remote } = presenceRef.current
      return Boolean(
        local
        && remote
        && local.location.mapId === remote.location.mapId
        && Date.now() < thresholdPrelockUntil,
      )
    }

    function promotePreparedDeparture() {
      const departure = departureSnapshot()
      if (!departure || !preparedFamily || !preparedRemoteBinding) return null
      const { transition, age } = departure
      if (activeTransitionId !== transition.id) {
        activeTransitionId = transition.id
        activeDetectedAt = transition.detectedAt
        activeDirection = transition.fromDirection
        console.info('[PokéRun door] ACTIVATED PRELOCKED DEPARTURE RENDER', {
          id: transition.id,
          direction: transition.fromDirection,
          actor: preparedRemoteBinding.actorAddress,
          blActAddress: preparedRemoteBinding.blActAddress,
          handleAddress: preparedRemoteBinding.handleAddress,
          ...preparedFamily,
        })
      }
      return age
    }

    function activeAge() {
      const promoted = promotePreparedDeparture()
      if (promoted !== null) return promoted
      if (!activeTransitionId || activeDetectedAt <= 0) return Number.POSITIVE_INFINITY
      return Date.now() - activeDetectedAt
    }

    runtimeBridge.write16 = async (address: number, value: number) => {
      const age = activeAge()
      const thresholdActive = thresholdPrelockActive()
      const binding = preparedRemoteBinding
      const family = preparedFamily
      const departureActive = Boolean(activeTransitionId && age >= 0 && age < DEPARTURE_TOTAL_MS)
      if (!binding || !family || (!departureActive && !thresholdActive)) {
        return originalWrite16(address, value)
      }

      if (address === binding.handleAddress + HANDLE_MAT_ENTRY) {
        return originalWrite16(address, family.matEntry)
      }
      if (address === binding.blActAddress + BLACT_GEOM_FLAGS) {
        return originalWrite16(address, family.geomFlags)
      }
      if (address === binding.blActAddress + BLACT_FACE_INDEX) {
        return originalWrite16(
          address,
          thresholdActive && !departureActive
            ? FACE_START[thresholdPrelockDirection]
            : departureFace(activeDirection, age),
        )
      }
      if (address === binding.blActAddress + BLACT_MAT_FLAGS) {
        const normalized = (family.matFlags & ~BLACT_VISIBLE_MASK) | (value & BLACT_VISIBLE_MASK)
        return originalWrite16(address, normalized)
      }
      return originalWrite16(address, value)
    }

    async function resolveLiveBindings() {
      const scan = await probe.scanHeap()
      const player = scan.entries.find(entry => entry.uid === PLAYER_UID && entry.state === 'player')
      const remoteActor = scan.entries.find(entry => entry.uid === POKERUN_NATIVE_TEST_UID && entry.state === 'active')
      if (!player || !remoteActor) return null

      const [playerBinding, remoteBinding] = await Promise.all([
        resolveBinding(runtimeBridge, player.address, scan.actorSystem),
        resolveBinding(runtimeBridge, remoteActor.address, scan.actorSystem),
      ])
      if (!playerBinding || !remoteBinding) return null
      return { playerBinding, remoteBinding }
    }

    async function prepareStableFamily(force = false) {
      const { local, remote } = presenceRef.current
      if (!local || !remote || local.location.mapId !== remote.location.mapId) return

      const now = Date.now()
      if (
        !force
        && preparedFamily
        && preparedRemoteBinding
        && preparedMapId === local.location.mapId
        && now - lastPreparedValidationAt < PREPARED_BINDING_REVALIDATE_MS
      ) return

      const live = await resolveLiveBindings()
      lastPreparedValidationAt = now
      if (!live) return

      const nextFamily = await readFamily(runtimeBridge, live.playerBinding)
      const bindingChanged = !sameBinding(preparedRemoteBinding, live.remoteBinding)
      const mapChanged = preparedMapId !== local.location.mapId

      preparedFamily = nextFamily
      preparedRemoteBinding = live.remoteBinding
      preparedMapId = local.location.mapId

      if (bindingChanged || mapChanged) {
        console.info('[PokéRun door] REFRESHED DEPARTURE RENDER BINDING', {
          mapId: local.location.mapId,
          actor: live.remoteBinding.actorAddress,
          blActAddress: live.remoteBinding.blActAddress,
          handleAddress: live.remoteBinding.handleAddress,
          ...nextFamily,
        })
      }
    }

    async function refreshRemoteBindingDuringDeparture() {
      if (!preparedFamily) return
      const live = await resolveLiveBindings()
      if (!live) return
      if (!sameBinding(preparedRemoteBinding, live.remoteBinding)) {
        preparedRemoteBinding = live.remoteBinding
        console.info('[PokéRun door] REBOUND DEPARTURE RENDER DURING TRANSITION', {
          actor: live.remoteBinding.actorAddress,
          blActAddress: live.remoteBinding.blActAddress,
          handleAddress: live.remoteBinding.handleAddress,
        })
      }
    }

    async function writeLockedFrame(age: number) {
      const binding = preparedRemoteBinding
      const family = preparedFamily
      if (!binding || !family) return
      await Promise.all([
        originalWrite16(binding.handleAddress + HANDLE_MAT_ENTRY, family.matEntry),
        originalWrite16(binding.blActAddress + BLACT_GEOM_FLAGS, family.geomFlags),
        originalWrite16(binding.blActAddress + BLACT_FACE_INDEX, departureFace(activeDirection, age)),
        originalWrite16(binding.blActAddress + BLACT_MAT_FLAGS, family.matFlags),
      ])
    }

    async function writeThresholdPrelockFrame() {
      const binding = preparedRemoteBinding
      const family = preparedFamily
      if (!binding || !family) return
      await Promise.all([
        originalWrite16(binding.handleAddress + HANDLE_MAT_ENTRY, family.matEntry),
        originalWrite16(binding.blActAddress + BLACT_GEOM_FLAGS, family.geomFlags),
        originalWrite16(binding.blActAddress + BLACT_FACE_INDEX, FACE_START[thresholdPrelockDirection]),
        originalWrite16(binding.blActAddress + BLACT_MAT_FLAGS, family.matFlags),
      ])
    }

    async function service() {
      if (cancelled || reading || runtimeBridge.status !== 'running') return
      reading = true
      try {
        const departure = departureSnapshot()
        if (departure) {
          await refreshRemoteBindingDuringDeparture()
          const age = promotePreparedDeparture()
          if (age !== null) await writeLockedFrame(age)
          return
        }

        if (activeTransitionId) {
          clearActive()
          clearPrepared()
        }

        const { local, remote } = presenceRef.current
        if (!local || !remote || local.location.mapId !== remote.location.mapId) return

        if (thresholdPrelockActive()) {
          await prepareStableFamily(true)
          await writeThresholdPrelockFrame()
          return
        }

        await prepareStableFamily()
      } finally {
        reading = false
      }
    }

    const unsubscribePresence = multiplayerPresence.subscribe(snapshot => {
      presenceRef.current = snapshot
      const { local, remote } = snapshot
      if (
        local
        && remote
        && !remote.transition
        && local.location.mapId === remote.location.mapId
        && previousRemoteMovementState === 'moving'
        && remote.movementState === 'idle'
      ) {
        thresholdPrelockDirection = remote.direction
        thresholdPrelockUntil = Date.now() + THRESHOLD_PRELOCK_MS
        console.info('[PokéRun door] THRESHOLD RENDER PRELOCK', {
          mapId: local.location.mapId,
          direction: remote.direction,
          holdMs: THRESHOLD_PRELOCK_MS,
        })
        void service()
      }
      previousRemoteMovementState = remote?.movementState ?? null
    })

    const unsubscribeFrame = runtimeBridge.subscribeEmulatedFrame(() => {
      void service()
    })
    const timer = window.setInterval(() => void service(), 32)

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
