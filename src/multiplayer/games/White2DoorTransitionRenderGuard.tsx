import { useEffect, useRef, useState } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerRomIdentity } from '../core/protocol'
import { White2ActorSystemProbe } from './White2ActorSystem'
import { White2DoorDepartureRenderGuardV2 } from './White2DoorDepartureRenderGuardV2'
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
const ARRIVAL_VISIBILITY_GATE_MS = 1200
const FIELD_FAMILY_STABLE_SAMPLES = 6
const FIELD_FAMILY_CHECK_MS = 40

type Binding = {
  actorAddress: number
  blActAddress: number
  handleAddress: number
}

type RenderFamily = {
  matEntry: number
  geomFlags: number
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
  const [matEntry, geomFlags] = await Promise.all([
    bridge.read16(binding.handleAddress + HANDLE_MAT_ENTRY),
    bridge.read16(binding.blActAddress + BLACT_GEOM_FLAGS),
  ])
  return { matEntry, geomFlags }
}

function sameFamily(a: RenderFamily, b: RenderFamily) {
  return a.matEntry === b.matEntry && a.geomFlags === b.geomFlags
}

async function setBindingVisible(bridge: MelonDsBridge, binding: Binding, visible: boolean) {
  const flagsAddress = binding.blActAddress + BLACT_MAT_FLAGS
  const flags = await bridge.read16(flagsAddress)
  const next = visible
    ? flags | BLACT_VISIBLE_MASK
    : flags & ~BLACT_VISIBLE_MASK
  if (next !== flags) await bridge.write16(flagsAddress, next)
}

/**
 * Arrival-only safety gate. White 2 can briefly expose a native/duplicate actor
 * while the dedicated multiplayer actor is being rebound after an off-map stay.
 * During the arrival handoff, hide every dedicated actor whose material/geometry
 * family does not yet match the live protagonist. Once the runtime has written a
 * valid protagonist family, it is left completely alone.
 */
function White2DoorArrivalVisibilityGate({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const presenceRef = useRef<MultiplayerPresenceSnapshot>({ local: null, remote: null })

  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return
    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    let cancelled = false
    let reading = false
    let activeUntil = 0
    let activeTransitionId = ''
    const hiddenActors = new Set<number>()

    async function service() {
      if (cancelled || reading || runtimeBridge.status !== 'running') return
      if (Date.now() >= activeUntil) return
      reading = true
      try {
        const scan = await probe.scanHeap()
        const player = scan.entries.find(entry => entry.uid === PLAYER_UID && entry.state === 'player')
        const remoteActors = scan.entries.filter(entry => entry.uid === POKERUN_NATIVE_TEST_UID && entry.state === 'active')
        if (!player || remoteActors.length === 0) return

        const playerBinding = await resolveBinding(runtimeBridge, player.address, scan.actorSystem)
        if (!playerBinding) return
        const protagonistFamily = await readFamily(runtimeBridge, playerBinding)

        for (const actor of remoteActors) {
          const binding = await resolveBinding(runtimeBridge, actor.address, scan.actorSystem)
          if (!binding) continue
          const family = await readFamily(runtimeBridge, binding)
          if (sameFamily(family, protagonistFamily)) continue

          await setBindingVisible(runtimeBridge, binding, false)
          if (!hiddenActors.has(actor.address)) {
            hiddenActors.add(actor.address)
            console.info('[PokéRun arrival] HID NON-PROTAGONIST REMOTE ACTOR', {
              transition: activeTransitionId,
              actor: actor.address,
              protagonistFamily,
              remoteFamily: family,
            })
          }
        }
      } catch {
        // Best-effort visual guard; dedicated runtime owns lifecycle recovery.
      } finally {
        reading = false
      }
    }

    const unsubscribePresence = multiplayerPresence.subscribe(snapshot => {
      presenceRef.current = snapshot
      const { local, remote } = snapshot
      const transition = remote?.transition
      if (
        local
        && remote
        && transition
        && transition.fromMapId !== transition.toMapId
        && local.location.mapId === transition.toMapId
        && remote.location.mapId === transition.toMapId
      ) {
        if (activeTransitionId !== transition.id) {
          activeTransitionId = transition.id
          hiddenActors.clear()
          console.info('[PokéRun arrival] VISIBILITY GATE ACTIVE', {
            id: transition.id,
            fromMapId: transition.fromMapId,
            toMapId: transition.toMapId,
            gateMs: ARRIVAL_VISIBILITY_GATE_MS,
          })
        }
        activeUntil = Math.max(activeUntil, Date.now() + ARRIVAL_VISIBILITY_GATE_MS)
        void service()
      }
    })

    const unsubscribeFrame = runtimeBridge.subscribeEmulatedFrame(() => {
      void service()
    })
    const timer = window.setInterval(() => void service(), 16)

    return () => {
      cancelled = true
      unsubscribePresence()
      unsubscribeFrame()
      window.clearInterval(timer)
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}

/**
 * When the local player follows an already-off-map remote into its field, the
 * dedicated actor can briefly be rebound with the wrong billboard atlas. Never
 * repair that by rewriting animation data: normal walk frames may legitimately
 * differ from idle. Instead, keep only a mismatched actor invisible until the
 * dedicated runtime naturally produces the same material/geometry family as the
 * live local protagonist, then reveal it after several stable samples.
 */
function White2SameMapFieldFamilyGuard({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const presenceRef = useRef<MultiplayerPresenceSnapshot>({ local: null, remote: null })

  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return
    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    let cancelled = false
    let reading = false
    let previousLocalMapId: number | string | null = null
    let activeMapId: number | string | null = null
    let stableSamples = 0
    const hiddenActors = new Set<number>()

    async function service() {
      if (cancelled || reading || runtimeBridge.status !== 'running' || activeMapId === null) return
      const { local, remote } = presenceRef.current
      if (!local || !remote || local.location.mapId !== remote.location.mapId || local.location.mapId !== activeMapId) {
        activeMapId = null
        stableSamples = 0
        hiddenActors.clear()
        return
      }

      reading = true
      try {
        const scan = await probe.scanHeap()
        const player = scan.entries.find(entry => entry.uid === PLAYER_UID && entry.state === 'player')
        const remoteActors = scan.entries.filter(entry => entry.uid === POKERUN_NATIVE_TEST_UID && entry.state === 'active')
        if (!player || remoteActors.length === 0) {
          stableSamples = 0
          return
        }

        const playerBinding = await resolveBinding(runtimeBridge, player.address, scan.actorSystem)
        if (!playerBinding) {
          stableSamples = 0
          return
        }
        const protagonistFamily = await readFamily(runtimeBridge, playerBinding)
        const matchedBindings: Binding[] = []
        let allMatched = true

        for (const actor of remoteActors) {
          const binding = await resolveBinding(runtimeBridge, actor.address, scan.actorSystem)
          if (!binding) {
            allMatched = false
            stableSamples = 0
            continue
          }

          const remoteFamily = await readFamily(runtimeBridge, binding)
          const matched = sameFamily(remoteFamily, protagonistFamily)
          if (!matched) {
            allMatched = false
            stableSamples = 0
            hiddenActors.add(actor.address)
            await setBindingVisible(runtimeBridge, binding, false)
            console.info('[PokéRun field] HID UNSTABLE REMOTE RENDER FAMILY', {
              mapId: activeMapId,
              actor: actor.address,
              protagonistFamily,
              remoteFamily,
            })
            continue
          }

          matchedBindings.push(binding)
          if (hiddenActors.has(actor.address)) {
            // Once an actor has been quarantined, keep it invisible until the
            // family remains valid for several consecutive samples.
            await setBindingVisible(runtimeBridge, binding, false)
          }
        }

        if (!allMatched) return

        stableSamples += 1
        if (stableSamples < FIELD_FAMILY_STABLE_SAMPLES) return

        for (const binding of matchedBindings) {
          if (!hiddenActors.has(binding.actorAddress)) continue
          await setBindingVisible(runtimeBridge, binding, true)
          console.info('[PokéRun field] RELEASED STABLE REMOTE RENDER FAMILY', {
            mapId: activeMapId,
            actor: binding.actorAddress,
            samples: stableSamples,
          })
        }

        activeMapId = null
        stableSamples = 0
        hiddenActors.clear()
      } catch {
        stableSamples = 0
        // Best-effort visibility quarantine. Dedicated runtime remains authoritative.
      } finally {
        reading = false
      }
    }

    const unsubscribePresence = multiplayerPresence.subscribe(snapshot => {
      presenceRef.current = snapshot
      const localMapId = snapshot.local?.location.mapId ?? null
      const remoteMapId = snapshot.remote?.location.mapId ?? null
      const localChanged = previousLocalMapId !== null && localMapId !== null && previousLocalMapId !== localMapId

      if (localChanged && localMapId === remoteMapId) {
        activeMapId = localMapId
        stableSamples = 0
        hiddenActors.clear()
        console.info('[PokéRun field] REMOTE RENDER FAMILY QUARANTINE', { mapId: localMapId })
        void service()
      }
      previousLocalMapId = localMapId
    })

    const unsubscribeFrame = runtimeBridge.subscribeEmulatedFrame(() => {
      void service()
    })
    const timer = window.setInterval(() => void service(), FIELD_FAMILY_CHECK_MS)

    return () => {
      cancelled = true
      unsubscribePresence()
      unsubscribeFrame()
      window.clearInterval(timer)
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}

/**
 * Keeps the proven departure renderer intact and layers narrowly-scoped arrival
 * and local-field visibility guards beside it. The V2 departure guard mounts one
 * effect turn later so its ordering matches the stable pre-bidirectional setup.
 */
export function White2DoorTransitionRenderGuard({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const [departureGuardMounted, setDepartureGuardMounted] = useState(false)

  useEffect(() => {
    setDepartureGuardMounted(true)
  }, [])

  return <>
    <White2DoorArrivalVisibilityGate bridge={bridge} rom={rom}/>
    <White2SameMapFieldFamilyGuard bridge={bridge} rom={rom}/>
    {departureGuardMounted ? <White2DoorDepartureRenderGuardV2 bridge={bridge} rom={rom}/> : null}
  </>
}
