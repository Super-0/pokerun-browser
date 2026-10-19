import { useEffect, useRef } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerPlayerState, MultiplayerRomIdentity, MultiplayerWorldPosition } from '../core/protocol'
import { POKERUN_NATIVE_TEST_UID, White2NativeActorBridge } from './White2NativeActor'
import { White2ActorSystemProbe } from './White2ActorSystem'

const ACTOR_UID = 0x08
const ACTOR_FACE_DIR = 0x18
const ACTOR_GPOS = 0x3c
const ACTOR_WPOS = 0x44
const ACTOR_SYSTEM_BACKPTR = 0x88
const ACTOR_SYSTEM_FIELD_BLACT = 0x28

const FIELD_BLACT_SYSTEM = 0x04
const BLACT_SYSTEM_SCENE = 0x04
const BLACT_SYSTEM_ACTOR_HANDLES = 0x18
const BLACT_SYSTEM_ACTOR_COUNT = 0x1c
const BLACT_SCENE_ACTORS = 0x08
const BLACT_SCENE_CONFIG_ACTOR_COUNT = 0x0e

const BLACT_SIZE = 0x1c
const BLACT_POSITION = 0x04
const HANDLE_SIZE = 0x28
const HANDLE_BLACT_INDEX = 0x00

const FLDACT_GET_BLACT_IDX = 0x02167240
const NATIVE_STACK_RESERVE = 0x400
const BLACT_NONE = 0xffff
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000

const UPDATE_MS = 20
const ENTER_REMOTE_DX = 6
const ENTER_REMOTE_DY = 4
const EXIT_REMOTE_DX = 7
const EXIT_REMOTE_DY = 5
const MAP_STABLE_MS = 280
const MISSING_STATE_GRACE_MS = 160
const REACQUIRE_COOLDOWN_MS = 250
const BIND_TIMEOUT_MS = 1800
const SMOOTHING_ALPHA = 0.72
const SMOOTHING_SNAP_FX32 = 16 * 4096
const SMOOTHING_EPSILON_FX32 = 64

const FIELD_FACE_BY_DIRECTION = { north: 0, south: 1, west: 2, east: 3 } as const

type DedicatedBinding = {
  actorAddress: number
  actorSystem: number
  blActIndex: number
  blActAddress: number
  handleAddress: number
}

function delay(ms: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms))
}

function signed32(value: number) {
  return value | 0
}

function smoothFx32(current: number, target: number) {
  const currentSigned = signed32(current)
  const targetSigned = signed32(target)
  const delta = targetSigned - currentSigned
  if (Math.abs(delta) >= SMOOTHING_SNAP_FX32 || Math.abs(delta) <= SMOOTHING_EPSILON_FX32) return target >>> 0
  return Math.round(currentSigned + delta * SMOOTHING_ALPHA) >>> 0
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 0x3) === 0
}

function assertMainRamPointer(value: number, label: string) {
  if (!isMainRamPointer(value)) throw new Error(`${label} is not a valid White 2 main-RAM pointer.`)
}

async function getNativeBlActIndex(bridge: MelonDsBridge, actorAddress: number) {
  const call = await bridge.callArm9Thumb4(FLDACT_GET_BLACT_IDX, actorAddress, 0, 0, 0, NATIVE_STACK_RESERVE)
  if (call.status !== 1) throw new Error(`FldAct_GetBlActIdx native call failed with status ${call.status}.`)
  return call.result & 0xffff
}

async function resolveDedicatedBinding(bridge: MelonDsBridge, actorAddress: number): Promise<DedicatedBinding> {
  const deadline = performance.now() + BIND_TIMEOUT_MS
  while (performance.now() < deadline) {
    if (await bridge.read16(actorAddress + ACTOR_UID) !== POKERUN_NATIVE_TEST_UID) {
      throw new Error('Dedicated White 2 trainer actor disappeared before its billboard binding was ready.')
    }

    const actorSystem = await bridge.read32(actorAddress + ACTOR_SYSTEM_BACKPTR)
    assertMainRamPointer(actorSystem, 'Dedicated actor system')

    const blActIndex = await getNativeBlActIndex(bridge, actorAddress)
    if (blActIndex !== BLACT_NONE) {
      const fieldBlAct = await bridge.read32(actorSystem + ACTOR_SYSTEM_FIELD_BLACT)
      assertMainRamPointer(fieldBlAct, 'FieldBlAct')
      const blActSystem = await bridge.read32(fieldBlAct + FIELD_BLACT_SYSTEM)
      assertMainRamPointer(blActSystem, 'BlActSystem')
      const [scene, actorHandles, handleCount] = await Promise.all([
        bridge.read32(blActSystem + BLACT_SYSTEM_SCENE),
        bridge.read32(blActSystem + BLACT_SYSTEM_ACTOR_HANDLES),
        bridge.read16(blActSystem + BLACT_SYSTEM_ACTOR_COUNT),
      ])
      assertMainRamPointer(scene, 'BlAct scene')
      assertMainRamPointer(actorHandles, 'BlAct handle array')
      const [sceneActors, sceneActorCount] = await Promise.all([
        bridge.read32(scene + BLACT_SCENE_ACTORS),
        bridge.read16(scene + BLACT_SCENE_CONFIG_ACTOR_COUNT),
      ])
      assertMainRamPointer(sceneActors, 'BlAct actor array')

      if (blActIndex < sceneActorCount) {
        const matches: number[] = []
        for (let index = 0; index < handleCount; index += 1) {
          const handleAddress = actorHandles + index * HANDLE_SIZE
          if ((await bridge.read32(handleAddress + HANDLE_BLACT_INDEX)) === blActIndex) matches.push(handleAddress)
        }
        if (matches.length === 1) {
          return {
            actorAddress,
            actorSystem,
            blActIndex,
            blActAddress: sceneActors + blActIndex * BLACT_SIZE,
            handleAddress: matches[0],
          }
        }
      }
    }
    await delay(16)
  }
  throw new Error('Dedicated White 2 trainer billboard binding did not become ready in time.')
}

async function bindingStillValid(bridge: MelonDsBridge, binding: DedicatedBinding) {
  const [uid, actorSystem, owner] = await Promise.all([
    bridge.read16(binding.actorAddress + ACTOR_UID),
    bridge.read32(binding.actorAddress + ACTOR_SYSTEM_BACKPTR),
    bridge.read32(binding.handleAddress + HANDLE_BLACT_INDEX),
  ])
  return uid === POKERUN_NATIVE_TEST_UID && actorSystem === binding.actorSystem && owner === binding.blActIndex
}

/**
 * Phase 2 production path: keep a real, game-created White 2 FieldActor alive for
 * the remote player instead of borrowing an NPC. This intentionally leaves the
 * actor's own model/material/animation system untouched for the first persistent
 * lifecycle test. PokéRun only drives logical tile position, continuous WPos,
 * facing, and billboard X/Z. BlAct Y remains entirely game-owned.
 */
export function White2DedicatedTrainerRuntime({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const presenceRef = useRef<MultiplayerPresenceSnapshot>({ local: null, remote: null })

  useEffect(() => multiplayerPresence.subscribe(snapshot => {
    presenceRef.current = snapshot
  }), [])

  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return
    const runtimeBridge = bridge
    const nativeActors = new White2NativeActorBridge(runtimeBridge, rom)

    let cancelled = false
    let binding: DedicatedBinding | null = null
    let renderedWorld: MultiplayerWorldPosition | null = null
    let stableMapId: MultiplayerPlayerState['location']['mapId'] | null = null
    let stableMapSince = 0
    let lastCompletePresenceAt = 0
    let rangeLatched = false
    let reacquireAfter = 0
    let lastError = ''

    function resetMotion() {
      renderedWorld = null
    }

    async function releaseActor(cooldown = true) {
      const hadActor = binding !== null
      binding = null
      resetMotion()
      if (!hadActor) return
      if (cooldown) reacquireAfter = Math.max(reacquireAfter, Date.now() + REACQUIRE_COOLDOWN_MS)
      try {
        // Resolve by PokéRun UID in the current actor system rather than deleting
        // a possibly stale address after a map transition.
        await nativeActors.deleteTestActor()
      } catch {
        // A map transition may already have destroyed the old actor system.
      }
    }

    async function ensureActor(remote: MultiplayerPlayerState) {
      if (binding && await bindingStillValid(runtimeBridge, binding)) return binding
      binding = null
      resetMotion()
      if (Date.now() < reacquireAfter) return null

      // The proven native lifecycle currently creates the Union Room model one
      // tile from the local player. We immediately move it to the remote WPos
      // before exposing the binding to the steady-state loop.
      const spawned = await nativeActors.spawnTestActor()
      const next = await resolveDedicatedBinding(runtimeBridge, spawned.actorAddress)
      const world = remote.worldPosition
      if (!world) {
        await nativeActors.deleteTestActor().catch(() => undefined)
        return null
      }
      await Promise.all([
        runtimeBridge.write16(next.actorAddress + ACTOR_FACE_DIR, FIELD_FACE_BY_DIRECTION[remote.direction]),
        runtimeBridge.write16(next.actorAddress + ACTOR_GPOS + 0x00, remote.x),
        runtimeBridge.write16(next.actorAddress + ACTOR_GPOS + 0x04, remote.y),
        runtimeBridge.write32(next.actorAddress + ACTOR_WPOS + 0x00, world.x >>> 0),
        runtimeBridge.write32(next.actorAddress + ACTOR_WPOS + 0x04, world.y >>> 0),
        runtimeBridge.write32(next.actorAddress + ACTOR_WPOS + 0x08, world.z >>> 0),
        runtimeBridge.write32(next.blActAddress + BLACT_POSITION + 0x00, world.x >>> 0),
        runtimeBridge.write32(next.blActAddress + BLACT_POSITION + 0x08, world.z >>> 0),
      ])
      renderedWorld = { ...world }
      binding = next
      return next
    }

    async function tick() {
      const now = Date.now()
      const presence = presenceRef.current
      const local = presence.local
      const remote = presence.remote

      if (!local?.worldPosition || !remote?.worldPosition) {
        if (binding && now - lastCompletePresenceAt > MISSING_STATE_GRACE_MS) {
          rangeLatched = false
          stableMapId = null
          stableMapSince = 0
          await releaseActor()
        }
        return
      }
      lastCompletePresenceAt = now

      if (local.location.mapId !== remote.location.mapId) {
        rangeLatched = false
        stableMapId = null
        stableMapSince = 0
        await releaseActor()
        return
      }

      const currentMapId = local.location.mapId
      if (stableMapId !== currentMapId) {
        stableMapId = currentMapId
        stableMapSince = now
        rangeLatched = false
        await releaseActor()
        return
      }

      if (now - stableMapSince < MAP_STABLE_MS) {
        await releaseActor(false)
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
        await releaseActor()
        return
      }

      const current = await ensureActor(remote)
      if (!current) return
      const targetWorld = remote.worldPosition
      renderedWorld = renderedWorld ? {
        x: smoothFx32(renderedWorld.x, targetWorld.x),
        y: targetWorld.y,
        z: smoothFx32(renderedWorld.z, targetWorld.z),
      } : { ...targetWorld }
      const world = renderedWorld

      await Promise.all([
        runtimeBridge.write16(current.actorAddress + ACTOR_FACE_DIR, FIELD_FACE_BY_DIRECTION[remote.direction]),
        // Keep the actor's logical grid position aligned with the remote player
        // so White 2's own field/collision bookkeeping is not left at spawn tile.
        runtimeBridge.write16(current.actorAddress + ACTOR_GPOS + 0x00, remote.x),
        runtimeBridge.write16(current.actorAddress + ACTOR_GPOS + 0x04, remote.y),
        runtimeBridge.write32(current.actorAddress + ACTOR_WPOS + 0x00, world.x >>> 0),
        runtimeBridge.write32(current.actorAddress + ACTOR_WPOS + 0x04, world.y >>> 0),
        runtimeBridge.write32(current.actorAddress + ACTOR_WPOS + 0x08, world.z >>> 0),
        // Keep native billboard horizontal position synchronized with the actor.
        // Never force BlAct Y; White 2 owns vertical sprite/shadow motion.
        runtimeBridge.write32(current.blActAddress + BLACT_POSITION + 0x00, world.x >>> 0),
        runtimeBridge.write32(current.blActAddress + BLACT_POSITION + 0x08, world.z >>> 0),
      ])
    }

    async function run() {
      while (!cancelled) {
        try {
          if (runtimeBridge.status === 'running') {
            await tick()
            lastError = ''
          }
        } catch (reason) {
          rangeLatched = false
          stableMapId = null
          stableMapSince = 0
          await releaseActor()
          const message = reason instanceof Error ? reason.message : String(reason)
          if (message !== lastError) {
            lastError = message
            console.warn('White 2 dedicated trainer runtime paused:', reason)
          }
          await delay(200)
        }
        await delay(UPDATE_MS)
      }
    }

    void run()
    return () => {
      cancelled = true
      if (runtimeBridge.status === 'running') void releaseActor(false)
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
