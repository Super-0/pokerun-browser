import type { Arm9NativeCallResult, MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../core/protocol'
import { White2ActorSystemProbe, type White2ActorHeapEntry } from './White2ActorSystem'

// Exact Pokémon White 2 US (IRDO) overlay 12 symbols, exact-SHA gated below.
const FIND_FIELD_ACTOR = 0x02167a54
const CREATE_ACTOR = 0x021668b4
const DELETE_ACTOR = 0x02166980
const NATIVE_STACK_RESERVE = 0x1000
const ZONE_NPC_SIZE = 0x24
// The create routine copies ZoneNPC into its own local stack frame before its
// first helper call. Keep our temporary input inside the already-backed native
// call stack region, but far below that shallow prologue, instead of writing
// above the interrupted SP into the live caller's stack frames.
const SCRATCH_BELOW_SP = 0x200

// White 2 does not create Union Room peers with the local player's ordinary
// field model. It converts a Union View into one of the dedicated trainer-type
// NPC models first. View 0 maps to trainer type/model 11, so use that known-good
// game-native remote-trainer model for the lifecycle probe. Once creation is
// proven, PokéRun can bind the remote player's actual appearance separately.
const UNION_REMOTE_TRAINER_MODEL = 11

// Temporary dev UID. Production will allocate a PokéRun-owned UID only after the
// native create/delete lifecycle is validated across map transitions.
export const POKERUN_NATIVE_TEST_UID = 0x7f01

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
  putU16(view, 0x06, 0) // event type
  putU16(view, 0x08, 0) // spawn flag
  putU16(view, 0x0a, 0) // script id
  putU16(view, 0x0c, 1) // down
  putU16(view, 0x0e, 0)
  putU16(view, 0x10, 0)
  putU16(view, 0x12, 0)
  putU16(view, 0x14, 0)
  putU16(view, 0x16, 0)
  view.setUint32(0x18, 0, true) // BOOL isRail = FALSE
  putU16(view, 0x1c, x)
  putU16(view, 0x1e, z)
  view.setInt32(0x20, 0, true)

  return { bytes, x, z, modelId: UNION_REMOTE_TRAINER_MODEL }
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
    if (!player) throw new Error('White 2 player actor was not found.')
    return { scan, player }
  }

  private async findActor(actorSystem: number, uid: number) {
    const call = await this.bridge.callArm9Thumb4(FIND_FIELD_ACTOR, actorSystem, uid, 0, 0, NATIVE_STACK_RESERVE)
    assertCallReturned(call, 'FindFieldActor')
    return call.result >>> 0
  }

  private async deleteActorAddress(actorAddress: number) {
    assertMainRamPointer(actorAddress, 'Actor to delete')
    const deleteOpcode = await this.bridge.read16(DELETE_ACTOR)
    if (deleteOpcode === 0 || deleteOpcode === 0xffff) throw new Error('White 2 overlay 12 is not resident at the expected actor-delete address.')
    const call = await this.bridge.callArm9Thumb4(DELETE_ACTOR, actorAddress, 0, 0, 0, NATIVE_STACK_RESERVE)
    assertCallReturned(call, 'DeleteActor')
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
    if (!scan.zeroedSlots.length) throw new Error('Native actor test blocked because the FieldActor heap has no fully zeroed slot.')
    const existing = await this.findActor(scan.actorSystem, POKERUN_NATIVE_TEST_UID)
    if (existing !== 0) throw new Error(`Test UID ${hex(POKERUN_NATIVE_TEST_UID)} is already in use at ${hex(existing)}.`)

    const createOpcode = await this.bridge.read16(CREATE_ACTOR)
    if (createOpcode === 0 || createOpcode === 0xffff) throw new Error('White 2 overlay 12 is not resident at the expected actor-create address.')

    const sp = await this.bridge.getArm9Sp()
    if (sp < NATIVE_STACK_RESERVE) throw new Error('ARM9 stack pointer is too low for the reserved native-call stack region.')
    const scratch = (sp - SCRATCH_BELOW_SP) & ~3
    const stackBase = sp - NATIVE_STACK_RESERVE
    if (scratch < stackBase || scratch + ZONE_NPC_SIZE >= sp) throw new Error('Temporary ZoneNPC scratch does not fit inside the reserved native-call stack region.')
    const originalScratch = await this.bridge.readBytes(scratch, ZONE_NPC_SIZE)
    const npc = buildZoneNpc(player)

    try {
      await this.bridge.writeBytes(scratch, npc.bytes)
      const call = await this.bridge.callArm9Thumb4(CREATE_ACTOR, scan.actorSystem, scratch, player.zoneId, 0, NATIVE_STACK_RESERVE)
      assertCallReturned(call, 'CreateNewActorByEntityNoWKOBJCODE')
      const actorAddress = call.result >>> 0
      assertMainRamPointer(actorAddress, 'Created actor')
      const found = await this.findActor(scan.actorSystem, POKERUN_NATIVE_TEST_UID)
      if (found !== actorAddress) throw new Error(`Created actor verification failed: returned ${hex(actorAddress)}, FindFieldActor saw ${hex(found)}.`)
      return { actorAddress, uid: POKERUN_NATIVE_TEST_UID, modelId: npc.modelId, zoneId: player.zoneId, x: npc.x, z: npc.z }
    } catch (error) {
      const partial = await this.findActor(scan.actorSystem, POKERUN_NATIVE_TEST_UID).catch(() => 0)
      if (partial) await this.deleteActorAddress(partial).catch(() => undefined)
      throw error
    } finally {
      await this.bridge.writeBytes(scratch, originalScratch)
    }
  }

  async deleteTestActor(actorAddress?: number) {
    const { scan } = await this.currentPlayer()
    const address = actorAddress ?? await this.findActor(scan.actorSystem, POKERUN_NATIVE_TEST_UID)
    if (address === 0) return false
    await this.deleteActorAddress(address)
    const remaining = await this.findActor(scan.actorSystem, POKERUN_NATIVE_TEST_UID)
    if (remaining !== 0) throw new Error(`DeleteActor returned, but test UID still resolves to ${hex(remaining)}.`)
    return true
  }
}
