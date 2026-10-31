import { useEffect } from 'react'
import type { Arm9NativeCallResult, MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2ActorSystemProbe } from '../multiplayer/games/White2ActorSystem'
import { POKERUN_NATIVE_TEST_UID } from '../multiplayer/games/White2NativeActor'

// Probe 8: visibly prove White 2 owns the complete native communication actor
// path (FieldActor + billboard + movement/facing/visibility) while leaving the
// existing PokéRun fake-P2 actor untouched.
const FLD_COMM_ACT_SYS_CREATE = 0x0218ae78
const FLD_COMM_ACT_SYS_FREE = 0x0218aebc
const FLD_COMM_ACT_SYS_CREATE_ACTOR = 0x0218aef4
const FLD_COMM_ACT_SYS_DELETE_ACTOR = 0x0218af48
const GFL_TCB_MGR_ADD_TASK = 0x0203a640
const GFL_TCB_REMOVE = 0x0203a6d4
const FLDACT_GET_BLACT_IDX = 0x02167240

const MMSYS_HEAP_ID = 0x08
const MMSYS_TCB_MGR = 0x24
const ACTOR_UID = 0x08
const ACTOR_MODEL_ID = 0x0c
const ACTOR_MOVE_CODE = 0x0e
const ACTOR_FACE_DIR = 0x18
const ACTOR_DRAW_STATUS = 0x2a
const ACTOR_WPOS = 0x44
const ACTOR_TCB = 0x84
const ACTOR_SYSTEM_BACKPTR = 0x88
const ACTOR_MOVE_CODE_VTABLE = 0x8c

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
const HANDLE_ANIM = 0x0e
const HANDLE_ANIMATE = 0x18
const BLACT_NONE = 0xffff
const BLACT_VISIBLE_MASK = 0x0200

const MOVE_CODE_COMM_ACTOR = 0x44
const MOVE_CODE_COMM_ACTOR_TABLE = 0x021cc418
const NATIVE_COMM_UID = 0x00fc
const PROBE_NET_ID = 0x70000008
const COMM_ENTRY_SIZE = 0x0c
const COMM_COUNT = 3
const FX32_TILE = 0x10000

const FIELD_ACTOR_SIZE = 0x100
const TASK_DATA_OFFSET = 0x94
const TASK_CODE_OFFSET = 0xd0
const TASK_SCRATCH_SIZE = FIELD_ACTOR_SIZE - TASK_DATA_OFFSET
const TASK_RESULT_OFFSET = 0x1c
const TASK_STATUS_OFFSET = 0x20
const TASK_TIMEOUT_FRAMES = 900
const NATIVE_STACK_RESERVE = 0x400
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000
const POLL_MS = 150
const STABLE_MS = 700

const SIX_ARG_FIELD_TASK_TRAMPOLINE = Uint8Array.from([
  0xf0, 0xb5, 0x04, 0x1c, 0x0d, 0x1c, 0x2e, 0x68,
  0x68, 0x68, 0xa9, 0x68, 0xea, 0x68, 0x2b, 0x69,
  0x83, 0xb0, 0x6f, 0x69, 0x00, 0x97, 0xaf, 0x69,
  0x01, 0x97, 0xb0, 0x47, 0x03, 0xb0, 0xe8, 0x61,
  0x20, 0x1c, 0x02, 0x4e, 0xb0, 0x47, 0x01, 0x27,
  0x2f, 0x62, 0xf0, 0xbd, 0xd5, 0xa6, 0x03, 0x02,
])

function delay(ms: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms))
}

function hex(value: number) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

function signed32(value: number) {
  return value | 0
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 3) === 0
}

function assertPointer(value: number, label: string) {
  if (!isMainRamPointer(value)) throw new Error(`${label} is not a valid main-RAM pointer: ${hex(value)}.`)
}

function assertCall(call: Arm9NativeCallResult, label: string) {
  if (call.status !== 1) throw new Error(`${label} failed (status ${call.status}, PC ${hex(call.pc)}).`)
}

async function waitForFrames(bridge: MelonDsBridge, count: number) {
  await new Promise<void>((resolve, reject) => {
    let frames = 0
    const timeout = window.setTimeout(() => {
      unsubscribe()
      reject(new Error(`Probe 8 timed out waiting for ${count} emulated frames.`))
    }, Math.max(5000, count * 40))
    const unsubscribe = bridge.subscribeEmulatedFrame(() => {
      frames += 1
      if (frames < count) return
      window.clearTimeout(timeout)
      unsubscribe()
      resolve()
    })
  })
}

async function runScheduledCall6(
  bridge: MelonDsBridge,
  probe: White2ActorSystemProbe,
  functionAddress: number,
  args: readonly [number, number, number, number, number, number],
  label: string,
  mayCreateActor = false,
) {
  const scan = await probe.scanHeap()
  const zeroed = scan.entries.filter(entry => entry.state === 'zeroed').sort((a, b) => a.index - b.index)
  const required = mayCreateActor ? 2 : 1
  if (zeroed.length < required) throw new Error(`${label} needs ${required} free actor slots; found ${zeroed.length}.`)

  const scratchSlot = zeroed[zeroed.length - 1]
  const dataAddress = scratchSlot.address + TASK_DATA_OFFSET
  const codeAddress = scratchSlot.address + TASK_CODE_OFFSET
  const original = await bridge.readBytes(dataAddress, TASK_SCRATCH_SIZE)
  const tcbManager = await bridge.read32(scan.actorSystem + MMSYS_TCB_MGR)
  assertPointer(tcbManager, `${label} TCB manager`)

  const scratch = new Uint8Array(TASK_SCRATCH_SIZE)
  const view = new DataView(scratch.buffer)
  view.setUint32(0x00, (functionAddress | 1) >>> 0, true)
  args.forEach((value, index) => view.setUint32(0x04 + index * 4, value >>> 0, true))
  scratch.set(SIX_ARG_FIELD_TASK_TRAMPOLINE, TASK_CODE_OFFSET - TASK_DATA_OFFSET)

  let scheduled = false
  let completed = false
  let task = 0
  let frames = 0
  const unsubscribe = bridge.subscribeEmulatedFrame(() => { frames += 1 })
  try {
    await bridge.writeBytes(dataAddress, scratch)
    const add = await bridge.callArm9Thumb4(GFL_TCB_MGR_ADD_TASK, tcbManager, (codeAddress | 1) >>> 0, dataAddress, 0, NATIVE_STACK_RESERVE)
    assertCall(add, `GFL_TCBMgrAddTask(${label})`)
    task = add.result >>> 0
    assertPointer(task, `${label} task`)
    scheduled = true

    while (frames < TASK_TIMEOUT_FRAMES) {
      if ((await bridge.read32(dataAddress + TASK_STATUS_OFFSET)) === 1) {
        completed = true
        return { result: await bridge.read32(dataAddress + TASK_RESULT_OFFSET), task, frames }
      }
      await delay(16)
    }
    throw new Error(`${label} did not finish; reload the game before retrying because its task may still be live.`)
  } finally {
    unsubscribe()
    if (!scheduled || completed) await bridge.writeBytes(dataAddress, original)
  }
}

async function writeVec(bridge: MelonDsBridge, address: number, x: number, y: number, z: number) {
  await bridge.write32(address + 0x00, x >>> 0)
  await bridge.write32(address + 0x04, y >>> 0)
  await bridge.write32(address + 0x08, z >>> 0)
}

async function actorSnapshot(bridge: MelonDsBridge, actor: number) {
  const [uid, modelId, moveCode, faceDir, drawStatus, x, y, z, tcb, moveCodeVTable] = await Promise.all([
    bridge.read16(actor + ACTOR_UID), bridge.read16(actor + ACTOR_MODEL_ID), bridge.read16(actor + ACTOR_MOVE_CODE),
    bridge.read16(actor + ACTOR_FACE_DIR), bridge.read16(actor + ACTOR_DRAW_STATUS),
    bridge.read32(actor + ACTOR_WPOS), bridge.read32(actor + ACTOR_WPOS + 4), bridge.read32(actor + ACTOR_WPOS + 8),
    bridge.read32(actor + ACTOR_TCB), bridge.read32(actor + ACTOR_MOVE_CODE_VTABLE),
  ])
  return { actor: hex(actor), uid, modelId, moveCode, faceDir, drawStatus, world: { x: signed32(x), y: signed32(y), z: signed32(z) }, tcb: hex(tcb), moveCodeVTable: hex(moveCodeVTable) }
}

async function resolveBillboard(bridge: MelonDsBridge, actor: number, timeoutFrames = 120) {
  for (let attempt = 0; attempt < timeoutFrames; attempt += 1) {
    const call = await bridge.callArm9Thumb4(FLDACT_GET_BLACT_IDX, actor, 0, 0, 0, NATIVE_STACK_RESERVE)
    assertCall(call, 'FldAct_GetBlActIdx(Probe 8)')
    const index = call.result & 0xffff
    if (index !== BLACT_NONE) {
      const actorSystem = await bridge.read32(actor + ACTOR_SYSTEM_BACKPTR)
      assertPointer(actorSystem, 'Probe 8 actor system')
      const fieldBlAct = await bridge.read32(actorSystem + ACTOR_SYSTEM_FIELD_BLACT)
      const blActSystem = await bridge.read32(fieldBlAct + FIELD_BLACT_SYSTEM)
      const scene = await bridge.read32(blActSystem + BLACT_SYSTEM_SCENE)
      const handles = await bridge.read32(blActSystem + BLACT_SYSTEM_ACTOR_HANDLES)
      const handleCount = await bridge.read16(blActSystem + BLACT_SYSTEM_ACTOR_COUNT)
      const sceneActors = await bridge.read32(scene + BLACT_SCENE_ACTORS)
      const sceneCount = await bridge.read16(scene + BLACT_SCENE_CONFIG_ACTOR_COUNT)
      ;[fieldBlAct, blActSystem, scene, handles, sceneActors].forEach((value, i) => assertPointer(value, `Probe 8 billboard pointer ${i}`))
      if (index < sceneCount) {
        for (let i = 0; i < handleCount; i += 1) {
          const handle = handles + i * HANDLE_SIZE
          if ((await bridge.read32(handle + HANDLE_BLACT_INDEX)) !== index) continue
          return { index, blAct: sceneActors + index * BLACT_SIZE, handle }
        }
      }
    }
    await waitForFrames(bridge, 1)
  }
  throw new Error('Probe 8 native comm actor billboard did not bind in time.')
}

async function renderSnapshot(bridge: MelonDsBridge, binding: { index: number; blAct: number; handle: number }) {
  const [geomFlags, faceIndex, matFlags, matEntry, anim, animate] = await Promise.all([
    bridge.read16(binding.blAct + BLACT_GEOM_FLAGS), bridge.read16(binding.blAct + BLACT_FACE_INDEX),
    bridge.read16(binding.blAct + BLACT_MAT_FLAGS), bridge.read16(binding.handle + HANDLE_MAT_ENTRY),
    bridge.read16(binding.handle + HANDLE_ANIM), bridge.read32(binding.handle + HANDLE_ANIMATE),
  ])
  return { blActIndex: binding.index, blAct: hex(binding.blAct), handle: hex(binding.handle), matEntry, geomFlags, faceIndex, matFlags, visibleBitSet: (matFlags & BLACT_VISIBLE_MASK) !== 0, anim, animate }
}

async function runVisualProbe(bridge: MelonDsBridge, probe: White2ActorSystemProbe, actorSystem: number, referenceRemote: number, modelId: number) {
  const heapId = await bridge.read16(actorSystem + MMSYS_HEAP_ID)
  const createSys = await bridge.callArm9Thumb4(FLD_COMM_ACT_SYS_CREATE, COMM_COUNT, actorSystem, heapId, 1, NATIVE_STACK_RESERVE)
  assertCall(createSys, 'FldCommActSys_Create(Probe 8)')
  const commSystem = createSys.result >>> 0
  assertPointer(commSystem, 'Probe 8 comm system')
  const entries = await bridge.read32(commSystem + 0x08)
  assertPointer(entries, 'Probe 8 entries')

  const actorEntry = entries
  const posAddress = entries + COMM_ENTRY_SIZE
  const auxAddress = entries + COMM_ENTRY_SIZE * 2
  const dirAddress = auxAddress
  const hiddenAddress = auxAddress + 4
  const refX = await bridge.read32(referenceRemote + ACTOR_WPOS)
  const refY = await bridge.read32(referenceRemote + ACTOR_WPOS + 4)
  const refZ = await bridge.read32(referenceRemote + ACTOR_WPOS + 8)
  const startX = (refX + FX32_TILE * 2) >>> 0
  const endX = (startX + FX32_TILE) >>> 0

  let nativeActor = 0
  let deleteTask: unknown = null
  let freeCall: Arm9NativeCallResult | null = null
  let safe = true
  let report: Record<string, unknown> = {}

  try {
    await writeVec(bridge, posAddress, startX, refY, refZ)
    await bridge.write16(dirAddress, 3)
    await bridge.write32(hiddenAddress, 0)

    const createTask = await runScheduledCall6(bridge, probe, FLD_COMM_ACT_SYS_CREATE_ACTOR, [commSystem, PROBE_NET_ID, modelId, dirAddress, posAddress, hiddenAddress], 'FldCommActSys_CreateActor(Probe 8)', true)
    nativeActor = await bridge.read32(actorEntry + 8)
    assertPointer(nativeActor, 'Probe 8 native actor')
    await waitForFrames(bridge, 20)
    const binding = await resolveBillboard(bridge, nativeActor)
    const initialActor = await actorSnapshot(bridge, nativeActor)
    const initialRender = await renderSnapshot(bridge, binding)

    console.info('[PokéRun resdiag] PROBE 8 VISIBLE', { actor: hex(nativeActor), world: initialActor.world, render: initialRender })
    await waitForFrames(bridge, 90)

    let midMoveActor = initialActor
    let midMoveRender = initialRender
    for (let step = 1; step <= 8; step += 1) {
      const x = (startX + Math.floor((FX32_TILE * step) / 8)) >>> 0
      await writeVec(bridge, posAddress, x, refY, refZ)
      await bridge.write16(dirAddress, 3)
      await waitForFrames(bridge, 6)
      if (step === 4) {
        midMoveActor = await actorSnapshot(bridge, nativeActor)
        midMoveRender = await renderSnapshot(bridge, binding)
      }
    }

    await waitForFrames(bridge, 30)
    const afterMoveActor = await actorSnapshot(bridge, nativeActor)
    const afterMoveRender = await renderSnapshot(bridge, binding)

    await bridge.write16(dirAddress, 2)
    await waitForFrames(bridge, 45)
    const afterTurnActor = await actorSnapshot(bridge, nativeActor)
    const afterTurnRender = await renderSnapshot(bridge, binding)

    await waitForFrames(bridge, 90)
    await bridge.write32(hiddenAddress, 1)
    await waitForFrames(bridge, 8)
    const hiddenActor = await actorSnapshot(bridge, nativeActor)
    const hiddenRender = await renderSnapshot(bridge, binding)

    const checks = {
      nativeIdentity: initialActor.uid === NATIVE_COMM_UID && initialActor.moveCode === MOVE_CODE_COMM_ACTOR && initialActor.moveCodeVTable === hex(MOVE_CODE_COMM_ACTOR_TABLE),
      nativeUpdaterAttached: initialActor.tcb !== hex(0),
      heroineMaterialBound: initialRender.matEntry === 13,
      visibleAtStart: initialRender.visibleBitSet,
      nativeMovementReachedTarget: afterMoveActor.world.x === signed32(endX),
      nativeMoveAnimationObserved: midMoveActor.drawStatus !== 0 || midMoveRender.anim !== initialRender.anim || midMoveRender.faceIndex !== initialRender.faceIndex,
      nativeDirectionConsumed: afterTurnActor.faceDir === 2,
      rendererFollowedTurn: afterTurnRender.faceIndex !== afterMoveRender.faceIndex || afterTurnActor.faceDir === 2,
      nativeHiddenConsumed: hiddenRender.visibleBitSet !== initialRender.visibleBitSet,
    }

    report = {
      purpose: 'visually prove White 2 native communication actor rendering, movement animation, facing, and visibility',
      actorSystem: hex(actorSystem), modelId, commSystem: hex(commSystem), actor: hex(nativeActor),
      backing: { dirAddress: hex(dirAddress), posAddress: hex(posAddress), hiddenAddress: hex(hiddenAddress), startX: signed32(startX), endX: signed32(endX), y: signed32(refY), z: signed32(refZ) },
      createTask, initialActor, initialRender, midMoveActor, midMoveRender, afterMoveActor, afterMoveRender, afterTurnActor, afterTurnRender, hiddenActor, hiddenRender, checks,
      conclusion: { nativeCommVisualPathValidated: Object.values(checks).every(Boolean) },
    }
  } catch (reason) {
    if (reason instanceof Error && reason.message.includes('may still be live')) safe = false
    throw reason
  } finally {
    if (safe) {
      try {
        if (nativeActor) {
          deleteTask = await runScheduledCall6(bridge, probe, FLD_COMM_ACT_SYS_DELETE_ACTOR, [commSystem, PROBE_NET_ID, 0, 0, 0, 0], 'FldCommActSys_DeleteActor(Probe 8)')
          await waitForFrames(bridge, 2)
        }
        await bridge.writeBytes(entries + COMM_ENTRY_SIZE, new Uint8Array(COMM_ENTRY_SIZE * 2))
        freeCall = await bridge.callArm9Thumb4(FLD_COMM_ACT_SYS_FREE, commSystem, 0, 0, 0, NATIVE_STACK_RESERVE)
        assertCall(freeCall, 'FldCommActSys_Free(Probe 8)')
      } catch (cleanupReason) {
        safe = false
        console.info('[PokéRun resdiag] PROBE 8 CLEANUP UNSAFE - RELOAD GAME', { reason: cleanupReason instanceof Error ? cleanupReason.message : String(cleanupReason), nativeActor: hex(nativeActor), commSystem: hex(commSystem) })
      }
    }
  }

  return { ...report, cleanup: { deleteTask, freeStatus: freeCall?.status ?? 0, freeReturnedNormally: freeCall?.status === 1, safe } }
}

export function White2NativeCommVisualProbe({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
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
        const remotes = scan.entries.filter(entry => entry.uid === POKERUN_NATIVE_TEST_UID)
        const remote = remotes.length === 1 ? remotes[0] : null
        if (!remote) { readyKey = ''; readySince = 0; return }
        const key = `${scan.actorSystem}:${remote.address}:${remote.modelId}`
        if (key !== readyKey) { readyKey = key; readySince = performance.now(); return }
        if (capturedKey === key || performance.now() - readySince < STABLE_MS) return
        capturedKey = key
        const report = await runVisualProbe(runtimeBridge, probe, scan.actorSystem, remote.address, remote.modelId)
        console.info('[PokéRun resdiag] NATIVE COMM VISUAL CONTROL', report)
      } catch (reason) {
        console.info('[PokéRun resdiag] PROBE 8 RESULT', { ok: false, reason: reason instanceof Error ? reason.message : String(reason), recovery: reason instanceof Error && reason.message.includes('may still be live') ? 'Reload the game before retrying.' : 'Cleanup was attempted; inspect cleanup logs before retrying.' })
      } finally {
        busy = false
      }
    }

    void capture()
    const timer = window.setInterval(() => void capture(), POLL_MS)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
