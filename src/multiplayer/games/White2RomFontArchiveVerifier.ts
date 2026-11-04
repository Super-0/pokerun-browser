/**
 * PRK35: read-only NDS FAT -> NARC BTAF/BTNF/GMIF -> font glyph verification.
 *
 * Input is the user's existing browser-held cartridge Uint8Array. Never sends
 * or modifies the cartridge, calls guest Nitro FS, or writes emulator memory.
 * Offsets are checked before every read; no hardcoded ROM asset bytes.
 */
export type White2LiveFontLocation = {
  rootRomFileId: number
  fsFileStart: number
  fsFileEnd: number
  narcMemberFileId: number
  fontFileOffset: number
  glyphsOffset: number
  glyphIndex: number
  glyphCellSize: number
}

export type White2VerifiedFontGlyph = {
  rootRomFileId: number
  romBytes: number
  fatOffset: number
  fatEntryStart: number
  fatEntryEnd: number
  narcSize: number
  narcHeaderSize: number
  narcChunkCount: number
  narcMemberCount: number
  narcMemberFileId: number
  narcMemberOffset: number
  narcMemberLength: number
  fontMemberMagic: string
  glyphIndex: number
  glyphCellSize: number
  glyphArchiveOffset: number
  glyphAbsoluteRomOffset: number
  glyphAbsoluteRomEnd: number
  glyphPreview8: string
  glyphFnv1a32: string
}

export function verifyWhite2FontGlyphFromRom(
  rom: Uint8Array,
  live: White2LiveFontLocation,
): White2VerifiedFontGlyph {
  if (rom.byteLength < 0x200) throw new Error('NDS ROM is too small for a valid header.')
  const view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength)
  const ensureRange = (start: number, size: number, label: string) => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) ||
        start < 0 || size < 0 || start + size > rom.byteLength) {
      throw new Error(`Invalid ${label} ROM span at ${start} for ${size} bytes (ROM length ${rom.byteLength}).`)
    }
  }
  const u16 = (offset: number) => { ensureRange(offset, 2, 'u16'); return view.getUint16(offset, true) }
  const u32 = (offset: number) => { ensureRange(offset, 4, 'u32'); return view.getUint32(offset, true) }
  const tag = (offset: number) => {
    ensureRange(offset, 4, 'tag')
    return String.fromCharCode(rom[offset], rom[offset + 1], rom[offset + 2], rom[offset + 3])
  }
  const assert = (ok: boolean, why: string) => { if (!ok) throw new Error(why) }

  // NDS filesystem FAT pointer/length are in the cartridge header.
  const fatOffset = u32(0x48)
  const fatSize = u32(0x4c)
  assert(fatSize > 0 && fatSize % 8 === 0, 'NDS FAT size is not an array of 8-byte entries.')
  ensureRange(fatOffset, fatSize, 'NDS FAT')
  const rootRomFileId = live.rootRomFileId
  assert(Number.isInteger(rootRomFileId) && rootRomFileId >= 0 &&
    rootRomFileId < fatSize / 8, 'Live Nitro FSFile file ID is outside the NDS FAT.')
  const fatEntry = fatOffset + rootRomFileId * 8
  const fatEntryStart = u32(fatEntry)
  const fatEntryEnd = u32(fatEntry + 4)
  ensureRange(fatEntryStart, fatEntryEnd - fatEntryStart, 'NDS FAT archive file')
  assert(fatEntryEnd > fatEntryStart, 'NDS FAT archive entry is empty.')
  assert(fatEntryStart === live.fsFileStart && fatEntryEnd === live.fsFileEnd,
    'Live Nitro FSFile range disagrees with NDS cartridge FAT entry.')

  // NARC outer header and its section order are defined by Nitro.
  assert(tag(fatEntryStart) === 'NARC', 'FAT archive entry does not start with NARC.')
  const narcSize = u32(fatEntryStart + 8)
  const narcHeaderSize = u16(fatEntryStart + 0x0c)
  const narcChunkCount = u16(fatEntryStart + 0x0e)
  assert(narcHeaderSize >= 0x10 && narcHeaderSize <= 0x40, 'NARC header size invalid.')
  assert(narcChunkCount === 3, 'Expected a three-section Nitro NARC.')
  assert(narcSize <= fatEntryEnd - fatEntryStart && narcSize >= narcHeaderSize + 32,
    'NARC declared size exceeds FAT archive entry.')

  const fatb = fatEntryStart + narcHeaderSize
  assert(tag(fatb) === 'BTAF', 'NARC BTAF section tag missing.')
  const fatbSize = u32(fatb + 4)
  const narcMemberCount = u16(fatb + 8)
  assert(fatbSize >= 12 && fatbSize >= 12 + narcMemberCount * 8,
    'NARC BTAF size is inconsistent with member count.')
  ensureRange(fatb, fatbSize, 'BTAF section')
  assert(narcMemberCount > live.narcMemberFileId && live.narcMemberFileId >= 0,
    'Font NARC member ID is outside its BTAF.')

  const fntb = fatb + fatbSize
  assert(tag(fntb) === 'BTNF', 'NARC BTNF section tag missing.')
  const fntbSize = u32(fntb + 4)
  assert(fntbSize >= 8, 'NARC BTNF section too short.')
  ensureRange(fntb, fntbSize, 'BTNF section')

  const fimg = fntb + fntbSize
  assert(tag(fimg) === 'GMIF', 'NARC GMIF section tag missing.')
  const fimgSize = u32(fimg + 4)
  assert(fimgSize >= 8, 'NARC GMIF section too short.')
  ensureRange(fimg, fimgSize, 'GMIF section')
  assert(fimg + fimgSize <= fatEntryStart + narcSize,
    'NARC sections extend past its declared archive size.')

  const entry = fatb + 12 + live.narcMemberFileId * 8
  ensureRange(entry, 8, 'BTAF member entry')
  const memberStart = u32(entry)
  const memberEnd = u32(entry + 4)
  assert(memberEnd > memberStart && memberEnd <= fimgSize - 8,
    'Font member extends outside the GMIF data section.')

  const memberOffset = (fimg - fatEntryStart) + 8 + memberStart
  assert(memberOffset === live.fontFileOffset,
    'Live Font.fileOffset does not match NARC BTAF member placement.')
  const memberAbsoluteStart = fatEntryStart + memberOffset
  const memberAbsoluteEnd = fatEntryStart + (fimg - fatEntryStart) + 8 + memberEnd
  ensureRange(memberAbsoluteStart, memberAbsoluteEnd - memberAbsoluteStart, 'font member')
  assert(Number.isInteger(live.glyphCellSize) && live.glyphCellSize > 0 &&
    live.glyphCellSize <= 512 && Number.isInteger(live.glyphIndex) &&
    live.glyphIndex >= 0 && live.glyphIndex <= 0xffff,
  'Glyph index or cell size is invalid.')

  const glyphArchiveOffset = live.fontFileOffset + live.glyphsOffset +
    live.glyphIndex * live.glyphCellSize
  const glyphAbsoluteRomOffset = fatEntryStart + glyphArchiveOffset
  ensureRange(glyphAbsoluteRomOffset, live.glyphCellSize, 'glyph cell')
  assert(glyphAbsoluteRomOffset >= memberAbsoluteStart &&
    glyphAbsoluteRomOffset + live.glyphCellSize <= memberAbsoluteEnd,
  'Glyph cell extends beyond its NARC font member.')

  let hash = 0x811c9dc5
  for (let i = 0; i < live.glyphCellSize; i += 1) {
    hash ^= rom[glyphAbsoluteRomOffset + i]
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const preview = Array.from(rom.subarray(glyphAbsoluteRomOffset, glyphAbsoluteRomOffset + 8),
    value => value.toString(16).padStart(2, '0')).join(' ')

  return {
    rootRomFileId, romBytes: rom.byteLength, fatOffset,
    fatEntryStart, fatEntryEnd,
    narcSize, narcHeaderSize, narcChunkCount, narcMemberCount,
    narcMemberFileId: live.narcMemberFileId,
    narcMemberOffset: memberOffset,
    narcMemberLength: memberEnd - memberStart,
    fontMemberMagic: tag(memberAbsoluteStart),
    glyphIndex: live.glyphIndex,
    glyphCellSize: live.glyphCellSize,
    glyphArchiveOffset, glyphAbsoluteRomOffset,
    glyphAbsoluteRomEnd: glyphAbsoluteRomOffset + live.glyphCellSize,
    glyphPreview8: preview,
    glyphFnv1a32: `0x${hash.toString(16).padStart(8, '0')}`,
  }
}

/**
 * PRK37: independent, read-only decoder of one White 2 font glyph cell.
 *
 * Pinned pokebw2 src/system/gf_font.c:
 * - GFL_FontGlyphCopy: cell[0..2] = x, width, advance; pixels at cell+3
 * - GFL_FontBitmapCopy_16x16: read each source row as MSB-first 2bpp
 * - GFL_TextRndUpdateColorIndexLUT(1,2,0): src 0/1/2/3 -> tile nibble 0/1/2/0
 *
 * The 12x15 field font uses 3 + ceil(12*15*2/8) = 48 bytes per cell.
 * Output tiles are a separate 128-byte 16x16 4bpp buffer, NEVER guest VRAM.
 */
export type White2DecodedFontGlyph = {
  absoluteRomOffset: number
  cellBytes: number
  cellWidth: number
  cellHeight: number
  x: number
  width: number
  advance: number
  source2bppCounts: [number, number, number, number]
  nonzeroColorPixels: number
  native4bppTileBytes: number
  native4bppTileFnv1a32: string
  asciiRows: string[]
}

export function decodeWhite2PackedFontGlyph(
  rom: Uint8Array,
  absoluteRomOffset: number,
  cellBytes: number,
  cellWidth: number,
  cellHeight: number,
): White2DecodedFontGlyph {
  if (!Number.isSafeInteger(absoluteRomOffset) || !Number.isSafeInteger(cellBytes) ||
      absoluteRomOffset < 0 || cellBytes < 4 || absoluteRomOffset + cellBytes > rom.byteLength) {
    throw new Error('PRK37 glyph cell points outside the browser-held ROM.')
  }
  if (!Number.isInteger(cellWidth) || !Number.isInteger(cellHeight) ||
      cellWidth < 1 || cellWidth > 16 || cellHeight < 1 || cellHeight > 16) {
    throw new Error('PRK37 only decodes glyphs fitting a 2x2-tile 16x16 destination.')
  }
  const sourcePixelBytes = Math.ceil(cellWidth * cellHeight * 2 / 8)
  if (cellBytes !== sourcePixelBytes + 3) {
    throw new Error(`PRK37 cell has ${cellBytes} bytes; expected 3 metadata + ${sourcePixelBytes} packed pixel bytes.`)
  }
  const x = rom[absoluteRomOffset]
  const width = rom[absoluteRomOffset + 1]
  const advance = rom[absoluteRomOffset + 2]
  if (width > cellWidth || advance > 32) {
    throw new Error(`PRK37 glyph placement invalid: x=${x} width=${width} advance=${advance} cellWidth=${cellWidth}.`)
  }

  // DS text tiles: 4 tiles, 32 bytes each. A pixel's low nibble comes before
  // its horizontal neighbor's high nibble. Default White 2 text colors map
  // glyph source colors 0/1/2/3 to 0/1/2/0 (transparent/ink/shadow/bg).
  const nativeTiles = new Uint8Array(4 * 32)
  const counts: [number, number, number, number] = [0, 0, 0, 0]
  const symbols = ['.', '#', '+', '_']
  const rows: string[] = []
  for (let y = 0; y < cellHeight; y += 1) {
    let row = ''
    for (let xPixel = 0; xPixel < cellWidth; xPixel += 1) {
      const pixelIndex = y * cellWidth + xPixel
      const bitIndex = pixelIndex * 2
      const packedByte = rom[absoluteRomOffset + 3 + (bitIndex >> 3)]
      const sourceValue = (packedByte >>> (6 - (bitIndex & 7))) & 3
      counts[sourceValue] += 1
      row += symbols[sourceValue]
      const destPalette = sourceValue === 1 ? 1 : sourceValue === 2 ? 2 : 0
      const tileIndex = (y >> 3) * 2 + (xPixel >> 3)
      const pixelInTile = (y & 7) * 8 + (xPixel & 7)
      const destByteIndex = tileIndex * 32 + (pixelInTile >> 1)
      nativeTiles[destByteIndex] |= destPalette << ((pixelInTile & 1) * 4)
    }
    rows.push(row)
  }

  let hash = 0x811c9dc5
  for (const byte of nativeTiles) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return {
    absoluteRomOffset,
    cellBytes,
    cellWidth,
    cellHeight,
    x,
    width,
    advance,
    source2bppCounts: counts,
    nonzeroColorPixels: counts[1] + counts[2],
    native4bppTileBytes: nativeTiles.length,
    native4bppTileFnv1a32: `0x${hash.toString(16).padStart(8, '0')}`,
    asciiRows: rows,
  }
}


/**
 * PRK38: compose a single decoded glyph over FOUR existing 4bpp background
 * tiles (2x2, 16x16 pixels) in JavaScript, leaving them in host memory.
 * Nothing is written to emulated RAM or VRAM by this function.
 *
 * Black window fill 0xFF means a background pixel is palette nibble 15.
 * Leave source 0/3 pixels untouched; source 1 and 2 become nibble 1 and 2.
 * Uses the independently verified MSB-first PRK37 decoded ASCII rows.
 */
export function composeWhite2GlyphInTileRam(
  rom: Uint8Array,
  absoluteRomOffset: number,
  cellBytes: number,
  cellWidth: number,
  cellHeight: number,
  originalTiles: Uint8Array,
): {
  nextTiles: Uint8Array
  changedBytes: number
  inkPixels: number
  shadowPixels: number
  decodedWidth: number
  decodedAdvance: number
} {
  if (originalTiles.length !== 128 || originalTiles.some(byte => byte !== 0xff)) {
    throw new Error('PRK38 expected four untouched black-fill 4bpp tiles (128 bytes of 0xFF).')
  }
  const glyph = decodeWhite2PackedFontGlyph(
    rom, absoluteRomOffset, cellBytes, cellWidth, cellHeight,
  )
  if (glyph.x !== 0 || glyph.width !== 6 || glyph.advance !== 6) {
    throw new Error('PRK38 expects the verified six-pixel A glyph with zero X offset.')
  }
  const nextTiles = originalTiles.slice()
  let inkPixels = 0
  let shadowPixels = 0
  for (let y = 0; y < cellHeight; y += 1) {
    for (let x = 0; x < cellWidth; x += 1) {
      const pixel = glyph.asciiRows[y][x]
      const paletteIndex = pixel === '#' ? 1 : pixel === '+' ? 2 : 0
      if (paletteIndex === 0) continue
      if (paletteIndex === 1) inkPixels += 1
      else shadowPixels += 1
      const tile = (y >> 3) * 2 + (x >> 3)
      const pixelWithinTile = (y & 7) * 8 + (x & 7)
      const byteIndex = tile * 32 + (pixelWithinTile >> 1)
      const shift = (pixelWithinTile & 1) * 4
      nextTiles[byteIndex] =
        (nextTiles[byteIndex] & ~(0x0f << shift)) | (paletteIndex << shift)
    }
  }
  let changedBytes = 0
  for (let i = 0; i < nextTiles.length; i += 1) {
    if (nextTiles[i] !== originalTiles[i]) changedBytes += 1
  }
  if (inkPixels !== glyph.source2bppCounts[1] ||
      shadowPixels !== glyph.source2bppCounts[2] ||
      changedBytes === 0) {
    throw new Error('PRK38 glyph composition does not match independently decoded source pixels.')
  }
  return {
    nextTiles, changedBytes, inkPixels, shadowPixels,
    decodedWidth: glyph.width, decodedAdvance: glyph.advance,
  }
}
