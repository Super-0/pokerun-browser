// PRK74: read-only structural validation for complete existing White 2
// battery saves imported as new, disposable local profiles. This intentionally
// does NOT infer story progress, change event flags, or alter party/trainer data.
// The game itself must confirm the Basic Badge, real C-Gear, and Union Room.
const SAVE_BYTES = 0x80000
const REGION_BYTES = 0x26000
const CRC_TABLE_OFFSET = 0x25f00
const CRC_TABLE_LENGTH = 0x94
const FOOTER_OFFSET = 0x25f94
const FOOTER_CRC_OFFSET = 0x25fa2
const FOOTER_SIZE = 0x25fa4
const FOOTER_MAGIC = 0x31053527

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

export function validateWhite2ProgressedTestSave(bytes: Uint8Array) {
  if (bytes.length !== SAVE_BYTES) {
    throw new Error('PRK74 requires a complete 512 KB raw White 2 .sav battery image (not a save state or .dsv).')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let validRegions = 0
  for (const region of [0, REGION_BYTES]) {
    if (view.getUint32(region + FOOTER_OFFSET + 4, true) !== FOOTER_SIZE ||
        view.getUint32(region + FOOTER_OFFSET + 8, true) !== FOOTER_MAGIC) continue
    const expectedCrc = view.getUint16(region + FOOTER_CRC_OFFSET, true)
    const actualCrc = crc16Ccitt(bytes.subarray(
      region + CRC_TABLE_OFFSET, region + CRC_TABLE_OFFSET + CRC_TABLE_LENGTH,
    ))
    if (actualCrc === expectedCrc) validRegions += 1
  }
  if (validRegions === 0) {
    throw new Error('No valid White 2 save footer/CRC-table checksum found. Import canceled; original saves remain unchanged.')
  }
}
