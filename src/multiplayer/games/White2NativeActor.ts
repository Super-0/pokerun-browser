import type { Arm9NativeCallResult, MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../core/protocol'
import {
  White2ActorSystemProbe,
  White2ActorSystemUnavailableError,
  type White2ActorHeapEntry,
  type White2ActorHeapScan,
} from './White2ActorSystem'

// Exact Pokémon White 2 US (IRDO) symbols, exact-SHA gated below.
const FIND_FIELD_ACTOR = 0x02167a54
const CREATE_ACTOR = 0x021668b4
const DELETE_ACTOR = 0x02166980
const GFL_TCB_MGR_ADD_TASK = 0x0203a640
const NATIVE_STACK_RESERVE = 0x1000
const MMSYS_TCB_MGR = 0x24
const ZONE_NPC_SIZE = 0x24

// A long White 2 actor create can yield through Nitro's scheduler while loading
// resources. The bounded direct ARM9 call gate intentionally cannot follow that
// cooperative thread switch. For create/delete we therefore enqueue a tiny
// one-shot callback onto the field actor system's own TCB manager. White 2 then
// invokes the target during its normal field update, with its ordinary thread,
// IRQ, file-loader, and scheduler machinery all running normally.
//
// The callback is 36 bytes of ARMv5TE Thumb code assembled from:
//   result = fn(r0, r1, r2, r3); GFL_TCBRemove(tcb); status = 1;
// It lives only in the high, non-runtime portion of the highest free FieldActor
// slot and is restored byte-for-byte after the task removes itself. Actor flags,
// runtime pointers, and every field used to decide whether that slot is active
// remain untouched at zero.
const FIELD_ACTOR_SIZE = 0x100
const TASK_DATA_OFFSET = 0x94
const TASK_PAYLOAD_OFFSET = 0x1c
const TASK_CODE_OFFSET = 0xdc
const TASK_STATUS_OFFSET = 0x18
const TASK_RESULT_OFFSET = 0x14
const TASK_SCRATCH_SIZE = FIELD_ACTOR_SIZE - TASK_DATA_OFFSET
// The scheduled callback only advances when this tab runs game frames. A hidden
// multiplayer tab may spend eight wall-clock seconds running very few frames.
const TASK_TIMEOUT_FRAMES = 900

const FIELD_TASK_TRAMPOLINE = Uint8Array.from([
  0xf0, 0xb5, 0x04, 0x00, 0x0d, 0x00, 0x2e, 0x68,
  0x68, 0x68, 0xa9, 0x68, 0xea, 0x68, 0x2b, 0x69,
  0xb0, 0x47, 0x68, 0x61, 0x20, 0x00, 0x02, 0x4e,
  0xb0, 0x47, 0x01, 0x27, 0xaf, 0x61, 0xf0, 0xbd,
  0xd5, 0xa6, 0x03, 0x02,
])

if (TASK_CODE_OFFSET + FIELD_TASK_TRAMPOLINE.length > FIELD_ACTOR_SIZE) {
  throw new Error('White 2 field-task trampoline no longer fits in the reserved scratch area.')
}

// White 2 converts a Union Room player view into one of its dedicated remote
// trainer NPC models. View 0 maps to model 11, so use that game-native remote
// trainer model for the lifecycle probe. Once creation is proven, PokéRun can
// bind the remote player's actual appearance separately.
const UNION_REMOTE_TRAINER_MODEL = 11

// Temporary dev UID. Production will allocate a PokéRun-owned UID only after the
// native create/delete lifecycle is validated across map transitions.
export const POKERUN_NATIVE_TEST_UID = 0x7f01

/** A native task may still execute, or actor ownership is ambiguous. Reload before retrying. */
export class White2NativeActorUnsafeStateError extends Error {}

export type White2NativeCallValidation = {
  actorSystem: number
  playerAddress: number
  foundAddress: number
  stackPointer: number
}

export type White2NativeSpawn = {
  actorAddress: number
  uid: number
  modelId: number
  zoneId: number
  x: number
  z: number
}

function hex(value: number) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

function armMode(cpsr: number) {
  const mode = cpsr & 0x1f
  if (mode === 0x10) return 'USR'
  if (mode === 0x11) return 'FIQ'
  if (mode === 0x12) return 'IRQ'
  if (mode === 0x13) return 'SVC'
  if (mode === 0x17) return 'ABT'
  if (mode === 0x1b) return 'UND'
  if (mode === 0x1f) return 'SYS'
  return `MODE-${mode.toString(16).toUpperCase()}`
}

function assertMainRamPointer(value: number, label: string) {
  if (value < 0x02000000 || value >= 0x02400000 || (value & 0x3) !== 0) {
    throw new Error(`${label} is not a valid White 2 main-RAM pointer: ${hex(value)}.`)
  }
}

function assertCallReturned(call: Arm9NativeCallResult, label: string) {
  if (call.status === 1) return
  const reason = call.status === 2 ? 'invalid call arguments' : call.status === 3 ? 'instruction limit reached' : call.status === 4 ? 'callee halted ARM9' : `unknown status ${call.status}`
  const diagnostics = call.pc || call.lr || call.cpsr || call.instructions
    ? ` PC ${hex(call.pc)} • LR ${hex(call.lr)} • CPSR ${hex(call.cpsr)} (${armMode(call.cpsr)}) • STEPS ${call.instructions}`
    : ''
  throw new Error(`${label} did not return normally: ${reason}.${diagnostics}`)
}

function putU16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value & 0xffff, true)
}

function buildZoneNpc(player: White2ActorHeapEntry) {
  const bytes = new Uint8Array(ZONE_NPC_SIZE)
  const view = new DataView(bytes.buffer)
  const x = Math.max(-32768, Math.min(32767, player.x + 1))
  const z = Math.max(-32768, Math.min(32767, player.y))

  putU16(view, 0x00, POKERUN_NATIVE_TEST_UID)
  putU16(view, 0x02, UNION_REMOTE_TRAINER_MODEL)
  putU16(view, 0x04, 2) // Same base move code used by White 2's Union Room parent actor.
  putU16(view, 0x06, 0)
  putU16(view, 0x08, 0)
  putU16(view, 0x0a, 0)
  putU16(view, 0x0c, 1) // down
  putU16(view, 0x0e, 0)
  putU16(view, 0x10, 0)
  putU16(view, 0x12, 0)
  putU16(view, 0x14, 0)
  putU16(view, 0x16, 0)
  view.setUint32(0x18, 0, true)
  putU16(view, 0x1c, x)
  putU16(view, 0x1e, z)
  view.setInt32(0x20, 0, true)

  return { bytes, x, z, modelId: UNION_REMOTE_TRAINER_MODEL }
}

function delay(ms: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms))
}

export class White2NativeActorBridge {
  constructor(private readonly bridge: MelonDsBridge, private readonly rom: MultiplayerRomIdentity) {}

  private assertSupported() {
    if (!White2ActorSystemProbe.supportsRom(this.rom)) throw new Error('Native actor calls are only enabled for the exact tested White 2 ROM fingerprint.')
  }

  private async currentPlayer() {
    this.assertSupported()
    const scan = await new White2ActorSystemProbe(this.bridge).scanHeap()
    if (scan.suspiciousSlots.length) throw new Error(`Native actor test blocked by suspicious actor slots: ${scan.suspiciousSlots.join(', ')}.`)
    const player = scan.entries.find(entry => entry.state === 'player')
    if (!player) throw new White2ActorSystemUnavailableError('White 2 player actor was not found while the field is loading.')
    return { scan, player }
  }

  private async findActor(actorSystem: number, uid: number) {
    const call = await this.bridge.callArm9Thumb4(FIND_FIELD_ACTOR, actorSystem, uid, 0, 0, NATIVE_STACK_RESERVE)
    assertCallReturned(call, 'FindFieldActor')
    return call.result >>> 0
  }

  private async runFieldTask(
    scan: White2ActorHeapScan,
    functionAddress: number,
    args: (payloadAddress: number) => readonly [number, number, number, number],
    payload?: Uint8Array,
  ) {
    const zeroed = scan.entries.filter(entry => entry.state === 'zeroed').sort((a, b) => a.index - b.index)
    if (zeroed.length < 2) throw new Error('Native field task needs at least two free FieldActor slots so its scratch slot cannot be selected by actor creation.')

    // GetPtrToFirstFreeActorSlot starts at index 0. Reserve the highest free slot
    // for temporary callback/data so creation consumes an earlier free slot.
    const scratchSlot = zeroed[zeroed.length - 1]
    const dataAddress = scratchSlot.address + TASK_DATA_OFFSET
    const payloadAddress = dataAddress + TASK_PAYLOAD_OFFSET
    const codeAddress = scratchSlot.address + TASK_CODE_OFFSET
    const originalScratch = await this.bridge.readBytes(dataAddress, TASK_SCRATCH_SIZE)

    const tcbManager = await this.bridge.read32(scan.actorSystem + MMSYS_TCB_MGR)
    assertMainRamPointer(tcbManager, 'Field actor TCB manager')

    const scratch = new Uint8Array(TASK_SCRATCH_SIZE)
    const view = new DataView(scratch.buffer)
    const [r0, r1, r2, r3] = args(payloadAddress)
    view.setUint32(0x00, (functionAddress | 1) >>> 0, true)
    view.setUint32(0x04, r0 >>> 0, true)
    view.setUint32(0x08, r1 >>> 0, true)
    view.setUint32(0x0c, r2 >>> 0, true)
    view.setUint32(0x10, r3 >>> 0, true)
    view.setUint32(TASK_RESULT_OFFSET, 0, true)
    view.setUint32(TASK_STATUS_OFFSET, 0, true)
    if (payload) {
      if (TASK_PAYLOAD_OFFSET + payload.length > TASK_CODE_OFFSET - TASK_DATA_OFFSET) throw new Error('Native field-task payload is too large for the reserved scratch area.')
      scratch.set(payload, TASK_PAYLOAD_OFFSET)
    }
    scratch.set(FIELD_TASK_TRAMPOLINE, TASK_CODE_OFFSET - TASK_DATA_OFFSET)

    let scheduled = false
    let completed = false
    let scheduledTask = 0
    let emulatedFrames = 0
    const unsubscribeEmulatedFrame = this.bridge.subscribeEmulatedFrame(() => { emulatedFrames += 1 })
    try {
      await this.bridge.writeBytes(dataAddress, scratch)
      const addTask = await this.bridge.callArm9Thumb4(
        GFL_TCB_MGR_ADD_TASK,
        tcbManager,
        (codeAddress | 1) >>> 0,
        dataAddress,
        0,
        NATIVE_STACK_RESERVE,
      )
      assertCallReturned(addTask, 'GFL_TCBMgrAddTask')
      if (addTask.result === 0) throw new Error('White 2 field actor TCB manager has no free task entry.')
      assertMainRamPointer(addTask.result, 'Scheduled field task')
      scheduledTask = addTask.result
      scheduled = true

      while (emulatedFrames < TASK_TIMEOUT_FRAMES) {
        const status = await this.bridge.read32(dataAddress + TASK_STATUS_OFFSET)
        if (status === 1) {
          const result = await this.bridge.read32(dataAddress + TASK_RESULT_OFFSET)
          completed = true
          return result >>> 0
        }
        await delay(16)
      }

      const status = await this.bridge.read32(dataAddress + TASK_STATUS_OFFSET)
      if (status === 1) {
        const result = await this.bridge.read32(dataAddress + TASK_RESULT_OFFSET)
        completed = true
        return result >>> 0
      }
      const [callback, taskData, scratchUid] = await Promise.all([
        this.bridge.read32(scheduledTask + 0x14),
        this.bridge.read32(scheduledTask + 0x10),
        this.bridge.read16(scratchSlot.address + 0x08),
      ])
      throw new White2NativeActorUnsafeStateError(`Scheduled White 2 field task did not finish after ${emulatedFrames} game frames (status ${status}, task ${hex(scheduledTask)}, callback ${hex(callback)}, data ${hex(taskData)}, scratch UID ${hex(scratchUid)}, tab ${document.visibilityState}). Reload the tab before retrying.`)
    } finally {
      unsubscribeEmulatedFrame()
      // Once the callback reports status=1 it has already removed its own TCB,
      // so nothing in the game can execute or reference this scratch again.
      if (!scheduled || completed) await this.bridge.writeBytes(dataAddress, originalScratch)
    }
  }

  private async deleteActorAddress(actorAddress: number, scan?: White2ActorHeapScan) {
    assertMainRamPointer(actorAddress, 'Actor to delete')
    const deleteOpcode = await this.bridge.read16(DELETE_ACTOR)
    if (deleteOpcode === 0 || deleteOpcode === 0xffff) throw new Error('White 2 overlay 12 is not resident at the expected actor-delete address.')
    const actorScan = scan ?? await new White2ActorSystemProbe(this.bridge).scanHeap()
    await this.runFieldTask(actorScan, DELETE_ACTOR, () => [actorAddress, 0, 0, 0])
  }

  async validateCallGate(): Promise<White2NativeCallValidation> {
    const { scan, player } = await this.currentPlayer()
    const [stackPointer, firstOpcode] = await Promise.all([
      this.bridge.getArm9Sp(),
      this.bridge.read16(FIND_FIELD_ACTOR),
    ])
    if (firstOpcode === 0 || firstOpcode === 0xffff) throw new Error('White 2 overlay 12 is not resident at the expected FindFieldActor address.')
    const foundAddress = await this.findActor(scan.actorSystem, 0x00ff)
    assertMainRamPointer(foundAddress, 'FindFieldActor result')
    if (foundAddress !== player.address) {
      throw new Error(`Native call gate returned player ${hex(foundAddress)}, expected ${hex(player.address)}.`)
    }
    return { actorSystem: scan.actorSystem, playerAddress: player.address, foundAddress, stackPointer }
  }

  async spawnTestActor(): Promise<White2NativeSpawn> {
    const { scan, player } = await this.currentPlayer()
    const existing = await this.findActor(scan.actorSystem, POKERUN_NATIVE_TEST_UID)
    if (existing !== 0) throw new White2NativeActorUnsafeStateError(`Test UID ${hex(POKERUN_NATIVE_TEST_UID)} is already in use at ${hex(existing)}. Reload the tab before retrying the native lifecycle probe.`)

    const createOpcode = await this.bridge.read16(CREATE_ACTOR)
    if (createOpcode === 0 || createOpcode === 0xffff) throw new Error('White 2 overlay 12 is not resident at the expected actor-create address.')

    const npc = buildZoneNpc(player)
    const actorAddress = await this.runFieldTask(
      scan,
      CREATE_ACTOR,
      payloadAddress => [scan.actorSystem, payloadAddress, player.zoneId, 0],
      npc.bytes,
    )
    assertMainRamPointer(actorAddress, 'Created actor')

    const found = await this.findActor(scan.actorSystem, POKERUN_NATIVE_TEST_UID)
    if (found !== actorAddress) {
      // Two addresses mean a prior timed-out create may have finished late.
      // Deleting only the first lookup result leaves the returned actor behind.
      throw new White2NativeActorUnsafeStateError(`Created actor verification failed: returned ${hex(actorAddress)}, FindFieldActor saw ${hex(found)}. Reload the tab before retrying.`)
    }

    return { actorAddress, uid: POKERUN_NATIVE_TEST_UID, modelId: npc.modelId, zoneId: player.zoneId, x: npc.x, z: npc.z }
  }

  async deleteTestActor(actorAddress?: number) {
    const { scan } = await this.currentPlayer()
    const address = actorAddress ?? await this.findActor(scan.actorSystem, POKERUN_NATIVE_TEST_UID)
    if (address === 0) return false
    await this.deleteActorAddress(address, scan)
    const remaining = await this.findActor(scan.actorSystem, POKERUN_NATIVE_TEST_UID)
    if (remaining !== 0) throw new Error(`DeleteActor returned, but test UID still resolves to ${hex(remaining)}.`)
    return true
  }
}
