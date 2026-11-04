import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../core/protocol'
import { TESTED_WHITE2_SHA256 } from './White2LiveStateAdapter'

// PRK62 — read-only, opt-in structural research for the exact tested W2 ROM.
// Sources: fuddlesworth/pokebw2 include/system/game_system.h,
// src/system/game_data.c, include/field/player_state.h,
// include/save/player_info.h, include/field/zone.h,
// include/pml/poke_party.h and src/system/poke_tool.c. Offset 0x194 was
// derived from those C layouts and the header matched in the first live test.
// PRK62.1 decrypts COPIES of guest bytes locally, not bytes in guest memory.
// No guest calls, guest-side decryption, Pokémon exchange, save writes or transport.
const G_GAME_SYSTEM = 0x02141134
const GAME_SYSTEM_GAME_DATA_OFFSET = 0x1c
const GAME_DATA_PARTY_OFFSET_CANDIDATE = 0x194
const PARTY_SIZE = 6
const PARTY_HEADER_BYTES = 8
const PARTY_PKM_BYTES = 220
const BOX_PKM_BYTES = 0x88
const BOX_CONTENT_OFFSET = 0x08
const BOX_CONTENT_BYTES = 128
 // Block A offset table from src/system/poke_tool.c blockShufLUT[32][0].
// The encrypted box data contains four 32-byte PID-permuted blocks.
const BLOCK_A_OFFSETS = [
  0, 0, 0, 0, 0, 0,
  32, 32, 64, 96, 64, 96,
  32, 32, 64, 96, 64, 96,
  32, 32, 64, 96, 64, 96,
  0, 0, 0, 0, 0, 0, 32, 32,
] as const
const PARTY_SLOT_EXISTS_OFFSET = PARTY_HEADER_BYTES + PARTY_SIZE * PARTY_PKM_BYTES // 0x530
const PARTY_STRUCT_BYTES = 0x534
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000

function isSafeMainRamRange(address: number, length: number) {
  return Number.isInteger(address) && (address & 3) === 0 &&
    Number.isInteger(length) && length > 0 &&
    address >= MAIN_RAM_START && address + length <= MAIN_RAM_END
}

function hex(value: number) {
  return `0x${value.toString(16).padStart(8, '0').toUpperCase()}`
}

// Independent, browser-only transcription of PML_CryptoRun's 16-bit XOR
// stream. Both encryption and decryption use the same operation. Never pass
// these copies to a guest writer or native decryption function.
function xorLocalCopy(input: Uint8Array, seed: number): Uint8Array {
  if (input.length % 2 !== 0) throw new Error('PRK62 decryption requires paired bytes.')
  const copy = new Uint8Array(input)
  const view = new DataView(copy.buffer)
  for (let offset = 0; offset < copy.length; offset += 2) {
    seed = (Math.imul(seed, 0x41c64e6d) + 0x6073) >>> 0
    view.setUint16(offset, view.getUint16(offset, true) ^ (seed >>> 16), true)
  }
  return copy
}

function readWordSum(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let checksum = 0
  for (let i = 0; i < bytes.length; i += 2) {
    checksum = (checksum + view.getUint16(i, true)) & 0xffff
  }
  return checksum
}

type DecodedLocalSlot = {
  partyWasEncrypted: boolean
  boxWasEncrypted: boolean
  boxChecksumValid: boolean
  speciesId: number
  speciesPlausible: boolean
  level: number
  currentHp: number
  maxHp: number
  hpPlausible: boolean
}

function decodeSlotBytes(raw: Uint8Array): DecodedLocalSlot {
  if (raw.length !== PARTY_PKM_BYTES) throw new Error('PRK62 party record length mismatch.')
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const pid = view.getUint32(0, true)
  const flags = view.getUint16(4, true)
  const checksum = view.getUint16(6, true)
  const partyWasEncrypted = (flags & 1) === 0
  const boxWasEncrypted = (flags & 2) === 0
  const tailBytes = raw.subarray(BOX_PKM_BYTES)
  const coreBytes = raw.subarray(BOX_CONTENT_OFFSET, BOX_CONTENT_OFFSET + BOX_CONTENT_BYTES)
  const partyTail = partyWasEncrypted ? xorLocalCopy(tailBytes, pid) : new Uint8Array(tailBytes)
  const boxCore = boxWasEncrypted ? xorLocalCopy(coreBytes, checksum) : new Uint8Array(coreBytes)
  const tail = new DataView(partyTail.buffer, partyTail.byteOffset, partyTail.byteLength)
  const core = new DataView(boxCore.buffer, boxCore.byteOffset, boxCore.byteLength)
  const blockIndex = (pid & 0x3e000) >>> 13
  const speciesId = core.getUint16(BLOCK_A_OFFSETS[blockIndex], true)
  const level = tail.getUint8(0x04)
  const currentHp = tail.getUint16(0x06, true)
  const maxHp = tail.getUint16(0x08, true)
  return {
    partyWasEncrypted,
    boxWasEncrypted,
    boxChecksumValid: readWordSum(boxCore) === checksum,
    speciesId,
    speciesPlausible: speciesId >= 1 && speciesId <= 649,
    level,
    currentHp,
    maxHp,
    hpPlausible: level >= 1 && level <= 100 && maxHp > 0 && currentHp <= maxHp,
  }
}

export type White2PartySlotResearch = {
  slot: number
  existsFlag: boolean
  pidNonzero: boolean
  checksumNonzero: boolean
  partyWasEncrypted: boolean
  boxWasEncrypted: boolean
  boxChecksumValid: boolean
  speciesId: number | null
  speciesPlausible: boolean
  level: number
  currentHp: number
  maxHp: number
  hpPlausible: boolean
}

export type White2PartyStructureSnapshot = {
  gameSystem: string
  gameData: string
  party: string
  partyPointerOffset: string
  capacity: number
  count: number
  slotExistsMask: string
  markedSlots: number
  countMatchesMask: boolean
  decodedSlotsVerified: boolean
  slots: White2PartySlotResearch[]
  pointerStable: true
  readOnly: true
  totalGuestWrites: 0
  totalNetworkMessages: 0
}

export class White2PartyStructureProbe {
  constructor(private readonly bridge: MelonDsBridge) {}

  static supportsRom(rom: MultiplayerRomIdentity) {
    return rom.gameId === 'white2' && rom.sha256?.toLowerCase() === TESTED_WHITE2_SHA256
  }

  async inspect(): Promise<White2PartyStructureSnapshot> {
    if (this.bridge.status !== 'running') throw new Error('The White 2 emulator must be running before the party probe.')
    const gameSystem = await this.bridge.read32(G_GAME_SYSTEM)
    if (!isSafeMainRamRange(gameSystem, GAME_SYSTEM_GAME_DATA_OFFSET + 4)) {
      throw new Error(`PRK62 field unavailable: invalid GameSystem pointer ${hex(gameSystem)}.`)
    }
    const gameData = await this.bridge.read32(gameSystem + GAME_SYSTEM_GAME_DATA_OFFSET)
    if (!isSafeMainRamRange(gameData, GAME_DATA_PARTY_OFFSET_CANDIDATE + 4)) {
      throw new Error(`PRK62 field unavailable: invalid GameData pointer ${hex(gameData)}.`)
    }
    const party = await this.bridge.read32(gameData + GAME_DATA_PARTY_OFFSET_CANDIDATE)
    if (!isSafeMainRamRange(party, PARTY_STRUCT_BYTES)) {
      throw new Error(`PRK62 candidate party pointer is invalid (${hex(party)}). No slot reads attempted.`)
    }

    const [capacity, count, slotExistsMask] = await Promise.all([
      this.bridge.read32(party),
      this.bridge.read32(party + 4),
      this.bridge.read8(party + PARTY_SLOT_EXISTS_OFFSET),
    ])
    if (capacity !== PARTY_SIZE || count > PARTY_SIZE) {
      throw new Error(`PRK62 candidate is not a valid party header: capacity=${capacity}, count=${count}. No slot reads attempted.`)
    }

    const slots: White2PartySlotResearch[] = []
    const occupiedRaw: { address: number; bytes: Uint8Array }[] = []
    for (let slot = 0; slot < PARTY_SIZE; slot += 1) {
      const existsFlag = (slotExistsMask & (1 << slot)) !== 0
      if (!existsFlag) {
        slots.push({ slot: slot + 1, existsFlag, pidNonzero: false,
          checksumNonzero: false, partyWasEncrypted: false, boxWasEncrypted: false,
          boxChecksumValid: false, speciesId: null, speciesPlausible: false,
          level: 0, currentHp: 0, maxHp: 0, hpPlausible: true })
        continue
      }
      const address = party + PARTY_HEADER_BYTES + slot * PARTY_PKM_BYTES
      // Copy the record out of emulated RAM before decoding anything. Gen-5
      // field and box blocks are separately XOR-encrypted, and live-game
      // getters could mutate their encryption state. Never call one.
      const raw = await this.bridge.readBytes(address, PARTY_PKM_BYTES)
      occupiedRaw.push({ address, bytes: raw })
      const { partyWasEncrypted, boxWasEncrypted, boxChecksumValid,
        speciesId, speciesPlausible, level, currentHp, maxHp, hpPlausible } = decodeSlotBytes(raw)
      const header = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
      slots.push({
        slot: slot + 1, existsFlag, pidNonzero: header.getUint32(0, true) !== 0,
        checksumNonzero: header.getUint16(6, true) !== 0, partyWasEncrypted,
        boxWasEncrypted, boxChecksumValid, speciesId, speciesPlausible,
        level, currentHp, maxHp, hpPlausible,
      })
    }

    // Reject a torn read during a map transition or a party update. Do not
    // cache pointers, and never invoke an in-game getter that might mutate
    // Pokémon encryption state.
    const [gameSystemAfter, gameDataAfter, partyAfter, countAfter, maskAfter] = await Promise.all([
      this.bridge.read32(G_GAME_SYSTEM),
      this.bridge.read32(gameSystem + GAME_SYSTEM_GAME_DATA_OFFSET),
      this.bridge.read32(gameData + GAME_DATA_PARTY_OFFSET_CANDIDATE),
      this.bridge.read32(party + 4),
      this.bridge.read8(party + PARTY_SLOT_EXISTS_OFFSET),
    ])
    if (gameSystemAfter !== gameSystem || gameDataAfter !== gameData ||
        partyAfter !== party || countAfter !== count || maskAfter !== slotExistsMask) {
      throw new Error('PRK62 game or party state changed during the read; results discarded.')
    }
    // A second snapshot of only occupied records detects mutations while we
    // were copying/decoding. Invalid/torn reads are never passed off as proof.
    for (const entry of occupiedRaw) {
      const after = await this.bridge.readBytes(entry.address, PARTY_PKM_BYTES)
      if (after.some((value, i) => value !== entry.bytes[i])) {
        throw new Error('PRK62 party record changed during the read; results discarded.')
      }
    }
    const markedSlots = Array.from({ length: PARTY_SIZE }, (_, slot) => slot)
      .filter(slot => (slotExistsMask & (1 << slot)) !== 0).length
    const result: White2PartyStructureSnapshot = {
      gameSystem: hex(gameSystem), gameData: hex(gameData), party: hex(party),
      partyPointerOffset: hex(GAME_DATA_PARTY_OFFSET_CANDIDATE),
      capacity, count, slotExistsMask: hex(slotExistsMask), markedSlots,
      countMatchesMask: markedSlots === count && (slotExistsMask & ~0x3f) === 0,
      decodedSlotsVerified: slots.filter(slot => slot.existsFlag).every(slot =>
        slot.boxChecksumValid && slot.speciesPlausible && slot.hpPlausible),
      slots, pointerStable: true, readOnly: true,
      totalGuestWrites: 0, totalNetworkMessages: 0,
    }
    console.info('[PokéRun party] PRK62 READ-ONLY PARTY STRUCTURE RESULT', result)
    return result
  }
}
