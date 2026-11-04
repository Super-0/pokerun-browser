import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../core/protocol'
import { TESTED_WHITE2_SHA256 } from './White2LiveStateAdapter'

// PRK62 — read-only, opt-in structural research for the exact tested W2 ROM.
// Sources: fuddlesworth/pokebw2 include/system/game_system.h,
// src/system/game_data.c, include/field/player_state.h,
// include/save/player_info.h, include/field/zone.h,
// include/pml/poke_party.h. Offset 0x194 is DERIVED from those C layouts;
// it is NOT considered validated on the live cartridge until this probe runs.
// No guest calls, data decryption, Pokémon exchange, save writes or transport.
const G_GAME_SYSTEM = 0x02141134
const GAME_SYSTEM_GAME_DATA_OFFSET = 0x1c
const GAME_DATA_PARTY_OFFSET_CANDIDATE = 0x194
const PARTY_SIZE = 6
const PARTY_HEADER_BYTES = 8
const PARTY_PKM_BYTES = 220
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

export type White2PartySlotResearch = {
  slot: number
  existsFlag: boolean
  pidNonzero: boolean
  checksumNonzero: boolean
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
    for (let slot = 0; slot < PARTY_SIZE; slot += 1) {
      const existsFlag = (slotExistsMask & (1 << slot)) !== 0
      // Read public structural fields only for marked slots. Gen-5 boxed
      // Pokémon content is block-shuffled/encrypted; do not guess species or
      // nickname from these bytes and never log the actual PID/checksum.
      if (!existsFlag) {
        slots.push({ slot: slot + 1, existsFlag, pidNonzero: false,
          checksumNonzero: false, level: 0, currentHp: 0, maxHp: 0, hpPlausible: true })
        continue
      }
      const base = party + PARTY_HEADER_BYTES + slot * PARTY_PKM_BYTES
      const [pid, checksum, level, currentHp, maxHp] = await Promise.all([
        this.bridge.read32(base + 0x00),
        this.bridge.read16(base + 0x06),
        this.bridge.read8(base + 0x8c),
        this.bridge.read16(base + 0x8e),
        this.bridge.read16(base + 0x90),
      ])
      slots.push({
        slot: slot + 1, existsFlag, pidNonzero: pid !== 0,
        checksumNonzero: checksum !== 0, level, currentHp, maxHp,
        hpPlausible: level >= 1 && level <= 100 && maxHp > 0 && currentHp <= maxHp,
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
    const markedSlots = Array.from({ length: PARTY_SIZE }, (_, slot) => slot)
      .filter(slot => (slotExistsMask & (1 << slot)) !== 0).length
    const result: White2PartyStructureSnapshot = {
      gameSystem: hex(gameSystem), gameData: hex(gameData), party: hex(party),
      partyPointerOffset: hex(GAME_DATA_PARTY_OFFSET_CANDIDATE),
      capacity, count, slotExistsMask: hex(slotExistsMask), markedSlots,
      countMatchesMask: markedSlots === count && (slotExistsMask & ~0x3f) === 0,
      slots, pointerStable: true, readOnly: true,
      totalGuestWrites: 0, totalNetworkMessages: 0,
    }
    console.info('[PokéRun party] PRK62 READ-ONLY PARTY STRUCTURE RESULT', result)
    return result
  }
}
