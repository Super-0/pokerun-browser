import { useEffect } from 'react'
import type { Arm9NativeCallResult, MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2ActorSystemProbe } from '../multiplayer/games/White2ActorSystem'
import { POKERUN_NATIVE_TEST_UID } from '../multiplayer/games/White2NativeActor'

// Probe 7: create a temporary actor through White 2's *actual* field-
// communication actor system, prove its native updater consumes a persistent
// direction/position/hidden block, then delete/free everything cleanly.
//
// This intentionally leaves PokéRun's existing generic fake-P2 actor alone.
// The native comm actor is a separate, short-lived, hidden research actor.
const FLD_COMM_ACT_SYS_CREATE = 0x0218ae78
const FLD_COMM_ACT_SYS_FREE = 0x0218aebc
const FLD_COMM_ACT_SYS_CREATE_ACTOR = 0x0218aef4
const FLD_COMM_ACT_SYS_DELETE_ACTOR = 0x0218af48
const GFL_TCB_MGR_ADD_TASK = 0x0203a640
const GFL_TCB_REMOVE = 0x0203a6d4

const MOVE_CODE_COMM_ACTOR = 0x44
const MOVE_CODE_COMM_ACTOR_TABLE = 0x021cc418
const NATIVE_COMM_UID = 0x00fc
const PROBE_NET_ID = 0x70000007

// MMSys offsets validated by the existing native actor bridge and Probe 6.
const MMSYS_HEAP_ID = 0x08
const MMSYS_TCB_MGR = 0x24

// FieldActor offsets from the White 2 decomp.
const ACTOR_FLAGS = 0x00
const ACTOR_MOVEMENT_FLAGS = 0x04
const ACTOR_UID = 0x08
const ACTOR_MODEL_ID = 0x0c
const ACTOR_MOVE_CODE = 0x0e
const ACTOR_FACE_DIR = 0x18
const ACTOR_DRAW_STATUS = 0x2a
const ACTOR_WPOS = 0x44
const ACTOR_TCB = 0x84
const ACTOR_MOVE_CODE_VTABLE = 0x8c
const ACTOR_POSITION_WORK = 0x94

// Flags set by FieldCommActor_Add.
const FLAG_PERSISTENT = 0x00000020
const FLAG_COLLISION_DISABLED = 0x00000080
const FLAG_HEIGHT_CALC_DISABLED = 0x00000200
const FLAG_MAP_ATTR_DISABLED = 0x00000400
const MOVE_FLAG_IGNORE_DISABLE_ALL = 0x00080000
const MOVE_FLAG_ATTR_EFFECT_OFF = 0x00100000

// struct FldCommActSys is 0x0c bytes; entries are 0x0c bytes each.
// Probe 7 asks for three entries. Entry 0 owns the native actor. Entries 1/2
// are deliberately unused by the system and provide persistent backing memory
// for the test VecFx32 / direction / hidden values. They are zeroed again
// before FldCommActSys_Free so the free loop never mistakes them for actors.
const COMM_ENTRY_SIZE = 0x0c
const COMM_COUNT = 3

// Scheduled native calls use the same safe field-TCB mechanism as
// White2NativeActorBridge. FldCommActSys_CreateActor takes six arguments, so
// this trampoline follows ARM AAPCS: r0-r3 plus arg4/arg5 on an 8-byte-aligned
// stack, then removes its own TCB and publishes status=1.
const FIELD_ACTOR_SIZE = 0x100
const TASK_DATA_OFFSET = 0x94
const TASK_CODE_OFFSET = 0xd0
const TASK_SCRATCH_SIZE = FIELD_ACTOR_SIZE - TASK_DATA_OFFSET
const TASK_RESULT_OFFSET = 0x1c
const TASK_STATUS_OFFSET = 0x20
const TASK_TIMEOUT_FRAMES = 900
const NATIVE_STACK_RESERVE = 0x400

const SIX_ARG_FIELD_TASK_TRAMPOLINE = Uint8Array.from([
  0xf0, 0xb5, 0x04, 0x1c, 0x0d, 0x1c, 0x2e, 0x68,
  0x68, 0x68, 0xa9, 0x68, 0xea, 0x68, 0x2b, 0x69,
  0x83, 0xb0, 0x6f, 0x69, 0x00, 0x97, 0xaf, 0x69,
  0x01, 0x97, 0xb0, 0x47, 0x03, 0xb0, 0xe8, 0x61,
  0x20, 0x1c, 0x02, 0x4e, 0xb0, 0x47, 0x01, 0x27,
  0x2f, 0x62, 0xf0, 0xbd, 0xd5, 0xa6, 0x03, 0x02,
])

if (TASK_CODE_OFFSET + SIX_ARG_FIELD_TASK_TRAMPOLINE.length > FIELD_ACTOR_SIZE) {
  throw new Error('Probe 7 six-argument field-task trampoline does not fit in the reserved FieldActor scratch slot.')
}

const POLL_MS = 150
const STABLE_MS = 700
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000
const FX32_TILE = 0x10000

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

function assertMainRamPointer(value: number, label: string) {
  if (!isMainRamPointer(value)) throw new Error(`${label} is not a valid White 2 main-RAM pointer: ${hex(value)}.`)
}

function assertCallReturned(call: Arm9NativeCallResult, label: string) {
  if (call.status === 1) return
  throw new Error(`${label} did not return normally (status ${call.status}, PC ${hex(call.pc)}).`)
}

function hasBit(value: number, bit: number) {
  return ((value >>> 0) & (bit >>> 0)) !== 0
}

async function waitForFrames(bridge: MelonDsBridge, count: number) {
  if (count <= 0) return
  await new Promise<void>((resolve, reject) => {
    let frames = 0
    const timeout = window.setTimeout(() => {
      unsubscribe()
      reject(new Error(`Probe 7 timed out waiting for ${count} emulated frames.`))
    }, 5000)
    const unsubscribe = bridge.subscribeEmulatedFrame(() => {
      frames += 1
      if (frames < count) return
      window.clearTimeout(timeout)
      unsubscribe()
      resolve()
    })
  })
}

async function runScheduledFieldCall6(
  bridge: MelonDsBridge,
  probe: White2ActorSystemProbe,
  functionAddress: number,
  args: readonly [number, number, number, number, number, number],
  label: string,
  mayCreateActor = false,
) {
  const scan = await probe.scanHeap()
  const zeroed = scan.entries.filter(entry => entry.state === 'zeroed').sort((a, b) => a.index - b.index)
  const requiredFreeSlots = mayCreateActor ? 2 : 1
  if (zeroed.length < requiredFreeSlots) {
    throw new Error(`${label} needs at least ${requiredFreeSlots} free FieldActor slot(s); found ${zeroed.length}.`)
  }

  // Actor creation takes the first free slot. Reserve the highest free slot for
  // callback scratch so the new actor cannot overwrite the trampoline/data.
  const scratchSlot = zeroed[zeroed.length - 1]
  const dataAddress = scratchSlot.address + TASK_DATA_OFFSET
  const codeAddress = scratchSlot.address + TASK_CODE_OFFSET
  const originalScratch = await bridge.readBytes(dataAddress, TASK_SCRATCH_SIZE)

  const tcbManager = await bridge.read32(scan.actorSystem + MMSYS_TCB_MGR)
  assertMainRamPointer(tcbManager, `${label} TCB manager`)

  const scratch = new Uint8Array(TASK_SCRATCH_SIZE)
  const view = new DataView(scratch.buffer)
  view.setUint32(0x00, (functionAddress | 1) >>> 0, true)
  for (let index = 0; index < 6; index += 1) {
    view.setUint32(0x04 + index * 4, args[index] >>> 0, true)
  }
  view.setUint32(TASK_RESULT_OFFSET, 0, true)
  view.setUint32(TASK_STATUS_OFFSET, 0, true)
  scratch.set(SIX_ARG_FIELD_TASK_TRAMPOLINE, TASK_CODE_OFFSET - TASK_DATA_OFFSET)

  let scheduled = false
  let completed = false
  let scheduledTask = 0
  let emulatedFrames = 0
  const unsubscribeFrame = bridge.subscribeEmulatedFrame(() => { emulatedFrames += 1 })

  try {
    await bridge.writeBytes(dataAddress, scratch)
    const addTask = await bridge.callArm9Thumb4(
      GFL_TCB_MGR_ADD_TASK,
      tcbManager,
      (codeAddress | 1) >>> 0,
      dataAddress,
      0,
      NATIVE_STACK_RESERVE,
    )
    assertCallReturned(addTask, `GFL_TCBMgrAddTask(${label})`)
    if (addTask.result === 0) throw new Error(`${label} could not allocate a White 2 field task.`)
    scheduledTask = addTask.result >>> 0
    assertMainRamPointer(scheduledTask, `${label} scheduled task`)
    scheduled = true

    while (emulatedFrames < TASK_TIMEOUT_FRAMES) {
      const status = await bridge.read32(dataAddress + TASK_STATUS_OFFSET)
      if (status === 1) {
        const result = await bridge.read32(dataAddress + TASK_RESULT_OFFSET)
        completed = true
        return {
          result: result >>> 0,
          task: scheduledTask,
          frames: emulatedFrames,
        }
      }
      await delay(16)
    }

    const status = await bridge.read32(dataAddress + TASK_STATUS_OFFSET)
    if (status === 1) {
      const result = await bridge.read32(dataAddress + TASK_RESULT_OFFSET)
      completed = true
      return { result: result >>> 0, task: scheduledTask, frames: emulatedFrames }
    }

    throw new Error(`${label} did not finish after ${emulatedFrames} emulated frames. Reload the game before retrying; its field task may still be live.`)
  } finally {
    unsubscribeFrame()
    // If the callback completed it already removed its own TCB. If scheduling
    // never happened, nothing can reference this scratch. A timeout is the one
    // unsafe case: leave the scratch intact until the user reloads the game.
    if (!scheduled || completed) await bridge.writeBytes(dataAddress, originalScratch)
  }
}

async function readActorSnapshot(bridge: MelonDsBridge, actor: number) {
  const [
    flags,
    movementFlags,
    uid,
    modelId,
    moveCode,
    faceDir,
    drawStatus,
    worldX,
    worldY,
    worldZ,
    tcb,
    moveCodeVTable,
    workBytes,
  ] = await Promise.all([
    bridge.read32(actor + ACTOR_FLAGS),
    bridge.read32(actor + ACTOR_MOVEMENT_FLAGS),
    bridge.read16(actor + ACTOR_UID),
    bridge.read16(actor + ACTOR_MODEL_ID),
    bridge.read16(actor + ACTOR_MOVE_CODE),
    bridge.read16(actor + ACTOR_FACE_DIR),
    bridge.read16(actor + ACTOR_DRAW_STATUS),
    bridge.read32(actor + ACTOR_WPOS + 0x00),
    bridge.read32(actor + ACTOR_WPOS + 0x04),
    bridge.read32(actor + ACTOR_WPOS + 0x08),
    bridge.read32(actor + ACTOR_TCB),
    bridge.read32(actor + ACTOR_MOVE_CODE_VTABLE),
    bridge.readBytes(actor + ACTOR_POSITION_WORK, 0x10),
  ])
  const workView = new DataView(workBytes.buffer, workBytes.byteOffset, workBytes.byteLength)

  return {
    actor: hex(actor),
    uid,
    modelId,
    moveCode,
    faceDir,
    drawStatus,
    flags,
    flagsHex: hex(flags),
    movementFlags,
    movementFlagsHex: hex(movementFlags),
    world: {
      x: signed32(worldX),
      y: signed32(worldY),
      z: signed32(worldZ),
    },
    tcb,
    tcbHex: hex(tcb),
    moveCodeVTable,
    moveCodeVTableHex: hex(moveCodeVTable),
    positionWork: [0, 4, 8, 12].map(offset => workView.getUint32(offset, true)),
  }
}

async function writeVecFx32(bridge: MelonDsBridge, address: number, x: number, y: number, z: number) {
  await Promise.all([
    bridge.write32(address + 0x00, x >>> 0),
    bridge.write32(address + 0x04, y >>> 0),
    bridge.write32(address + 0x08, z >>> 0),
  ])
}

async function probeNativeCommActorControl(
  bridge: MelonDsBridge,
  probe: White2ActorSystemProbe,
  actorSystem: number,
  referenceRemoteActor: number,
  modelId: number,
) {
  const heapId = await bridge.read16(actorSystem + MMSYS_HEAP_ID)
  const createSystemCall = await bridge.callArm9Thumb4(
    FLD_COMM_ACT_SYS_CREATE,
    COMM_COUNT,
    actorSystem,
    heapId,
    1, // allowRun
    NATIVE_STACK_RESERVE,
  )
  assertCallReturned(createSystemCall, 'FldCommActSys_Create(Probe 7)')

  const commSystem = createSystemCall.result >>> 0
  assertMainRamPointer(commSystem, 'Probe 7 FldCommActSys')
  const entries = await bridge.read32(commSystem + 0x08)
  assertMainRamPointer(entries, 'Probe 7 FldCommActSys entries')

  const actorEntry = entries
  const posAddress = entries + COMM_ENTRY_SIZE
  const auxAddress = entries + COMM_ENTRY_SIZE * 2
  const dirAddress = auxAddress + 0x00
  const hiddenAddress = auxAddress + 0x04

  const referenceWorld = {
    x: await bridge.read32(referenceRemoteActor + ACTOR_WPOS + 0x00),
    y: await bridge.read32(referenceRemoteActor + ACTOR_WPOS + 0x04),
    z: await bridge.read32(referenceRemoteActor + ACTOR_WPOS + 0x08),
  }

  // Keep the research actor hidden and a couple of tiles east of the current
  // fake-P2 actor. We verify movement from RAM, so it never needs to flash on
  // screen or interfere with the player's map.
  const initialState = {
    dir: 3, // east
    x: (referenceWorld.x + FX32_TILE * 2) >>> 0,
    y: referenceWorld.y >>> 0,
    z: referenceWorld.z >>> 0,
    hidden: 1,
  }
  const movedState = {
    ...initialState,
    x: (initialState.x + FX32_TILE) >>> 0,
  }

  let nativeActor = 0
  let createTask: Awaited<ReturnType<typeof runScheduledFieldCall6>> | null = null
  let deleteTask: Awaited<ReturnType<typeof runScheduledFieldCall6>> | null = null
  let freeCall: Arm9NativeCallResult | null = null
  let safeToFreeSystem = true
  let report: Record<string, unknown> | null = null

  try {
    await writeVecFx32(bridge, posAddress, initialState.x, initialState.y, initialState.z)
    await bridge.write16(dirAddress, initialState.dir)
    await bridge.write32(hiddenAddress, initialState.hidden)

    createTask = await runScheduledFieldCall6(
      bridge,
      probe,
      FLD_COMM_ACT_SYS_CREATE_ACTOR,
      [commSystem, PROBE_NET_ID, modelId, dirAddress, posAddress, hiddenAddress],
      'FldCommActSys_CreateActor',
      true,
    )

    nativeActor = await bridge.read32(actorEntry + 0x08)
    assertMainRamPointer(nativeActor, 'Probe 7 native communication actor')
    await waitForFrames(bridge, 4)

    const initial = await readActorSnapshot(bridge, nativeActor)

    // The only movement write is to our persistent VecFx32 backing block.
    // White 2's own FieldCommActor_Move must consume it and move the actor.
    await writeVecFx32(bridge, posAddress, movedState.x, movedState.y, movedState.z)
    await bridge.write16(dirAddress, 3)
    await waitForFrames(bridge, 3)
    const afterMove = await readActorSnapshot(bridge, nativeActor)

    // Direction test: again write only the backing state, not the actor.
    await bridge.write16(dirAddress, 2) // west
    await waitForFrames(bridge, 3)
    const afterDirection = await readActorSnapshot(bridge, nativeActor)

    const expectedWork = [dirAddress, posAddress, hiddenAddress, actorEntry]
    const checks = {
      uidIsNativeComm: initial.uid === NATIVE_COMM_UID,
      modelMatchesRemote: initial.modelId === modelId,
      moveCodeIsNativeComm: initial.moveCode === MOVE_CODE_COMM_ACTOR,
      moveCodeVTableIsNativeComm: initial.moveCodeVTable === MOVE_CODE_COMM_ACTOR_TABLE,
      nativeUpdaterAttached: initial.tcb !== 0 && isMainRamPointer(initial.tcb),
      persistentFlag: hasBit(initial.flags, FLAG_PERSISTENT),
      collisionDisabled: hasBit(initial.flags, FLAG_COLLISION_DISABLED),
      heightCalcDisabled: hasBit(initial.flags, FLAG_HEIGHT_CALC_DISABLED),
      mapAttrDisabled: hasBit(initial.flags, FLAG_MAP_ATTR_DISABLED),
      ignoreDisableAll: hasBit(initial.movementFlags, MOVE_FLAG_IGNORE_DISABLE_ALL),
      terrainEffectsDisabled: hasBit(initial.movementFlags, MOVE_FLAG_ATTR_EFFECT_OFF),
      workPointersMatch: initial.positionWork.every((value, index) => value === expectedWork[index]),
      initialPositionConsumed: initial.world.x === signed32(initialState.x)
        && initial.world.y === signed32(initialState.y)
        && initial.world.z === signed32(initialState.z),
      nativeUpdaterMovedActor: afterMove.world.x === signed32(movedState.x)
        && afterMove.world.y === signed32(movedState.y)
        && afterMove.world.z === signed32(movedState.z),
      nativeUpdaterConsumedDirection: afterDirection.faceDir === 2,
    }

    report = {
      purpose: 'prove White 2 can own a PokéRun-style remote trainer through its native field communication actor path',
      source: 'pokebw2 src/ov036/field_comm_actor.c',
      actorSystem: hex(actorSystem),
      modelId,
      commSystem: {
        address: hex(commSystem),
        entries: hex(entries),
        count: COMM_COUNT,
        actorEntry: hex(actorEntry),
      },
      backingState: {
        dirAddress: hex(dirAddress),
        posAddress: hex(posAddress),
        hiddenAddress: hex(hiddenAddress),
        entryAddress: hex(actorEntry),
        initial: {
          dir: initialState.dir,
          x: signed32(initialState.x),
          y: signed32(initialState.y),
          z: signed32(initialState.z),
          hidden: initialState.hidden,
        },
        moved: {
          dir: 3,
          x: signed32(movedState.x),
          y: signed32(movedState.y),
          z: signed32(movedState.z),
          hidden: movedState.hidden,
        },
      },
      createTask,
      initialActor: initial,
      afterBackingPositionWrite: afterMove,
      afterBackingDirectionWrite: afterDirection,
      checks,
      conclusion: {
        nativeCommActorControlValidated: Object.values(checks).every(Boolean),
        importantMeaning: 'PokéRun changed only the persistent remote-state block; White 2 kept the actor updater attached and performed movement/facing itself.',
      },
    }
  } catch (reason) {
    // A scheduled task timeout is explicitly unsafe: its callback may still
    // execute later. Do not free backing memory out from under a potentially
    // live task/actor. Reloading the emulator is the safe recovery.
    if (reason instanceof Error && reason.message.includes('may still be live')) {
      safeToFreeSystem = false
    }
    throw reason
  } finally {
    if (safeToFreeSystem) {
      try {
        if (nativeActor !== 0) {
          deleteTask = await runScheduledFieldCall6(
            bridge,
            probe,
            FLD_COMM_ACT_SYS_DELETE_ACTOR,
            [commSystem, PROBE_NET_ID, 0, 0, 0, 0],
            'FldCommActSys_DeleteActor',
          )
          await waitForFrames(bridge, 2)
        }

        // Remove our state bytes from the spare entries before Free iterates
        // them, otherwise pos.z in entry 1 would look like a non-null actor.
        await bridge.writeBytes(entries + COMM_ENTRY_SIZE, new Uint8Array(COMM_ENTRY_SIZE * 2))

        freeCall = await bridge.callArm9Thumb4(
          FLD_COMM_ACT_SYS_FREE,
          commSystem,
          0,
          0,
          0,
          NATIVE_STACK_RESERVE,
        )
        assertCallReturned(freeCall, 'FldCommActSys_Free(Probe 7)')
      } catch (cleanupReason) {
        safeToFreeSystem = false
        console.info('[PokéRun resdiag] PROBE 7 CLEANUP UNSAFE - RELOAD GAME', {
          reason: cleanupReason instanceof Error ? cleanupReason.message : String(cleanupReason),
          commSystem: hex(commSystem),
          nativeActor: hex(nativeActor),
        })
      }
    }
  }

  return {
    ...report,
    cleanup: {
      deleteTask,
      freeStatus: freeCall?.status ?? 0,
      freeReturnedNormally: freeCall?.status === 1,
      safeToFreeSystem,
    },
  }
}

/**
 * Probe 7 is a controlled write-side experiment. It creates one short-lived,
 * hidden native communication actor and removes it again. The existing PokéRun
 * fake-P2 actor/network harness is not modified.
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
        const remotes = scan.entries.filter(entry => entry.uid === POKERUN_NATIVE_TEST_UID)
        const remote = remotes.length === 1 ? remotes[0] : null
        if (!remote) {
          readyKey = ''
          readySince = 0
          return
        }

        const key = `${scan.actorSystem}:${remote.address}:${remote.modelId}`
        if (key !== readyKey) {
          readyKey = key
          readySince = performance.now()
          return
        }
        if (capturedKey === key || performance.now() - readySince < STABLE_MS) return

        // Never run this native lifecycle experiment twice for one stable P2.
        capturedKey = key
        const report = await probeNativeCommActorControl(
          runtimeBridge,
          probe,
          scan.actorSystem,
          remote.address,
          remote.modelId,
        )
        console.info('[PokéRun resdiag] NATIVE COMM ACTOR CONTROL', report)
      } catch (reason) {
        console.info('[PokéRun resdiag] PROBE 7 RESULT', {
          ok: false,
          reason: reason instanceof Error ? reason.message : String(reason),
          recovery: reason instanceof Error && reason.message.includes('may still be live')
            ? 'Reload the game before retrying.'
            : 'Probe cleanup was attempted; inspect cleanup logs before retrying.',
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
