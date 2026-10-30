import { useEffect, useRef } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerMapTransition, MultiplayerRomIdentity } from '../core/protocol'
import { White2ActorSystemProbe } from './White2ActorSystem'
import { POKERUN_NATIVE_TEST_UID } from './White2NativeActor'

const PLAYER_UID = 0x00ff
const ACTOR_TCB = 0x84
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
const BLACT_MAT_FLAGS = 0x18
const BLACT_VISIBLE_MASK = 0x0200
const HANDLE_SIZE = 0x28
const HANDLE_BLACT_INDEX = 0x00
const HANDLE_MAT_ENTRY = 0x04
const FLDACT_GET_BLACT_IDX = 0x02167240
const FLDACT_SET_HIDDEN = 0x02167574
const FLDACT_SWAP_OBJ_CODE = 0x02194438
const FLDACTSYS_IS_ASYNC_LOAD_PENDING = 0x02193844
const NATIVE_STACK_RESERVE = 0x400
const BLACT_NONE = 0xffff
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000
const TRANSITION_FRESH_MS = 800
const POLL_MS = 16

type Binding = {
  actorAddress: number
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

function transitionFresh(transition: MultiplayerMapTransition | undefined) {
  if (!transition) return false
  const age = Date.now() - transition.detectedAt
  return age >= 0 && age < TRANSITION_FRESH_MS
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
    blActIndex,
    blActAddress: sceneActors + blActIndex * BLACT_SIZE,
    handleAddress,
  }
}

/**
 * One-shot native-spawn quarantine.
 *
 * P2 is kept actor-hidden until PokéRun owns its update loop and White 2 has
 * rebound its native billboard resources to the live protagonist object code.
 * Merely copying modelId/material fields is not enough: White 2 tracks the
 * underlying object-code resource binding separately. FldAct_SwapObjCode is the
 * game's own unload/rebind path for that resource ownership.
 *
 * This gate performs that native resource swap exactly once for each newly
 * observed P2 actor, waits for the field material loader to become idle, verifies
 * the resulting billboard family against P1, then clears the native hidden flag
 * exactly once. Ordinary visibility remains owned by White2DedicatedTrainerRuntime.
 */
export function White2LocalTransitionRemoteVisibilityGate({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const presenceRef = useRef<MultiplayerPresenceSnapshot>({ local: null, remote: null })

  useEffect(() => multiplayerPresence.subscribe(snapshot => {
    presenceRef.current = snapshot
  }), [])

  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return
    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    let cancelled = false
    let busy = false
    let observedActor = 0
    let swappedActor = 0
    let releasedActor = 0
    let nativeHidden: boolean | null = null
    let lastPresenceKey = ''
    let lastWarning = ''

    async function setNativeHidden(actorAddress: number, hidden: boolean) {
      if (nativeHidden === hidden) return true
      const call = await runtimeBridge.callArm9Thumb4(
        FLDACT_SET_HIDDEN,
        actorAddress,
        hidden ? 1 : 0,
        0,
        0,
        NATIVE_STACK_RESERVE,
      )
      if (call.status !== 1) return false
      nativeHidden = hidden
      return true
    }

    async function inspect() {
      if (cancelled || busy || runtimeBridge.status !== 'running') return
      busy = true
      try {
        const { local, remote } = presenceRef.current
        const presenceKey = `${String(local?.location.mapId ?? 'none')}:${String(remote?.location.mapId ?? 'none')}`
        if (presenceKey !== lastPresenceKey) {
          lastPresenceKey = presenceKey
          observedActor = 0
          swappedActor = 0
          releasedActor = 0
          nativeHidden = null
        }

        if (!local || !remote || local.location.mapId !== remote.location.mapId) return
        if (transitionFresh(local.transition) || transitionFresh(remote.transition)) return

        const scan = await probe.scanHeap()
        const player = scan.entries.find(entry => entry.uid === PLAYER_UID && entry.state === 'player')
        const remoteActor = scan.entries.find(entry =>
          entry.uid === POKERUN_NATIVE_TEST_UID
          && entry.state === 'active'
          && entry.actorSystemBackptr === scan.actorSystem
        )

        if (!player || !remoteActor) {
          observedActor = 0
          swappedActor = 0
          releasedActor = 0
          nativeHidden = null
          return
        }

        if (remoteActor.address !== observedActor) {
          observedActor = remoteActor.address
          swappedActor = 0
          releasedActor = 0
          nativeHidden = null
        }
        if (releasedActor === remoteActor.address) return

        // Quarantine first. The actor-level flag is independent of billboard
        // material visibility and remains active while White 2 rebinds resources.
        if (!await setNativeHidden(remoteActor.address, true)) return

        // The dedicated runtime clears ACTOR_TCB after removing White 2's normal
        // actor updater. Do not mutate native resource ownership before then.
        const nativeTcb = await runtimeBridge.read32(remoteActor.address + ACTOR_TCB)
        if (nativeTcb !== 0) return

        // modelId/material fields can look identical to P1 while the actor still
        // references the old orange-trainer resource. Use White 2's real object-
        // code swap routine to rebuild that hidden resource binding.
        if (swappedActor !== remoteActor.address) {
          const targetObjCode = player.modelId
          if (targetObjCode <= 0 || targetObjCode === 0xffff) return
          const swapOpcode = await runtimeBridge.read16(FLDACT_SWAP_OBJ_CODE)
          if (swapOpcode === 0 || swapOpcode === 0xffff) return

          const swap = await runtimeBridge.callArm9Thumb4(
            FLDACT_SWAP_OBJ_CODE,
            remoteActor.address,
            targetObjCode,
            0,
            0,
            NATIVE_STACK_RESERVE,
          )
          if (swap.status !== 1) {
            throw new Error(`FldAct_SwapObjCode failed with status ${swap.status} at PC 0x${swap.pc.toString(16).toUpperCase()}.`)
          }
          swappedActor = remoteActor.address
          console.info('[PokéRun lifecycle] NATIVE REMOTE RESOURCE SWAP REQUESTED', {
            actor: remoteActor.address,
            mapId: local.location.mapId,
            objCode: targetObjCode,
          })
          return
        }

        // Let White 2's ordinary field scheduler drive the asynchronous material
        // unloader/loader. This read-only native query avoids calling ForceFullSync
        // through the bounded JS call gate, where OS_WaitInterrupt would be unsafe.
        const pending = await runtimeBridge.callArm9Thumb4(
          FLDACTSYS_IS_ASYNC_LOAD_PENDING,
          scan.actorSystem,
          0,
          0,
          0,
          NATIVE_STACK_RESERVE,
        )
        if (pending.status !== 1) return
        if (pending.result !== 0) return

        // The swap may replace the billboard slot/handle, so always resolve both
        // bindings fresh after the native loader reports idle.
        const [playerBinding, remoteBinding] = await Promise.all([
          resolveBinding(runtimeBridge, player.address, scan.actorSystem),
          resolveBinding(runtimeBridge, remoteActor.address, scan.actorSystem),
        ])
        if (!playerBinding || !remoteBinding) return

        const [playerMatEntry, playerGeomFlags, playerMatFlags, remoteMatEntry, remoteGeomFlags, remoteMatFlags] = await Promise.all([
          runtimeBridge.read16(playerBinding.handleAddress + HANDLE_MAT_ENTRY),
          runtimeBridge.read16(playerBinding.blActAddress + BLACT_GEOM_FLAGS),
          runtimeBridge.read16(playerBinding.blActAddress + BLACT_MAT_FLAGS),
          runtimeBridge.read16(remoteBinding.handleAddress + HANDLE_MAT_ENTRY),
          runtimeBridge.read16(remoteBinding.blActAddress + BLACT_GEOM_FLAGS),
          runtimeBridge.read16(remoteBinding.blActAddress + BLACT_MAT_FLAGS),
        ])

        const familyReady = remoteMatEntry === playerMatEntry
          && remoteGeomFlags === playerGeomFlags
          && (remoteMatFlags & ~BLACT_VISIBLE_MASK) === (playerMatFlags & ~BLACT_VISIBLE_MASK)
        if (!familyReady) return

        if (!await setNativeHidden(remoteActor.address, false)) return
        releasedActor = remoteActor.address
        lastWarning = ''
        console.info('[PokéRun lifecycle] RELEASE REMOTE FROM NATIVE RESOURCE QUARANTINE', {
          actor: remoteActor.address,
          mapId: local.location.mapId,
          objCode: player.modelId,
          matEntry: remoteMatEntry,
          geomFlags: remoteGeomFlags,
        })
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason)
        if (message !== lastWarning) {
          lastWarning = message
          console.warn('White 2 native remote spawn quarantine paused for one pass:', reason)
        }
      } finally {
        busy = false
      }
    }

    const unsubscribeFrame = runtimeBridge.subscribeEmulatedFrame(() => {
      void inspect()
    })
    const timer = window.setInterval(() => {
      void inspect()
    }, POLL_MS)

    return () => {
      cancelled = true
      unsubscribeFrame()
      window.clearInterval(timer)
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
