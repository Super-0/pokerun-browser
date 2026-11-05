// Validate a PRK63 C-Gear test copy *before* importing it as a separate local
// White 2 save profile. Does not parse or modify Pokémon, badges, or event flags.
// The known original PokéRun backup format has two identical 0x26000-byte
// save regions within the 0x80000-byte DS battery image.
const SAVE_BYTES = 0x80000
const REGION_BYTES = 0x26000
const CGEAR_START = 0x1c000
const CGEAR_LENGTH = 0x94
const CGEAR_ON_OFFSET = CGEAR_START + 0x2f
const CGEAR_CRC_OFFSET = 0x1c096
const CGEAR_MIRROR_OFFSET = 0x25f40
// White 2's save footer also authenticates the entire per-block CRC table.
// Earlier PRK63 builds checked only the C-Gear block and mistakenly accepted
// a corrupt table footer. See src/gfl/backup_system.c in pokebw2 decomp.
const CRC_TABLE_OFFSET = 0x25f00
const CRC_TABLE_LENGTH = 0x94 // 74 16-bit block CRC entries
const MAIN_FOOTER_OFFSET = 0x25f94
const MAIN_FOOTER_CRC_OFFSET = 0x25fa2
const MAIN_FOOTER_SIZE = 0x25fa4
const MAIN_FOOTER_MAGIC = 0x31053527

function crc16Ccitt(data: Uint8Array) {
  let crc = 0xffff
  for (const byte of data) {
    crc ^= byte << 8
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff
    }
  }
  return crc
}

export function validateWhite2CgearTestSave(bytes: Uint8Array) {
  if (bytes.length !== SAVE_BYTES) {
    throw new Error('This experiment requires a complete 512 KB White 2 .sav battery image.')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < REGION_BYTES; i += 1) {
    if (bytes[i] !== bytes[REGION_BYTES + i]) {
      throw new Error('The two save copies differ. This import only accepts the matched-copy PRK63 test file.')
    }
  }
  for (const region of [0, REGION_BYTES]) {
    if (bytes[region + CGEAR_ON_OFFSET] !== 1) {
      throw new Error('The C-Gear availability setting is not enabled in this test save.')
    }
    const crc = crc16Ccitt(bytes.subarray(region + CGEAR_START, region + CGEAR_START + CGEAR_LENGTH))
    const expected = view.getUint16(region + CGEAR_CRC_OFFSET, true)
    const mirror = view.getUint16(region + CGEAR_MIRROR_OFFSET, true)
    if (crc !== expected || crc !== mirror) {
      throw new Error('C-Gear block checksum mismatch. Refusing to import the test save.')
    }
    if (view.getUint32(region + MAIN_FOOTER_OFFSET + 4, true) !== MAIN_FOOTER_SIZE ||
        view.getUint32(region + MAIN_FOOTER_OFFSET + 8, true) !== MAIN_FOOTER_MAGIC) {
      throw new Error('White 2 main save footer size/magic mismatch. The edited test save cannot be imported.')
    }
    const tableCrc = crc16Ccitt(bytes.subarray(
      region + CRC_TABLE_OFFSET,
      region + CRC_TABLE_OFFSET + CRC_TABLE_LENGTH,
    ))
    if (tableCrc !== view.getUint16(region + MAIN_FOOTER_CRC_OFFSET, true)) {
      throw new Error('White 2 main save footer checksum mismatch. The old PRK63 edited file is corrupt; download the repaired test save instead.')
    }
  }
}
