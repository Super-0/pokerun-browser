import { useEffect, useRef } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerRomIdentity } from '../core/protocol'
import { White2ActorSystemProbe } from './White2ActorSystem'
import { POKERUN_NATIVE_TEST_UID } from './White2NativeActor'

const PLAYER_UID = 0x00ff
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
const LOCAL_MAP_STABLE_MS = 450
const REFRESH_MS = 32

const IDLE_FACE_BY_DIRECTION = {
  north: 0,
  south: 3,
  west: 6,
  east: 9,
} as const

type Binding = {
  actorAddress: number
  actorSystem: number
  blActIndex: number
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
    && address >= MAIN_RAM_START && address < MAIN_RAM_END
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
 * Ordinary same-map renderer ownership.
 *
 * The dedicated trainer runtime is allowed to choose face indices for walking,
 * but all of its writes are forced through the currently-live protagonist
 * material/geometry family. Before overriding a write we validate that the
 * cached binding is still the PokéRun UID and still owns the same BlAct handle.
 * This prevents a field rebuild from reusing a stale remote address for Player 1.
 *
 * After Player 1 changes into a map where P2 already exists, P2 is quarantined
 * invisible during the short field bootstrap. It is only revealed after the full
 * protagonist family and directional idle frame have been written, preventing a
 * one-frame native/black-square flash.
 */
export function White2SameMapRenderFamilyGuard({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const presenceRef = useRef<MultiplayerPresenceSnapshot>({ local: null, remote: null })

  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return
    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    const originalWrite16 = runtimeBridge.write16.bind(runtimeBridge)

    let cancelled = false
    let reading = false
    let previousLocalMapId: number | string | null = null
    let localMapStableSince = 0
    let bootstrapQuarantine = false
    let remoteBinding: Binding | null = null
    let protagonistFamily: RenderFamily | null = null
    let preparedMapId: number | string | null = null
    let lastPreparedAt = 0
    let lastLogKey = ''

    function clearPrepared() {
      remoteBinding = null
      protagonistFamily = null
      preparedMapId = null
      lastPreparedAt = 0
      lastLogKey = ''
    }

    function sameMapSnapshot() {
      const { local, remote } = presenceRef.current
      if (!local || !remote) return null
      if (local.location.mapId !== remote.location.mapId) return null
      if (local.transition || remote.transition) return null
      return { local, remote }
    }

    function sameMapStable() {
      const sameMap = sameMapSnapshot()
      if (!sameMap) return null
      if (Date.now() - localMapStableSince < LOCAL_MAP_STABLE_MS) return null
      return sameMap
    }

    async function bindingStillOwned(binding: Binding) {
      const [uid, actorSystem, owner] = await Promise.all([
        runtimeBridge.read16(binding.actorAddress + ACTOR_UID),
        runtimeBridge.read32(binding.actorAddress + ACTOR_SYSTEM_BACKPTR),
        runtimeBridge.read32(binding.handleAddress + HANDLE_BLACT_INDEX),
      ])
      return uid === POKERUN_NATIVE_TEST_UID
        && actorSystem === binding.actorSystem
        && owner === binding.blActIndex
    }

    runtimeBridge.write16 = async (address: number, value: number) => {
      const active = sameMapStable()
      const binding = remoteBinding
      const family = protagonistFamily
      if (!active || !binding || !family || preparedMapId !== active.local.location.mapId) {
        return originalWrite16(address, value)
      }

      const isMatEntry = address === binding.handleAddress + HANDLE_MAT_ENTRY
      const isGeomFlags = address === binding.blActAddress + BLACT_GEOM_FLAGS
      const isFaceIndex = address === binding.blActAddress + BLACT_FACE_INDEX
      const isMatFlags = address === binding.blActAddress + BLACT_MAT_FLAGS
      if (!isMatEntry && !isGeomFlags && !isFaceIndex && !isMatFlags) {
        return originalWrite16(address, value)
      }

      if (!await bindingStillOwned(binding)) {
        clearPrepared()
        return originalWrite16(address, value)
      }

      if (isMatEntry) return originalWrite16(address, family.matEntry)
      if (isGeomFlags) return originalWrite16(address, family.geomFlags)
      if (isMatFlags) {
        const normalized = (family.matFlags & ~BLACT_VISIBLE_MASK) | (value & BLACT_VISIBLE_MASK)
        return originalWrite16(address, normalized)
      }
      if (isFaceIndex && active.remote.movementState === 'idle') {
        return originalWrite16(address, IDLE_FACE_BY_DIRECTION[active.remote.direction])
      }
      return originalWrite16(address, value)
    }

    async function resolveLiveActors() {
      const scan = await probe.scanHeap()
      const player = scan.entries.find(entry => entry.uid === PLAYER_UID && entry.state === 'player')
      const remoteActor = scan.entries.find(entry =>
        entry.uid === POKERUN_NATIVE_TEST_UID
        && entry.state === 'active'
        && entry.actorSystemBackptr === scan.actorSystem
      )
      if (!player || !remoteActor) return null

      const [playerBinding, nextRemoteBinding] = await Promise.all([
        resolveBinding(runtimeBridge, player.address, scan.actorSystem),
        resolveBinding(runtimeBridge, remoteActor.address, scan.actorSystem),
      ])
      if (!playerBinding || !nextRemoteBinding) return null
      if (playerBinding.actorAddress === nextRemoteBinding.actorAddress
        || playerBinding.blActAddress === nextRemoteBinding.blActAddress
        || playerBinding.handleAddress === nextRemoteBinding.handleAddress) return null
      return { playerBinding, remoteBinding: nextRemoteBinding }
    }

    async function quarantineLiveRemote() {
      if (!bootstrapQuarantine || !sameMapSnapshot()) return
      const live = await resolveLiveActors()
      if (!live) return
      const flagsAddress = live.remoteBinding.blActAddress + BLACT_MAT_FLAGS
      const flags = await runtimeBridge.read16(flagsAddress)
      if ((flags & BLACT_VISIBLE_MASK) !== 0) {
        await originalWrite16(flagsAddress, flags & ~BLACT_VISIBLE_MASK)
      }
    }

    async function prepareLiveFamily(force = false) {
      const sameMap = sameMapSnapshot()
      if (!sameMap) {
        bootstrapQuarantine = false
        clearPrepared()
        return
      }

      if (Date.now() - localMapStableSince < LOCAL_MAP_STABLE_MS) {
        await quarantineLiveRemote()
        clearPrepared()
        return
      }

      const active = sameMap
      const now = Date.now()
      if (!force
        && remoteBinding
        && protagonistFamily
        && preparedMapId === active.local.location.mapId
        && now - lastPreparedAt < REFRESH_MS) return

      reading = true
      try {
        const live = await resolveLiveActors()
        if (!live) {
          clearPrepared()
          return
        }
        const { playerBinding, remoteBinding: nextRemoteBinding } = live

        const [matEntry, geomFlags, matFlags] = await Promise.all([
          runtimeBridge.read16(playerBinding.handleAddress + HANDLE_MAT_ENTRY),
          runtimeBridge.read16(playerBinding.blActAddress + BLACT_GEOM_FLAGS),
          runtimeBridge.read16(playerBinding.blActAddress + BLACT_MAT_FLAGS),
        ])

        remoteBinding = nextRemoteBinding
        protagonistFamily = { matEntry, geomFlags, matFlags }
        preparedMapId = active.local.location.mapId
        lastPreparedAt = now

        const currentFlags = await runtimeBridge.read16(nextRemoteBinding.blActAddress + BLACT_MAT_FLAGS)
        const normalizedFlags = (matFlags & ~BLACT_VISIBLE_MASK)
          | (bootstrapQuarantine ? BLACT_VISIBLE_MASK : (currentFlags & BLACT_VISIBLE_MASK))
        const writes: Promise<void>[] = [
          originalWrite16(nextRemoteBinding.handleAddress + HANDLE_MAT_ENTRY, matEntry),
          originalWrite16(nextRemoteBinding.blActAddress + BLACT_GEOM_FLAGS, geomFlags),
          originalWrite16(nextRemoteBinding.blActAddress + BLACT_MAT_FLAGS, normalizedFlags),
        ]
        if (active.remote.movementState === 'idle') {
          writes.push(originalWrite16(
            nextRemoteBinding.blActAddress + BLACT_FACE_INDEX,
            IDLE_FACE_BY_DIRECTION[active.remote.direction],
          ))
        }
        await Promise.all(writes)

        if (bootstrapQuarantine) {
          bootstrapQuarantine = false
          console.info('[PokéRun render] RELEASED MAP-BOOTSTRAP REMOTE', {
            mapId: preparedMapId,
            actor: nextRemoteBinding.actorAddress,
          })
        }

        const logKey = `${preparedMapId}:${nextRemoteBinding.actorAddress}:${matEntry}:${geomFlags}:${matFlags}`
        if (logKey !== lastLogKey) {
          lastLogKey = logKey
          console.info('[PokéRun render] VERIFIED SAME-MAP REMOTE OWNER', {
            mapId: preparedMapId,
            actor: nextRemoteBinding.actorAddress,
            blActAddress: nextRemoteBinding.blActAddress,
            handleAddress: nextRemoteBinding.handleAddress,
            matEntry,
            geomFlags,
            matFlags,
          })
        }
      } catch {
        clearPrepared()
      } finally {
        reading = false
      }
    }

    const unsubscribePresence = multiplayerPresence.subscribe(snapshot => {
      presenceRef.current = snapshot
      const localMapId = snapshot.local?.location.mapId ?? null
      const remoteMapId = snapshot.remote?.location.mapId ?? null
      const transitionActive = Boolean(snapshot.local?.transition || snapshot.remote?.transition)

      if (previousLocalMapId !== null && localMapId !== previousLocalMapId) {
        localMapStableSince = Date.now()
        bootstrapQuarantine = Boolean(
          !transitionActive
          && localMapId !== null
          && remoteMapId !== null
          && localMapId === remoteMapId
        )
        clearPrepared()
      }
      previousLocalMapId = localMapId

      if (transitionActive || localMapId === null || remoteMapId === null || localMapId !== remoteMapId) {
        bootstrapQuarantine = false
        clearPrepared()
        return
      }
      if (!reading) void prepareLiveFamily(true)
    })

    const unsubscribeFrame = runtimeBridge.subscribeEmulatedFrame(() => {
      if (!reading) void prepareLiveFamily()
    })
    const timer = window.setInterval(() => {
      if (!reading) void prepareLiveFamily()
    }, REFRESH_MS)

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
