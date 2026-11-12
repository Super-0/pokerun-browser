/**
 * Generation III Pokémon save reader and money editor.
 *
 * File: 128 KiB flash with two alternating 14-sector save slots.
 * Every sector is independently checksummed and tagged by its section ID.
 * Variant identification follows Gen III layout markers, not filenames.
 *
 * No ROMs, cloud APIs, or persistent PokéRun data are accessed here.
 */
const FLASH_BYTES = 0x20000
const SECTOR_BYTES = 0x1000
const SECTORS_PER_SLOT = 14
const SIGNATURE = 0x08012025
const SECTION_ID_OFFSET = 0xFF4
const CHECKSUM_OFFSET = 0xFF6
const SIGNATURE_OFFSET = 0xFF8
const SAVE_INDEX_OFFSET = 0xFFC
const SECTION_SIZES = [
  3884, 3968, 3968, 3968, 3848, 3968, 3968,
  3968, 3968, 3968, 3968, 3968, 3968, 2000,
] as const

export type Gen3Variant = 'ruby-sapphire' | 'emerald' | 'firered-leafgreen'

export interface Gen3SaveInfo {
  variant: Gen3Variant
  gameLabel: string
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

function newestValidSlot(bytes: Uint8Array) {
  if (bytes.byteLength !== FLASH_BYTES) {
    throw new Error('Generation III flash saves must be 128 KiB.')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const a = inspectSlot(view, 0)
  const b = inspectSlot(view, 1)
  if (!a && !b) {
    throw new Error('No valid Generation III save slot found. The file may be unsupported or corrupted.')
  }
  const latest = !a ? b! : !b ? a
    : ((b.saveIndex - a.saveIndex) >>> 0) < 0x80000000 && b.saveIndex !== a.saveIndex
      ? b : a
  return { view, latest }
}

function hasNonZero(view: DataView, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (view.getUint8(i) !== 0) return true
  }
  return false
}

/**
 * Distinguish the shared Gen III save families from their in-save layout.
 * Ruby vs Sapphire and FireRed vs LeafGreen cannot always be distinguished
 * from a battery save alone, so those are displayed as pairs.
 *
 * If the data matches neither a supported variant nor a trustworthy marker,
 * refuse editing instead of choosing the layout from the filename.
 */
function getVariant(view: DataView, trainer: number): Gen3Variant {
  const marker = view.getUint32(trainer + 0xAC, true)
  const emeraldRemainder = hasNonZero(view, trainer + 0x890, trainer + 0xF2C)

  if (marker === 1) return 'firered-leafgreen'
  if (marker === 0 && !emeraldRemainder) return 'ruby-sapphire'

  // An Emerald save stores a copy of its security key elsewhere in trainer data.
  // Require the matching value to avoid interpreting R/S Battle Tower records
  // as the encryption key and silently damaging its money field.
  const mirroredKey = view.getUint32(trainer + 0x1F4, true)
  if (emeraldRemainder && marker === mirroredKey) return 'emerald'
  if (!emeraldRemainder) return 'ruby-sapphire'

  throw new Error('Generation III save recognized, but the game variant is ambiguous. Editing is disabled for safety.')
}

function offsets(variant: Gen3Variant) {
  if (variant === 'firered-leafgreen') {
    return { money: 0x290, party: 0x34, securityKey: 0xAF8, partySize: 1 }
  }
  return { money: 0x490, party: 0x234, securityKey: variant === 'emerald' ? 0xAC : null, partySize: 4 }
}

export function inspectGen3Save(bytes: Uint8Array): Gen3SaveInfo {
  const { view, latest } = newestValidSlot(bytes)
  const trainer = latest.sections[0]
  const items = latest.sections[1]
  const variant = getVariant(view, trainer)
  const layout = offsets(variant)
  const securityKey = layout.securityKey === null ? 0 : view.getUint32(trainer + layout.securityKey, true)
  const money = (view.getUint32(items + layout.money, true) ^ securityKey) >>> 0
  const partyCount = layout.partySize === 1
    ? view.getUint8(items + layout.party)
    : view.getUint32(items + layout.party, true)
  const playTimeHours = view.getUint16(trainer + 0x0E, true)
  const playTimeMinutes = view.getUint8(trainer + 0x10)

  if (money > 999999 || partyCount > 6 || playTimeMinutes > 59) {
    throw new Error('Generation III sectors validated, but the player data does not match a supported save layout.')
  }

  const gameLabel = variant === 'emerald' ? 'Pokémon Emerald'
    : variant === 'ruby-sapphire' ? 'Pokémon Ruby / Sapphire'
    : 'Pokémon FireRed / LeafGreen'

  return {
    variant,
    gameLabel,
    slot: latest.slot,
    saveIndex: latest.saveIndex,
    money,
    playTimeHours,
    playTimeMinutes,
    partyCount,
  }
}

/** Export a byte-for-byte copy except for the current money field and checksum.
 * The older in-game backup slot and the uploaded bytes remain unchanged. */
export function changeGen3Money(source: Uint8Array, money: number): Uint8Array {
  if (!Number.isSafeInteger(money) || money < 0 || money > 999999) {
    throw new Error('Money must be a whole number between 0 and 999,999.')
  }
  const info = inspectGen3Save(source)
  const copy = source.slice()
  const { view, latest } = newestValidSlot(copy)
  const layout = offsets(info.variant)
  const trainer = latest.sections[0]
  const items = latest.sections[1]
  const securityKey = layout.securityKey === null ? 0 : view.getUint32(trainer + layout.securityKey, true)

  view.setUint32(items + layout.money, (money ^ securityKey) >>> 0, true)
  view.setUint16(items + CHECKSUM_OFFSET, checksum(view, items, SECTION_SIZES[1]), true)

  const confirmed = inspectGen3Save(copy)
  if (confirmed.variant !== info.variant || confirmed.money !== money) {
    throw new Error('Exported save did not pass validation.')
  }
  return copy
}
