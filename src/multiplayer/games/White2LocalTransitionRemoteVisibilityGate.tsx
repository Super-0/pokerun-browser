import { useEffect, useRef } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerRomIdentity } from '../core/protocol'
import { White2ActorSystemProbe } from './White2ActorSystem'
import { POKERUN_NATIVE_TEST_UID } from './White2NativeActor'

const ACTOR_UID = 0x08
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
const BLACT_MAT_FLAGS = 0x18
const BLACT_VISIBLE_MASK = 0x0200
const HANDLE_SIZE = 0x28
const HANDLE_BLACT_INDEX = 0x00
const FLDACT_GET_BLACT_IDX = 0x02167240
const NATIVE_STACK_RESERVE = 0x400
const BLACT_NONE = 0xffff
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000

type Binding = {
  actorAddress: number
  actorSystem: number
  blActIndex: number
  blActAddress: number
  handleAddress: number
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
    actorSystem,
    blActIndex,
    blActAddress: sceneActors + blActIndex * BLACT_SIZE,
    handleAddress,
  }
}

/**
 * Hard visibility gate for the short window where Player 1 has already entered
 * P2's map but White 2 is still finishing Player 1's own door transition.
 *
 * During this window the dedicated remote actor may exist before the destination
 * field has a stable protagonist render family. Any attempt to expose P2 is
 * forced hidden. Once local transition metadata clears, this component becomes
 * completely passive and the normal same-map renderer owns visibility again.
 */
export function White2LocalTransitionRemoteVisibilityGate({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const presenceRef = useRef<MultiplayerPresenceSnapshot>({ local: null, remote: null })

  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return
    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    const originalWrite16 = runtimeBridge.write16.bind(runtimeBridge)

    let cancelled = false
    let binding: Binding | null = null
    let refreshPromise: Promise<void> | null = null

    function active() {
      const { local, remote } = presenceRef.current
      return Boolean(
        local
        && remote
        && local.location.mapId === remote.location.mapId
        && local.transition,
      )
    }

    async function bindingStillOwned(current: Binding) {
      const [uid, actorSystem, owner] = await Promise.all([
        runtimeBridge.read16(current.actorAddress + ACTOR_UID),
        runtimeBridge.read32(current.actorAddress + ACTOR_SYSTEM_BACKPTR),
        runtimeBridge.read32(current.handleAddress + HANDLE_BLACT_INDEX),
      ])
      return uid === POKERUN_NATIVE_TEST_UID
        && actorSystem === current.actorSystem
        && owner === current.blActIndex
    }

    async function refreshBinding() {
      if (cancelled || !active()) {
        binding = null
        return
      }
      if (refreshPromise) return refreshPromise

      refreshPromise = (async () => {
        try {
          const scan = await probe.scanHeap()
          const remoteActor = scan.entries.find(entry =>
            entry.uid === POKERUN_NATIVE_TEST_UID
            && entry.state === 'active'
            && entry.actorSystemBackptr === scan.actorSystem
          )
          if (!remoteActor) {
            binding = null
            return
          }

          const next = await resolveBinding(runtimeBridge, remoteActor.address, scan.actorSystem)
          if (!next) {
            binding = null
            return
          }
          binding = next

          const flagsAddress = next.blActAddress + BLACT_MAT_FLAGS
          const flags = await runtimeBridge.read16(flagsAddress)
          if ((flags & BLACT_VISIBLE_MASK) !== 0) {
            await originalWrite16(flagsAddress, flags & ~BLACT_VISIBLE_MASK)
          }
        } catch {
          binding = null
        }
      })().finally(() => {
        refreshPromise = null
      })

      return refreshPromise
    }

    const wrappedWrite16 = async (address: number, value: number) => {
      if (!active()) return originalWrite16(address, value)

      let current = binding
      if (!current || !await bindingStillOwned(current)) {
        binding = null
        await refreshBinding()
        current = binding
      }

      if (current && address === current.blActAddress + BLACT_MAT_FLAGS) {
        return originalWrite16(address, value & ~BLACT_VISIBLE_MASK)
      }
      return originalWrite16(address, value)
    }

    runtimeBridge.write16 = wrappedWrite16

    const unsubscribePresence = multiplayerPresence.subscribe(snapshot => {
      presenceRef.current = snapshot
      if (!active()) {
        binding = null
        return
      }
      void refreshBinding()
    })

    const unsubscribeFrame = runtimeBridge.subscribeEmulatedFrame(() => {
      if (active()) void refreshBinding()
    })

    return () => {
      cancelled = true
      unsubscribePresence()
      unsubscribeFrame()
      if (runtimeBridge.write16 === wrappedWrite16) runtimeBridge.write16 = originalWrite16
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
