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

/**
 * PRK40: overlay a second 12x15 native 2bpp font glyph into four adjacent
 * 4bpp tiles. Input is a copy of PRK39's 16x16 bitmap block containing A.
 * `startX=6` places B at A's verified advance, crossing the 8px tile edge.
 * This pure function never writes emulator RAM or BG2 VRAM.
 */
export function composeWhite2GlyphOverExistingTiles(
  rom: Uint8Array,
  absoluteRomOffset: number,
  originalTiles: Uint8Array,
  startX: number,
): {
  nextTiles: Uint8Array
  changedPerTile: [number, number, number, number]
  changedBytes: number
  inkPixels: number
  shadowPixels: number
  advance: number
} {
  if (originalTiles.length !== 128 || !Number.isInteger(startX) ||
      startX < 0 || startX >= 16) {
    throw new Error('PRK40 requires a 16x16 four-tile block and a valid glyph X origin.')
  }
  const glyph = decodeWhite2PackedFontGlyph(rom, absoluteRomOffset, 48, 12, 15)
  if (glyph.x !== 0 || glyph.width !== 6 || glyph.advance !== 6 ||
      startX + glyph.width > 16) {
    throw new Error('PRK40 B glyph has unexpected offset, width or character advance.')
  }
  const nextTiles = originalTiles.slice()
  let inkPixels = 0
  let shadowPixels = 0
  for (let y = 0; y < 15; y += 1) {
    for (let x = 0; x < 12; x += 1) {
      const pixel = glyph.asciiRows[y][x]
      const paletteIndex = pixel === '#' ? 1 : pixel === '+' ? 2 : 0
      if (!paletteIndex) continue
      const xDest = startX + x
      if (xDest >= 16) throw new Error('PRK40 nonblank B pixel escapes four-tile block.')
      const tileIndex = (y >> 3) * 2 + (xDest >> 3)
      const pixelWithinTile = (y & 7) * 8 + (xDest & 7)
      const byteOffset = tileIndex * 32 + (pixelWithinTile >> 1)
      const shift = (pixelWithinTile & 1) * 4
      const currentPaletteIndex = (nextTiles[byteOffset] >> shift) & 0xf
      // The second glyph must not overwrite A's existing ink/shadow pixels.
      if (currentPaletteIndex !== 15) {
        throw new Error('PRK40 B glyph overlaps existing A ink/shadow at ' + xDest + ',' + y)
      }
      nextTiles[byteOffset] =
        (nextTiles[byteOffset] & ~(0xf << shift)) | (paletteIndex << shift)
      if (paletteIndex === 1) inkPixels += 1
      else shadowPixels += 1
    }
  }
  const changedPerTile = [0, 0, 0, 0] as [number, number, number, number]
  for (let tile = 0; tile < 4; tile += 1) {
    for (let i = 0; i < 32; i += 1) {
      const idx = tile * 32 + i
      if (nextTiles[idx] !== originalTiles[idx]) changedPerTile[tile] += 1
    }
  }
  const changedBytes = changedPerTile.reduce((a, b) => a + b, 0)
  if (inkPixels !== glyph.source2bppCounts[1] ||
      shadowPixels !== glyph.source2bppCounts[2] || !changedBytes) {
    throw new Error('PRK40 B glyph source pixels disagree with destination composition.')
  }
  return {
    nextTiles, changedPerTile, changedBytes, inkPixels, shadowPixels,
    advance: glyph.advance,
  }
}


/**
 * PRK41: complete printable ASCII font-metric survey using only the validated
 * NARC member bytes. White 2's native printsys.c draws at penX + glyph.x,
 * copies glyph.width source pixels and moves penX by glyph.advance.
 * No emulator call and no writes to ROM, guest RAM, or VRAM.
 */
export function auditWhite2AsciiFont(
  rom: Uint8Array,
  memberStartRomOffset: number,
  memberLength: number,
  glyphsOffset: number,
  glyphCellSize: number,
): {
  glyphCount: number
  metrics: Array<{
    codepoint: number
    character: string
    x: number
    width: number
    advance: number
    inkPixels: number
    shadowPixels: number
  }>
  advanceDistribution: Record<string, number>
  advanceWidthDifferences: number
  nonzeroOffsetGlyphs: string[]
  blankGlyphs: string[]
  fontMetricsFnv1a32: string
  sampleText: Array<{ text: string; totalAdvance: number; placements: number[] }>
} {
  const firstAscii = 32
  const lastAscii = 126
  if (!Number.isSafeInteger(memberStartRomOffset) ||
      !Number.isSafeInteger(memberLength) ||
      !Number.isSafeInteger(glyphsOffset) ||
      !Number.isSafeInteger(glyphCellSize) ||
      memberStartRomOffset < 0 || memberLength < 0 ||
      glyphsOffset < 0 || glyphCellSize !== 48 ||
      memberStartRomOffset + memberLength > rom.byteLength ||
      glyphsOffset + (lastAscii - firstAscii + 1) * glyphCellSize > memberLength) {
    throw new Error('PRK41 font member/ASCII glyph bounds do not validate.')
  }
  const metrics = []
  const advanceDistribution: Record<string, number> = {}
  const nonzeroOffsetGlyphs: string[] = []
  const blankGlyphs: string[] = []
  let advanceWidthDifferences = 0
  let hash = 0x811c9dc5
  for (let cp = firstAscii; cp <= lastAscii; cp += 1) {
    const offset = memberStartRomOffset + glyphsOffset +
      (cp - firstAscii) * glyphCellSize
    const glyph = decodeWhite2PackedFontGlyph(rom, offset, 48, 12, 15)
    const character = String.fromCharCode(cp)
    const row = {
      codepoint: cp,
      character,
      x: glyph.x,
      width: glyph.width,
      advance: glyph.advance,
      inkPixels: glyph.source2bppCounts[1],
      shadowPixels: glyph.source2bppCounts[2],
    }
    metrics.push(row)
    advanceDistribution[String(row.advance)] =
      (advanceDistribution[String(row.advance)] ?? 0) + 1
    if (row.advance !== row.width) advanceWidthDifferences += 1
    if (row.x !== 0) nonzeroOffsetGlyphs.push(character)
    if (row.inkPixels + row.shadowPixels === 0) blankGlyphs.push(character)
    for (const value of [cp, row.x, row.width, row.advance, row.inkPixels, row.shadowPixels]) {
      hash ^= value & 0xff
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  const byCharacter = new Map(metrics.map(item => [item.character, item]))
  const sampleStrings = ['AB', 'A B', 'Wi il', '0?']
  const sampleText = sampleStrings.map(text => {
    let penX = 0
    const placements: number[] = []
    for (const character of text) {
      const metric = byCharacter.get(character)
      if (!metric) throw new Error('PRK41 sample contains non-ASCII glyph.')
      placements.push(penX + metric.x)
      penX += metric.advance
    }
    return { text, totalAdvance: penX, placements }
  })
  if (metrics.length !== 95 || byCharacter.get('A')?.advance !== 6 ||
      byCharacter.get('B')?.advance !== 6 ||
      byCharacter.get(' ')?.width !== 0 ||
      byCharacter.get(' ')?.advance !== 4) {
    throw new Error('PRK41 audited font conflicts with PRK35–40 verified characters.')
  }
  return {
    glyphCount: metrics.length,
    metrics,
    advanceDistribution,
    advanceWidthDifferences,
    nonzeroOffsetGlyphs,
    blankGlyphs,
    fontMetricsFnv1a32: '0x' + hash.toString(16).padStart(8, '0'),
    sampleText,
  }
}


/**
 * PRK42: read-only native-font line compositor for a 12x5 BG2 bitmap.
 *
 * In White 2's printsys.c the text pen starts at x; each glyph is copied
 * from its 12x15 2bpp cell at (penX + glyph.x, y) for glyph.width columns,
 * then the pen advances by glyph.advance. This function independently
 * simulates that pixel placement in a LOCAL Uint8Array of 60 4bpp DS tiles.
 *
 * No guest RAM writes, native calls, VRAM writes, or font streaming.
 */
export function simulateWhite2AsciiLine(
  rom: Uint8Array,
  memberStartRomOffset: number,
  memberLength: number,
  glyphsOffset: number,
  text: string,
): {
  text: string
  widthTiles: number
  heightTiles: number
  startPixel: { x: number; y: number }
  penAdvancePx: number
  placements: Array<{
    character: string
    codepoint: number
    penX: number
    xOffset: number
    drawX: number
    width: number
    advance: number
  }>
  inkPixels: number
  shadowPixels: number
  clippedPixels: number
  overlappingPixels: number
  dirtyTileIndices: number[]
  changedBytesByTile: Array<{ tileIndex: number; changedBytes: number }>
  outputFnv1a32: string
  asciiPreview: string[]
  tiles: Uint8Array
} {
  const widthTiles = 12
  const heightTiles = 5
  const widthPixels = widthTiles * 8
  const heightPixels = heightTiles * 8
  const startX = 8
  const startY = 8
  const glyphCellSize = 48
  const minCodepoint = 32
  const maxCodepoint = 126
  if (!Number.isSafeInteger(memberStartRomOffset) ||
      !Number.isSafeInteger(memberLength) || !Number.isSafeInteger(glyphsOffset) ||
      memberStartRomOffset < 0 || memberLength <= 0 || glyphsOffset < 0 ||
      memberStartRomOffset + memberLength > rom.byteLength ||
      glyphsOffset + (maxCodepoint - minCodepoint + 1) * glyphCellSize > memberLength ||
      text.length < 1 || text.length > 64) {
    throw new Error('PRK42 font archive or text bounds are invalid.')
  }

  const tiles = new Uint8Array(widthTiles * heightTiles * 32)
  tiles.fill(0xff)
  const placements = []
  let inkPixels = 0
  let shadowPixels = 0
  let clippedPixels = 0
  let overlappingPixels = 0
  let penX = startX

  for (const char of text) {
    const cp = char.codePointAt(0)
    if (cp === undefined || cp < minCodepoint || cp > maxCodepoint) {
      throw new Error('PRK42 refuses non-printable or non-ASCII font characters.')
    }
    const cellOffset = memberStartRomOffset + glyphsOffset +
      (cp - minCodepoint) * glyphCellSize
    const glyph = decodeWhite2PackedFontGlyph(rom, cellOffset, glyphCellSize, 12, 15)
    const drawX = penX + glyph.x
    placements.push({
      character: char,
      codepoint: cp,
      penX: penX - startX,
      xOffset: glyph.x,
      drawX: drawX - startX,
      width: glyph.width,
      advance: glyph.advance,
    })

    // This is the decompiled TextRenderer behavior: only the visible
    // glyph.width columns are blitted, not all 12 source-cell columns.
    for (let y = 0; y < 15; y += 1) {
      for (let x = 0; x < glyph.width; x += 1) {
        const pixel = glyph.asciiRows[y][x]
        const palette = pixel === '#' ? 1 : pixel === '+' ? 2 : 0
        if (!palette) continue
        const px = drawX + x
        const py = startY + y
        if (px < 0 || px >= widthPixels || py < 0 || py >= heightPixels) {
          clippedPixels += 1
          continue
        }
        const tileIndex = (py >> 3) * widthTiles + (px >> 3)
        const pixelInTile = (py & 7) * 8 + (px & 7)
        const byteIndex = tileIndex * 32 + (pixelInTile >> 1)
        const shift = (pixelInTile & 1) * 4
        const before = (tiles[byteIndex] >>> shift) & 0x0f
        if (before !== 15) overlappingPixels += 1
        tiles[byteIndex] =
          (tiles[byteIndex] & ~(0x0f << shift)) | (palette << shift)
        if (palette === 1) inkPixels += 1
        else shadowPixels += 1
      }
    }
    penX += glyph.advance
  }

  const dirtyTileIndices: number[] = []
  const changedBytesByTile: Array<{ tileIndex: number; changedBytes: number }> = []
  let hash = 0x811c9dc5
  for (let tile = 0; tile < widthTiles * heightTiles; tile += 1) {
    let changedBytes = 0
    for (let byte = 0; byte < 32; byte += 1) {
      const value = tiles[tile * 32 + byte]
      if (value !== 0xff) changedBytes += 1
      hash ^= value
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    if (changedBytes) {
      dirtyTileIndices.push(tile)
      changedBytesByTile.push({ tileIndex: tile, changedBytes })
    }
  }

  const readPalette = (x: number, y: number) => {
    const tile = (y >> 3) * widthTiles + (x >> 3)
    const bit = (y & 7) * 8 + (x & 7)
    const b = tiles[tile * 32 + (bit >> 1)]
    return (b >> ((bit & 1) * 4)) & 0x0f
  }
  const previewWidth = Math.min(widthPixels - startX, Math.max(penX - startX, 1) + 3)
  const asciiPreview = Array.from({ length: 15 }, (_, row) =>
    Array.from({ length: previewWidth }, (_, x) => {
      const index = readPalette(startX + x, startY + row)
      return index === 1 ? '#' : index === 2 ? '+' : index === 15 ? '.' : '?'
    }).join(''),
  )
  return {
    text, widthTiles, heightTiles,
    startPixel: { x: startX, y: startY },
    penAdvancePx: penX - startX,
    placements,
    inkPixels,
    shadowPixels,
    clippedPixels,
    overlappingPixels,
    dirtyTileIndices,
    changedBytesByTile,
    outputFnv1a32: '0x' + hash.toString(16).padStart(8, '0'),
    asciiPreview,
    tiles,
  }
}
