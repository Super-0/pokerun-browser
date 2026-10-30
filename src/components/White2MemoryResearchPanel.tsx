import { useEffect } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2ActorSystemProbe, type White2ActorHeapEntry, type White2ActorHeapScan } from '../multiplayer/games/White2ActorSystem'
import { POKERUN_NATIVE_TEST_UID } from '../multiplayer/games/White2NativeActor'

const FIELD_ACTOR_SIZE = 0x100
const ACTOR_FLAGS = 0x00
const ACTOR_MOVEMENT_FLAGS = 0x04
const ACTOR_MOVE_CODE = 0x0e
const ACTOR_WPOS = 0x44
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
const BLACT_MATERIAL = 0x00
const BLACT_POSITION = 0x04
const BLACT_FACE = 0x10
const BLACT_RENDER_FLAGS = 0x18
const HANDLE_SIZE = 0x28
const HANDLE_BLACT_INDEX = 0x00
const HANDLE_TEX_MAT = 0x04
const HANDLE_ANIMS = 0x08
const HANDLE_ANIM_COUNT = 0x0c
const HANDLE_ANIM = 0x0e
const HANDLE_STEP = 0x10
const HANDLE_WAIT = 0x12
const HANDLE_LOOPS = 0x14
const HANDLE_ANIMATE = 0x18
const FLDACT_GET_BLACT_IDX = 0x02167240
const NATIVE_STACK_RESERVE = 0x400
const BLACT_NONE = 0xffff
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000
const POLL_MS = 150
const STABLE_MS = 700
const POINTER_HEAD_BYTES = 0x40
const ANIMS_DUMP_BYTES = 0x100

type Binding = {
  sceneNodeVTable: number
  blActIndex: number
  blActAddress: number
  handleAddress: number
  matEntry: number
  anims: number
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 3) === 0
}

function isMainRamFunctionPointer(value: number) {
  const address = value & ~1
  return Number.isInteger(value)
    && address >= MAIN_RAM_START
    && address < MAIN_RAM_END
    && ((value & 1) === 1 || (address & 3) === 0)
}

function hex(value: number) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

function offsetHex(offset: number) {
  return `+0x${offset.toString(16).toUpperCase().padStart(2, '0')}`
}

function bytesHex(bytes: Uint8Array) {
  return [...bytes].map(value => value.toString(16).toUpperCase().padStart(2, '0')).join(' ')
}

function signed32(value: number) {
  return value | 0
}

function readWord(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true)
}

function wordTable(bytes: Uint8Array) {
  const words: Array<{ offset: string; value: string; pointer: boolean }> = []
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
    const value = readWord(bytes, offset)
    words.push({ offset: offsetHex(offset), value: hex(value), pointer: isMainRamPointer(value) })
  }
  return words
}

function diffWords(local: Uint8Array, remote: Uint8Array) {
  const length = Math.min(local.length, remote.length)
  const diffs: Array<{ offset: string; local: string; remote: string; localPointer: boolean; remotePointer: boolean }> = []
  for (let offset = 0; offset + 4 <= length; offset += 4) {
    const localValue = readWord(local, offset)
    const remoteValue = readWord(remote, offset)
    if (localValue === remoteValue) continue
    diffs.push({
      offset: offsetHex(offset),
      local: hex(localValue),
      remote: hex(remoteValue),
      localPointer: isMainRamPointer(localValue),
      remotePointer: isMainRamPointer(remoteValue),
    })
  }
  return diffs
}

async function pointerHeads(bridge: MelonDsBridge, bytes: Uint8Array) {
  const results: Array<{ offset: string; pointer: string; head: string }> = []
  const seen = new Set<number>()
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
    const pointer = readWord(bytes, offset)
    if (!isMainRamPointer(pointer) || seen.has(pointer)) continue
    seen.add(pointer)
    const length = Math.min(POINTER_HEAD_BYTES, MAIN_RAM_END - pointer)
    try {
      const head = await bridge.readBytes(pointer, length)
      results.push({ offset: offsetHex(offset), pointer: hex(pointer), head: bytesHex(head) })
    } catch (reason) {
      results.push({ offset: offsetHex(offset), pointer: hex(pointer), head: `READ FAILED: ${reason instanceof Error ? reason.message : String(reason)}` })
    }
  }
  return results
}

async function resolveBinding(bridge: MelonDsBridge, actor: White2ActorHeapEntry): Promise<Binding | null> {
  const sceneNodeVTable = await bridge.read32(actor.address + ACTOR_SCENE_NODE_VTABLE)
  if (!isMainRamPointer(sceneNodeVTable)) return null
  const getter = await bridge.read32(sceneNodeVTable + SCENE_NODE_GET_BLACT_INDEX)
  if (!isMainRamFunctionPointer(getter)) return null

  const call = await bridge.callArm9Thumb4(FLDACT_GET_BLACT_IDX, actor.address, 0, 0, 0, NATIVE_STACK_RESERVE)
  if (call.status !== 1) return null
  const blActIndex = call.result & 0xffff
  if (blActIndex === BLACT_NONE) return null

  const fieldBlAct = await bridge.read32(actor.actorSystemBackptr + ACTOR_SYSTEM_FIELD_BLACT)
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
    sceneNodeVTable,
    blActIndex,
    blActAddress: sceneActors + blActIndex * BLACT_SIZE,
    handleAddress,
    matEntry: await bridge.read16(handleAddress + HANDLE_TEX_MAT),
    anims: await bridge.read32(handleAddress + HANDLE_ANIMS),
  }
}

async function captureBlock(bridge: MelonDsBridge, address: number, length: number) {
  const bytes = await bridge.readBytes(address, length)
  return {
    address: hex(address),
    length,
    raw: bytesHex(bytes),
    words: wordTable(bytes),
    pointerHeads: await pointerHeads(bridge, bytes),
    bytes,
  }
}

async function captureActorBillboardCensus(bridge: MelonDsBridge, scan: White2ActorHeapScan) {
  const actors: Array<Record<string, unknown>> = []

  for (const actor of scan.entries) {
    if (actor.state === 'zeroed' || actor.actorSystemBackptr !== scan.actorSystem) continue

    const [moveCode, wX, wY, wZ, flags, movementFlags] = await Promise.all([
      bridge.read16(actor.address + ACTOR_MOVE_CODE),
      bridge.read32(actor.address + ACTOR_WPOS + 0x00),
      bridge.read32(actor.address + ACTOR_WPOS + 0x04),
      bridge.read32(actor.address + ACTOR_WPOS + 0x08),
      bridge.read32(actor.address + ACTOR_FLAGS),
      bridge.read32(actor.address + ACTOR_MOVEMENT_FLAGS),
    ])

    const binding = await resolveBinding(bridge, actor)
    let billboard: Record<string, unknown> | null = null
    if (binding) {
      const [materialAndType, blX, blY, blZ, face, renderFlags, texMat, animCount, anim, step, wait, loops, animate] = await Promise.all([
        bridge.read16(binding.blActAddress + BLACT_MATERIAL),
        bridge.read32(binding.blActAddress + BLACT_POSITION + 0x00),
        bridge.read32(binding.blActAddress + BLACT_POSITION + 0x04),
        bridge.read32(binding.blActAddress + BLACT_POSITION + 0x08),
        bridge.read16(binding.blActAddress + BLACT_FACE),
        bridge.read16(binding.blActAddress + BLACT_RENDER_FLAGS),
        bridge.read16(binding.handleAddress + HANDLE_TEX_MAT),
        bridge.read16(binding.handleAddress + HANDLE_ANIM_COUNT),
        bridge.read16(binding.handleAddress + HANDLE_ANIM),
        bridge.read16(binding.handleAddress + HANDLE_STEP),
        bridge.read16(binding.handleAddress + HANDLE_WAIT),
        bridge.read16(binding.handleAddress + HANDLE_LOOPS),
        bridge.read32(binding.handleAddress + HANDLE_ANIMATE),
      ])
      billboard = {
        blActIndex: binding.blActIndex,
        blActAddress: hex(binding.blActAddress),
        handleAddress: hex(binding.handleAddress),
        material: materialAndType & 0x3fff,
        type: materialAndType >>> 14,
        position: { x: signed32(blX), y: signed32(blY), z: signed32(blZ) },
        face,
        renderFlags: `0x${renderFlags.toString(16).toUpperCase().padStart(4, '0')}`,
        texMat,
        anims: hex(binding.anims),
        animCount,
        anim,
        step,
        wait,
        loops,
        animate,
      }
    }

    actors.push({
      slot: actor.index,
      state: actor.state,
      actor: hex(actor.address),
      uid: actor.uid,
      zoneId: actor.zoneId,
      modelId: actor.modelId,
      moveCode,
      flags: hex(flags),
      movementFlags: hex(movementFlags),
      faceDir: actor.faceDir,
      grid: { x: actor.x, height: actor.height, y: actor.y },
      world: { x: signed32(wX), y: signed32(wY), z: signed32(wZ) },
      tcb: hex(actor.tcb),
      moveCodeVTable: hex(actor.moveCodeVTable),
      sceneNodeVTable: hex(actor.sceneNodeVTable),
      billboard,
    })
  }

  return actors
}

/**
 * Dev-only renderer resource research probe.
 *
 * It does not mutate White 2 state. Once P1 and PokéRun's P2 actor are stable
 * and billboard-bound, it captures their resource structures and a census of
 * every allocated FieldActor/BLAct so the visible sprite can be tied to the
 * actor that actually owns its screen position/material.
 */
export function White2MemoryResearchPanel({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return
    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    let cancelled = false
    let busy = false
    let readyKey = ''
    let readySince = 0
    let capturedKey = ''

    async function capture() {
      if (cancelled || busy || runtimeBridge.status !== 'running') return
      busy = true
      try {
        const scan = await probe.scanHeap()
        const local = scan.entries.find(entry => entry.state === 'player') ?? null
        const remotes = scan.entries.filter(entry => entry.uid === POKERUN_NATIVE_TEST_UID)
        const remote = remotes.length === 1 ? remotes[0] : null
        if (!local || !remote || remote.tcb !== 0) {
          readyKey = ''
          readySince = 0
          return
        }

        const [localBinding, remoteBinding] = await Promise.all([
          resolveBinding(runtimeBridge, local),
          resolveBinding(runtimeBridge, remote),
        ])
        if (!localBinding || !remoteBinding) {
          readyKey = ''
          readySince = 0
          return
        }

        const key = `${local.address}:${remote.address}:${localBinding.blActIndex}:${remoteBinding.blActIndex}:${localBinding.handleAddress}:${remoteBinding.handleAddress}`
        if (key !== readyKey) {
          readyKey = key
          readySince = performance.now()
          return
        }
        if (capturedKey === key || performance.now() - readySince < STABLE_MS) return

        const [localActor, remoteActor, localBlAct, remoteBlAct, localHandle, remoteHandle] = await Promise.all([
          captureBlock(runtimeBridge, local.address, FIELD_ACTOR_SIZE),
          captureBlock(runtimeBridge, remote.address, FIELD_ACTOR_SIZE),
          captureBlock(runtimeBridge, localBinding.blActAddress, BLACT_SIZE),
          captureBlock(runtimeBridge, remoteBinding.blActAddress, BLACT_SIZE),
          captureBlock(runtimeBridge, localBinding.handleAddress, HANDLE_SIZE),
          captureBlock(runtimeBridge, remoteBinding.handleAddress, HANDLE_SIZE),
        ])

        const localAnims = isMainRamPointer(localBinding.anims)
          ? await captureBlock(runtimeBridge, localBinding.anims, Math.min(ANIMS_DUMP_BYTES, MAIN_RAM_END - localBinding.anims))
          : null
        const remoteAnims = isMainRamPointer(remoteBinding.anims)
          ? await captureBlock(runtimeBridge, remoteBinding.anims, Math.min(ANIMS_DUMP_BYTES, MAIN_RAM_END - remoteBinding.anims))
          : null
        const census = await captureActorBillboardCensus(runtimeBridge, scan)

        capturedKey = key
        console.info('[PokéRun resdiag] RESOURCE GRAPH SNAPSHOT', {
          purpose: 'read-only P1/P2 visual-resource comparison',
          actorSystem: hex(scan.actorSystem),
          actorHeap: hex(scan.actorHeap),
          actorCapacity: scan.capacity,
          actorCount: scan.count,
          remoteActorCount: remotes.length,
          local: {
            slot: local.index,
            actor: hex(local.address),
            uid: local.uid,
            modelId: local.modelId,
            tcb: hex(local.tcb),
            sceneNodeInline: hex(local.address + ACTOR_SCENE_NODE_VTABLE),
            sceneNodeVTable: hex(localBinding.sceneNodeVTable),
            blActIndex: localBinding.blActIndex,
            blActAddress: hex(localBinding.blActAddress),
            handleAddress: hex(localBinding.handleAddress),
            matEntry: localBinding.matEntry,
            anims: hex(localBinding.anims),
          },
          remote: {
            slot: remote.index,
            actor: hex(remote.address),
            uid: remote.uid,
            modelId: remote.modelId,
            tcb: hex(remote.tcb),
            sceneNodeInline: hex(remote.address + ACTOR_SCENE_NODE_VTABLE),
            sceneNodeVTable: hex(remoteBinding.sceneNodeVTable),
            blActIndex: remoteBinding.blActIndex,
            blActAddress: hex(remoteBinding.blActAddress),
            handleAddress: hex(remoteBinding.handleAddress),
            matEntry: remoteBinding.matEntry,
            anims: hex(remoteBinding.anims),
          },
          diffs: {
            actorWords: diffWords(localActor.bytes, remoteActor.bytes),
            blActWords: diffWords(localBlAct.bytes, remoteBlAct.bytes),
            handleWords: diffWords(localHandle.bytes, remoteHandle.bytes),
            animWords: localAnims && remoteAnims ? diffWords(localAnims.bytes, remoteAnims.bytes) : null,
          },
          localBlocks: {
            actor: { address: localActor.address, raw: localActor.raw, words: localActor.words, pointerHeads: localActor.pointerHeads },
            blAct: { address: localBlAct.address, raw: localBlAct.raw, words: localBlAct.words, pointerHeads: localBlAct.pointerHeads },
            handle: { address: localHandle.address, raw: localHandle.raw, words: localHandle.words, pointerHeads: localHandle.pointerHeads },
            anims: localAnims ? { address: localAnims.address, raw: localAnims.raw, words: localAnims.words, pointerHeads: localAnims.pointerHeads } : null,
          },
          remoteBlocks: {
            actor: { address: remoteActor.address, raw: remoteActor.raw, words: remoteActor.words, pointerHeads: remoteActor.pointerHeads },
            blAct: { address: remoteBlAct.address, raw: remoteBlAct.raw, words: remoteBlAct.words, pointerHeads: remoteBlAct.pointerHeads },
            handle: { address: remoteHandle.address, raw: remoteHandle.raw, words: remoteHandle.words, pointerHeads: remoteHandle.pointerHeads },
            anims: remoteAnims ? { address: remoteAnims.address, raw: remoteAnims.raw, words: remoteAnims.words, pointerHeads: remoteAnims.pointerHeads } : null,
          },
        })
        console.info('[PokéRun resdiag] ACTOR/BILLBOARD CENSUS', {
          purpose: 'identify which allocated actor/billboard owns the visible orange sprite',
          actors: census,
        })
      } catch (reason) {
        console.info('[PokéRun resdiag] PROBE WAITING', {
          reason: reason instanceof Error ? reason.message : String(reason),
        })
      } finally {
        busy = false
      }
    }

    void capture()
    const timer = window.setInterval(() => void capture(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
