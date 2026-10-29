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
const HANDLE_SIZE = 0x28
const HANDLE_BLACT_INDEX = 0x00
const HANDLE_MAT_ENTRY = 0x04
const FLDACT_GET_BLACT_IDX = 0x02167240
const NATIVE_STACK_RESERVE = 0x400
const BLACT_NONE = 0xffff
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000
const LOCAL_MAP_STABLE_MS = 450

type Binding = {
  actorAddress: number
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
    blActAddress: sceneActors + blActIndex * BLACT_SIZE,
    handleAddress,
  }
}

/**
 * Ordinary same-map render-family guard.
 *
 * Unlike the door guard, this component never caches a billboard binding across
 * frames. Every correction resolves the current field actor system from scratch,
 * so a map rebuild cannot make a stale P2 address alias Player 1. It also suspends
 * itself for transitions and briefly after a local map change.
 */
export function White2SameMapRenderFamilyGuard({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const presenceRef = useRef<MultiplayerPresenceSnapshot>({ local: null, remote: null })

  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return
    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    let cancelled = false
    let reading = false
    let previousLocalMapId: number | string | null = null
    let localMapStableSince = Date.now()
    let lastCorrectionKey = ''

    async function service() {
      if (cancelled || reading || runtimeBridge.status !== 'running') return
      const { local, remote } = presenceRef.current
      if (!local || !remote) return
      if (local.location.mapId !== remote.location.mapId) return
      if (local.transition || remote.transition) return
      if (Date.now() - localMapStableSince < LOCAL_MAP_STABLE_MS) return

      reading = true
      try {
        const scan = await probe.scanHeap()
        const player = scan.entries.find(entry => entry.uid === PLAYER_UID && entry.state === 'player')
        const remoteActor = scan.entries.find(entry =>
          entry.uid === POKERUN_NATIVE_TEST_UID
          && entry.state === 'active'
          && entry.actorSystemBackptr === scan.actorSystem
        )
        if (!player || !remoteActor) return

        const [playerBinding, remoteBinding] = await Promise.all([
          resolveBinding(runtimeBridge, player.address, scan.actorSystem),
          resolveBinding(runtimeBridge, remoteActor.address, scan.actorSystem),
        ])
        if (!playerBinding || !remoteBinding) return
        if (playerBinding.actorAddress === remoteBinding.actorAddress) return
        if (playerBinding.blActAddress === remoteBinding.blActAddress) return
        if (playerBinding.handleAddress === remoteBinding.handleAddress) return

        const [playerMatEntry, playerGeomFlags, remoteMatEntry, remoteGeomFlags] = await Promise.all([
          runtimeBridge.read16(playerBinding.handleAddress + HANDLE_MAT_ENTRY),
          runtimeBridge.read16(playerBinding.blActAddress + BLACT_GEOM_FLAGS),
          runtimeBridge.read16(remoteBinding.handleAddress + HANDLE_MAT_ENTRY),
          runtimeBridge.read16(remoteBinding.blActAddress + BLACT_GEOM_FLAGS),
        ])

        if (remoteMatEntry === playerMatEntry && remoteGeomFlags === playerGeomFlags) return

        await Promise.all([
          runtimeBridge.write16(remoteBinding.handleAddress + HANDLE_MAT_ENTRY, playerMatEntry),
          runtimeBridge.write16(remoteBinding.blActAddress + BLACT_GEOM_FLAGS, playerGeomFlags),
        ])

        const correctionKey = `${local.location.mapId}:${remoteBinding.actorAddress}:${remoteMatEntry}:${remoteGeomFlags}->${playerMatEntry}:${playerGeomFlags}`
        if (correctionKey !== lastCorrectionKey) {
          lastCorrectionKey = correctionKey
          console.info('[PokéRun render] CORRECTED LIVE SAME-MAP REMOTE FAMILY', {
            mapId: local.location.mapId,
            actor: remoteBinding.actorAddress,
            remoteMatEntry,
            remoteGeomFlags,
            playerMatEntry,
            playerGeomFlags,
          })
        }
      } catch {
        // Best-effort ordinary-movement guard. Door/lifecycle runtimes remain authoritative.
      } finally {
        reading = false
      }
    }

    const unsubscribePresence = multiplayerPresence.subscribe(snapshot => {
      presenceRef.current = snapshot
      const localMapId = snapshot.local?.location.mapId ?? null
      if (localMapId !== previousLocalMapId) {
        previousLocalMapId = localMapId
        localMapStableSince = Date.now()
        lastCorrectionKey = ''
      }
    })

    const unsubscribeFrame = runtimeBridge.subscribeEmulatedFrame(() => {
      void service()
    })

    return () => {
      cancelled = true
      unsubscribePresence()
      unsubscribeFrame()
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
