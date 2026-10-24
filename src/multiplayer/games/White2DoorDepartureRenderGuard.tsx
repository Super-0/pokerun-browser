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

const FACE_START = {
  north: 0,
  south: 3,
  west: 6,
  east: 9,
} as const

type Binding = {
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

async function writeDepartureFrame(bridge: MelonDsBridge, binding: Binding, family: RenderFamily, faceIndex: number) {
  await Promise.all([
    bridge.write16(binding.handleAddress + HANDLE_MAT_ENTRY, family.matEntry),
    bridge.write16(binding.blActAddress + BLACT_GEOM_FLAGS, family.geomFlags),
    bridge.write16(binding.blActAddress + BLACT_FACE_INDEX, faceIndex),
    bridge.write16(binding.blActAddress + BLACT_MAT_FLAGS, family.matFlags),
  ])
}

function departureFace(direction: keyof typeof FACE_START, age: number) {
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
 * Replay-only safety layer for the short synthetic remote door departure.
 *
 * The dedicated actor's native base is model 11. During replay the normal
 * cached departure profile can momentarily expose that native/rival renderer.
 * Sample the protagonist render family that is visibly correct in the local
 * field at replay start, then keep only that material/geometry family on the
 * remote while its synthetic walk into the door is active.
 */
export function White2DoorDepartureRenderGuard({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const presenceRef = useRef<MultiplayerPresenceSnapshot>({ local: null, remote: null })

  useEffect(() => multiplayerPresence.subscribe(snapshot => {
    presenceRef.current = snapshot
  }), [])

  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return
    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    let cancelled = false
    let reading = false
    let activeTransitionId = ''
    let lockedFamily: RenderFamily | null = null
    let remoteBinding: Binding | null = null

    async function service() {
      if (cancelled || reading || runtimeBridge.status !== 'running') return
      const { local, remote } = presenceRef.current
      const transition = remote?.transition
      if (!local || !remote || !transition) {
        activeTransitionId = ''
        lockedFamily = null
        remoteBinding = null
        return
      }

      const age = Date.now() - transition.detectedAt
      const departure = transition.fromMapId === local.location.mapId
        && transition.toMapId === remote.location.mapId
        && age >= 0
        && age < DEPARTURE_TOTAL_MS
      if (!departure) {
        activeTransitionId = ''
        lockedFamily = null
        remoteBinding = null
        return
      }

      reading = true
      try {
        if (activeTransitionId !== transition.id || !lockedFamily || !remoteBinding) {
          const scan = await probe.scanHeap()
          const player = scan.entries.find(entry => entry.uid === PLAYER_UID && entry.state === 'player')
          const remoteActor = scan.entries.find(entry => entry.uid === POKERUN_NATIVE_TEST_UID && entry.state === 'active')
          if (!player || !remoteActor) return

          const [playerBinding, nextRemoteBinding] = await Promise.all([
            resolveBinding(runtimeBridge, player.address, scan.actorSystem),
            resolveBinding(runtimeBridge, remoteActor.address, scan.actorSystem),
          ])
          if (!playerBinding || !nextRemoteBinding) return

          lockedFamily = await readFamily(runtimeBridge, playerBinding)
          remoteBinding = nextRemoteBinding
          activeTransitionId = transition.id
          console.info('[PokéRun door] LOCKED DEPARTURE RENDER', {
            id: transition.id,
            direction: transition.fromDirection,
            ...lockedFamily,
          })
        }

        if (!lockedFamily || !remoteBinding) return
        const faceIndex = departureFace(transition.fromDirection, age)
        await writeDepartureFrame(runtimeBridge, remoteBinding, lockedFamily, faceIndex)
      } finally {
        reading = false
      }
    }

    const unsubscribeFrame = runtimeBridge.subscribeEmulatedFrame(() => {
      void service()
    })
    const timer = window.setInterval(() => void service(), 16)

    return () => {
      cancelled = true
      unsubscribeFrame()
      window.clearInterval(timer)
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
