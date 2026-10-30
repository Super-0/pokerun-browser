import { useEffect, useRef } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerMapTransition, MultiplayerRomIdentity } from '../core/protocol'
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
const TRANSITION_FRESH_MS = 800
const REFRESH_MS = 48

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
    actorSystem,
    blActIndex,
    blActAddress: sceneActors + blActIndex * BLACT_SIZE,
    handleAddress,
  }
}

/**
 * Single-owner ordinary render guard.
 *
 * The dedicated trainer runtime remains the only code that decides when P2 is
 * visible and which animation face to play. This guard does not periodically
 * "correct" the billboard after the fact. Instead it intercepts P2's render
 * writes and normalizes the material/geometry family before the write reaches
 * melonDS. That prevents bad/cached frames from ever becoming visible and avoids
 * the black-square <-> protagonist oscillation caused by two competing writers.
 */
export function White2SameMapRenderFamilyGuard({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const presenceRef = useRef<MultiplayerPresenceSnapshot>({ local: null, remote: null })

  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return
    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    const originalWrite16 = runtimeBridge.write16.bind(runtimeBridge)

    let cancelled = false
    let refreshing: Promise<void> | null = null
    let previousLocalMapId: number | string | null = null
    let remoteBinding: Binding | null = null
    let protagonistFamily: RenderFamily | null = null
    let preparedMapId: number | string | null = null
    let lastRefreshAt = 0
    let lastLogKey = ''

    function clearPrepared(clearFamily = true) {
      remoteBinding = null
      if (clearFamily) protagonistFamily = null
      preparedMapId = null
      lastRefreshAt = 0
      lastLogKey = ''
    }

    function activeSnapshot() {
      const { local, remote } = presenceRef.current
      if (!local || !remote) return null
      if (local.location.mapId !== remote.location.mapId) return null
      if (transitionFresh(local.transition) || transitionFresh(remote.transition)) return null
      return { local, remote }
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

    async function refresh(force = false) {
      if (cancelled) return
      const active = activeSnapshot()
      if (!active) {
        clearPrepared()
        return
      }

      const now = Date.now()
      if (!force
        && remoteBinding
        && protagonistFamily
        && preparedMapId === active.local.location.mapId
        && now - lastRefreshAt < REFRESH_MS) return
      if (refreshing) return refreshing

      refreshing = (async () => {
        try {
          const scan = await probe.scanHeap()
          const player = scan.entries.find(entry => entry.uid === PLAYER_UID && entry.state === 'player')
          const remoteActor = scan.entries.find(entry =>
            entry.uid === POKERUN_NATIVE_TEST_UID
            && entry.state === 'active'
            && entry.actorSystemBackptr === scan.actorSystem
          )
          if (!player || !remoteActor) {
            remoteBinding = null
            return
          }

          const [playerBinding, nextRemoteBinding] = await Promise.all([
            resolveBinding(runtimeBridge, player.address, scan.actorSystem),
            resolveBinding(runtimeBridge, remoteActor.address, scan.actorSystem),
          ])
          if (!playerBinding || !nextRemoteBinding) {
            remoteBinding = null
            return
          }
          if (playerBinding.actorAddress === nextRemoteBinding.actorAddress
            || playerBinding.blActAddress === nextRemoteBinding.blActAddress
            || playerBinding.handleAddress === nextRemoteBinding.handleAddress) {
            remoteBinding = null
            return
          }

          // Prefer a stable/idle local profile. If P1 is moving, keep the last
          // known family for this map instead of replacing it with a transient
          // animation family. On first acquisition we still sample immediately.
          if (!protagonistFamily || preparedMapId !== active.local.location.mapId || active.local.movementState === 'idle') {
            const [matEntry, geomFlags, matFlags] = await Promise.all([
              runtimeBridge.read16(playerBinding.handleAddress + HANDLE_MAT_ENTRY),
              runtimeBridge.read16(playerBinding.blActAddress + BLACT_GEOM_FLAGS),
              runtimeBridge.read16(playerBinding.blActAddress + BLACT_MAT_FLAGS),
            ])
            protagonistFamily = { matEntry, geomFlags, matFlags }
          }

          remoteBinding = nextRemoteBinding
          preparedMapId = active.local.location.mapId
          lastRefreshAt = now

          if (protagonistFamily) {
            const logKey = `${preparedMapId}:${nextRemoteBinding.actorAddress}:${protagonistFamily.matEntry}:${protagonistFamily.geomFlags}:${protagonistFamily.matFlags}`
            if (logKey !== lastLogKey) {
              lastLogKey = logKey
              console.info('[PokéRun render] PREPARED AUTHORITATIVE REMOTE FAMILY', {
                mapId: preparedMapId,
                actor: nextRemoteBinding.actorAddress,
                blActAddress: nextRemoteBinding.blActAddress,
                handleAddress: nextRemoteBinding.handleAddress,
                ...protagonistFamily,
              })
            }
          }
        } catch {
          remoteBinding = null
        }
      })().finally(() => {
        refreshing = null
      })

      return refreshing
    }

    const wrappedWrite16 = async (address: number, value: number) => {
      const active = activeSnapshot()
      if (!active) return originalWrite16(address, value)

      if (!remoteBinding || !protagonistFamily || preparedMapId !== active.local.location.mapId) {
        // This is the important spawn-time path. P2's first hide/render/reveal
        // writes wait until the live P2 binding and P1 family are known, so an
        // old cached or native profile never gets one visible frame first.
        await refresh(true)
      }

      let binding = remoteBinding
      let family = protagonistFamily
      if (!binding || !family || preparedMapId !== active.local.location.mapId) {
        return originalWrite16(address, value)
      }

      if (!await bindingStillOwned(binding)) {
        clearPrepared(false)
        await refresh(true)
        binding = remoteBinding
        family = protagonistFamily
        if (!binding || !family || preparedMapId !== active.local.location.mapId) {
          return originalWrite16(address, value)
        }
      }

      const isMatEntry = address === binding.handleAddress + HANDLE_MAT_ENTRY
      const isGeomFlags = address === binding.blActAddress + BLACT_GEOM_FLAGS
      const isFaceIndex = address === binding.blActAddress + BLACT_FACE_INDEX
      const isMatFlags = address === binding.blActAddress + BLACT_MAT_FLAGS
      if (!isMatEntry && !isGeomFlags && !isFaceIndex && !isMatFlags) {
        return originalWrite16(address, value)
      }

      if (isMatEntry) return originalWrite16(address, family.matEntry)
      if (isGeomFlags) return originalWrite16(address, family.geomFlags)
      if (isMatFlags) {
        // Dedicated runtime owns visibility; preserve only its visible bit.
        const normalized = (family.matFlags & ~BLACT_VISIBLE_MASK) | (value & BLACT_VISIBLE_MASK)
        return originalWrite16(address, normalized)
      }
      if (isFaceIndex && active.remote.movementState === 'idle') {
        return originalWrite16(address, IDLE_FACE_BY_DIRECTION[active.remote.direction])
      }
      return originalWrite16(address, value)
    }

    runtimeBridge.write16 = wrappedWrite16

    const unsubscribePresence = multiplayerPresence.subscribe(snapshot => {
      presenceRef.current = snapshot
      const localMapId = snapshot.local?.location.mapId ?? null
      if (previousLocalMapId !== null && localMapId !== previousLocalMapId) {
        clearPrepared()
      }
      previousLocalMapId = localMapId
      if (activeSnapshot()) void refresh()
    })

    const unsubscribeFrame = runtimeBridge.subscribeEmulatedFrame(() => {
      if (activeSnapshot()) void refresh()
    })

    const timer = window.setInterval(() => {
      if (activeSnapshot()) void refresh()
    }, REFRESH_MS)

    return () => {
      cancelled = true
      unsubscribePresence()
      unsubscribeFrame()
      window.clearInterval(timer)
      if (runtimeBridge.write16 === wrappedWrite16) runtimeBridge.write16 = originalWrite16
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
