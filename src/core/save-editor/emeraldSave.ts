/**
 * Pokémon Emerald battery-save utilities.
 *
 * Gen III 128 KiB flash saves contain two rotating 14-sector save slots.
 * We locate sections by footer ID and validate every checksum before editing.
 * Only the newest valid slot is edited. The preceding slot stays untouched as
 * the game's native fallback. This module never accesses browser save storage.
 *
 * Format reference: https://bulbapedia.bulbagarden.net/wiki/Save_data_structure_(Generation_III)
 */
const FLASH_BYTES = 0x20000
const SECTOR_BYTES = 0x1000
const SECTORS_PER_SLOT = 14
const SIGNATURE = 0x08012025
const SECTION_ID_OFFSET = 0xFF4
const CHECKSUM_OFFSET = 0xFF6
const SIGNATURE_OFFSET = 0xFF8
const SAVE_INDEX_OFFSET = 0xFFC
const MONEY_OFFSET = 0x490
const KEY_OFFSET = 0xAC
const SECTION_SIZES = [
  3884, 3968, 3968, 3968, 3848, 3968, 3968,
  3968, 3968, 3968, 3968, 3968, 3968, 2000,
] as const

export interface EmeraldSaveInfo {
  /** 0 or 1: sector group containing the newest valid save. */
  slot: number
  saveIndex: number
  money: number
  playTimeHours: number
  playTimeMinutes: number
  partyCount: number
}

interface ValidSlot {
  slot: number
  saveIndex: number
  sections: number[]
}

function checksum(view: DataView, position: number, length: number): number {
  let total = 0
  for (let offset = 0; offset < length; offset += 4) {
    total = (total + view.getUint32(position + offset, true)) >>> 0
  }
  return ((total & 0xFFFF) + (total >>> 16)) & 0xFFFF
}

function inspectSlot(view: DataView, slot: number): ValidSlot | null {
  const sections = Array<number>(SECTORS_PER_SLOT).fill(-1)
  const base = slot * SECTORS_PER_SLOT * SECTOR_BYTES
  let saveIndex: number | null = null

  for (let sector = 0; sector < SECTORS_PER_SLOT; sector++) {
    const offset = base + sector * SECTOR_BYTES
    if (view.getUint32(offset + SIGNATURE_OFFSET, true) !== SIGNATURE) return null

    const id = view.getUint16(offset + SECTION_ID_OFFSET, true)
    if (id >= SECTORS_PER_SLOT || sections[id] !== -1) return null

    const index = view.getUint32(offset + SAVE_INDEX_OFFSET, true)
    if (saveIndex !== null && index !== saveIndex) return null
    saveIndex = index

    if (view.getUint16(offset + CHECKSUM_OFFSET, true) !== checksum(view, offset, SECTION_SIZES[id])) {
      return null
    }
    sections[id] = offset
  }

  if (sections.some(offset => offset < 0) || saveIndex === null) return null
  return { slot, sections, saveIndex }
}

function mostRecentSlot(bytes: Uint8Array): { view: DataView, latest: ValidSlot } {
  if (bytes.byteLength !== FLASH_BYTES) {
    throw new Error('Emerald saves must be 128 KiB (.sav). This file has a different size.')
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const first = inspectSlot(view, 0)
  const second = inspectSlot(view, 1)

  if (!first && !second) {
    throw new Error('No valid Gen III save slot found. The file may be corrupted or use a different format.')
  }

  // Signed counter distance handles the 32-bit wraparound.
  const latest = !first ? second! : !second ? first
    : ((second.saveIndex - first.saveIndex) >>> 0) < 0x80000000 && second.saveIndex !== first.saveIndex
      ? second : first

  return { view, latest }
}

export function readEmeraldSave(bytes: Uint8Array): EmeraldSaveInfo {
  const { view, latest } = mostRecentSlot(bytes)
  const trainer = latest.sections[0]
  const items = latest.sections[1]
  const securityKey = view.getUint32(trainer + KEY_OFFSET, true)
  const money = (view.getUint32(items + MONEY_OFFSET, true) ^ securityKey) >>> 0
  const partyCount = view.getUint32(items + 0x234, true)
  const playTimeMinutes = view.getUint8(trainer + 0x10)

  // Gen III shares a sector layout across several games. Enforce basic
  // Emerald field ranges rather than permitting edits to an unknown format.
  if (money > 999999 || partyCount > 6 || playTimeMinutes > 59) {
    throw new Error('The file passed sector checks but does not look like a supported Emerald save.')
  }

  return {
    slot: latest.slot,
    saveIndex: latest.saveIndex,
    money,
    playTimeHours: view.getUint16(trainer + 0x0E, true),
    playTimeMinutes,
    partyCount,
  }
}

/**
 * Return a new buffer with the current Emerald save's money changed.
 * The caller's bytes and the other backup save slot are never modified.
 */
export function changeEmeraldMoney(source: Uint8Array, money: number): Uint8Array {
  if (!Number.isSafeInteger(money) || money < 0 || money > 999999) {
    throw new Error('Money must be a whole number between 0 and 999,999.')
  }

  // Validate before editing; never guess section positions.
  readEmeraldSave(source)
  const copy = source.slice()
  const { view, latest } = mostRecentSlot(copy)
  const securityKey = view.getUint32(latest.sections[0] + KEY_OFFSET, true)
  const items = latest.sections[1]

  view.setUint32(items + MONEY_OFFSET, (money ^ securityKey) >>> 0, true)
  view.setUint16(items + CHECKSUM_OFFSET, checksum(view, items, SECTION_SIZES[1]), true)

  if (readEmeraldSave(copy).money !== money) {
    throw new Error('Edited save did not pass validation.')
  }

  return copy
}
