import { useEffect } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerRomIdentity } from '../core/protocol'
import { White2ActorSystemProbe, White2ActorSystemUnavailableError, type White2ActorHeapEntry } from '../games/White2ActorSystem'

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
const SAMPLE_MS = 60

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

function hex(value: number | null | undefined) {
  return value == null ? null : `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

async function readBillboard(bridge: MelonDsBridge, actor: White2ActorHeapEntry) {
  const sceneNodeVTable = await bridge.read32(actor.address + ACTOR_SCENE_NODE_VTABLE)
  if (!isMainRamPointer(sceneNodeVTable)) return { state: 'scene-node-unavailable', sceneNodeVTable: hex(sceneNodeVTable) }

  const getter = await bridge.read32(sceneNodeVTable + SCENE_NODE_GET_BLACT_INDEX)
  if (!isMainRamFunctionPointer(getter)) return { state: 'billboard-getter-unavailable', getter: hex(getter) }

  const call = await bridge.callArm9Thumb4(FLDACT_GET_BLACT_IDX, actor.address, 0, 0, 0, NATIVE_STACK_RESERVE)
  if (call.status !== 1) return { state: 'billboard-index-call-failed', status: call.status, pc: hex(call.pc) }

  const blActIndex = call.result & 0xffff
  if (blActIndex === BLACT_NONE) return { state: 'no-billboard', blActIndex }

  const fieldBlAct = await bridge.read32(actor.actorSystemBackptr + ACTOR_SYSTEM_FIELD_BLACT)
  if (!isMainRamPointer(fieldBlAct)) return { state: 'field-blact-unavailable', blActIndex, fieldBlAct: hex(fieldBlAct) }
  const blActSystem = await bridge.read32(fieldBlAct + FIELD_BLACT_SYSTEM)
  if (!isMainRamPointer(blActSystem)) return { state: 'blact-system-unavailable', blActIndex, blActSystem: hex(blActSystem) }

  const [scene, handles, handleCount] = await Promise.all([
    bridge.read32(blActSystem + BLACT_SYSTEM_SCENE),
    bridge.read32(blActSystem + BLACT_SYSTEM_ACTOR_HANDLES),
    bridge.read16(blActSystem + BLACT_SYSTEM_ACTOR_COUNT),
  ])
  if (!isMainRamPointer(scene) || !isMainRamPointer(handles)) {
    return { state: 'blact-arrays-unavailable', blActIndex, scene: hex(scene), handles: hex(handles), handleCount }
  }

  const [sceneActors, sceneActorCount] = await Promise.all([
    bridge.read32(scene + BLACT_SCENE_ACTORS),
    bridge.read16(scene + BLACT_SCENE_CONFIG_ACTOR_COUNT),
  ])
  if (!isMainRamPointer(sceneActors) || blActIndex >= sceneActorCount) {
    return { state: 'blact-entry-unavailable', blActIndex, sceneActors: hex(sceneActors), sceneActorCount }
  }

  let handleAddress = 0
  for (let index = 0; index < handleCount; index += 1) {
    const candidate = handles + index * HANDLE_SIZE
    if ((await bridge.read32(candidate + HANDLE_BLACT_INDEX)) === blActIndex) {
      if (handleAddress !== 0) return { state: 'duplicate-billboard-handles', blActIndex }
      handleAddress = candidate
    }
  }
  if (!handleAddress) return { state: 'billboard-handle-missing', blActIndex }

  const blActAddress = sceneActors + blActIndex * BLACT_SIZE
  const [matEntry, faceIndex, geomFlags, matFlags] = await Promise.all([
    bridge.read16(handleAddress + HANDLE_MAT_ENTRY),
    bridge.read16(blActAddress + BLACT_FACE_INDEX),
    bridge.read16(blActAddress + BLACT_GEOM_FLAGS),
    bridge.read16(blActAddress + BLACT_MAT_FLAGS),
  ])

  return {
    state: 'bound',
    blActIndex,
    blActAddress: hex(blActAddress),
    handleAddress: hex(handleAddress),
    matEntry,
    faceIndex,
    geomFlags,
    matFlags,
  }
}

/** Dev-only trace of the real protagonist's renderer, for comparison with the remote actor. */
export function White2LocalRenderDiagnostics({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return
    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    let cancelled = false
    let reading = false
    let lastSignature = ''
    let presence: MultiplayerPresenceSnapshot = { local: null, remote: null }

    const unsubscribePresence = multiplayerPresence.subscribe(snapshot => { presence = snapshot })

    async function sample() {
      if (cancelled || reading || runtimeBridge.status !== 'running') return
      reading = true
      try {
        const scan = await probe.scanHeap()
        if (cancelled) return
        const player = scan.entries.find(entry => entry.state === 'player') ?? null
        const billboard = player ? await readBillboard(runtimeBridge, player) : null
        if (cancelled) return

        const snapshot = {
          localMap: presence.local?.location.mapId ?? null,
          localTransition: presence.local?.transition?.id ?? null,
          playerActor: player ? {
            address: hex(player.address),
            modelId: player.modelId,
            actorSystemBackptr: hex(player.actorSystemBackptr),
          } : null,
          billboard,
        }
        const signature = JSON.stringify(snapshot)
        if (signature !== lastSignature) {
          lastSignature = signature
          console.info('[PokéRun localdiag]', snapshot)
        }
      } catch (reason) {
        const snapshot = {
          localMap: presence.local?.location.mapId ?? null,
          localTransition: presence.local?.transition?.id ?? null,
          state: reason instanceof White2ActorSystemUnavailableError ? 'field-unavailable' : 'read-error',
          reason: reason instanceof Error ? reason.message : String(reason),
        }
        const signature = JSON.stringify(snapshot)
        if (signature !== lastSignature) {
          lastSignature = signature
          console.info('[PokéRun localdiag]', snapshot)
        }
      } finally {
        reading = false
      }
    }

    void sample()
    const timer = window.setInterval(() => void sample(), SAMPLE_MS)
    return () => {
      cancelled = true
      unsubscribePresence()
      window.clearInterval(timer)
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
