#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const EXPECTED_WHITE2_SHA256 = '54bec4091ba3eb89f4e1ee4e2f3421005835804376a34e5e45f3157e1f55625a'
const EXPECTED_GAME_CODE = 'IRDO'
const DEFAULT_OUTPUT_DIR = 'generated/white2'

function fail(message) {
  console.error(`\n[white2:extract] ${message}\n`)
  process.exit(1)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function ascii(bytes, start, length) {
  return Buffer.from(bytes.subarray(start, start + length))
    .toString('ascii')
    .replace(/\0+$/g, '')
}

function u16(view, offset) {
  return view.getUint16(offset, true)
}

function u32(view, offset) {
  return view.getUint32(offset, true)
}

function hex(value, width = 8) {
  return `0x${value.toString(16).toUpperCase().padStart(width, '0')}`
}

function safeSlice(bytes, start, end, label) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > bytes.length) {
    throw new Error(`${label} points outside the ROM (${hex(start)}..${hex(end)}, ROM ${hex(bytes.length)}).`)
  }
  return bytes.subarray(start, end)
}

function fileMagic(bytes) {
  if (bytes.length < 4) return ''
  const raw = ascii(bytes, 0, 4)
  return /^[\x20-\x7E]{4}$/.test(raw) ? raw : ''
}

function parseHeader(bytes) {
  if (bytes.length < 0x200) throw new Error('File is too small to be a Nintendo DS ROM.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const fntOffset = u32(view, 0x40)
  const fntSize = u32(view, 0x44)
  const fatOffset = u32(view, 0x48)
  const fatSize = u32(view, 0x4c)
  const arm9Offset = u32(view, 0x20)
  const arm9Entry = u32(view, 0x24)
  const arm9RamAddress = u32(view, 0x28)
  const arm9Size = u32(view, 0x2c)
  const arm7Offset = u32(view, 0x30)
  const arm7Entry = u32(view, 0x34)
  const arm7RamAddress = u32(view, 0x38)
  const arm7Size = u32(view, 0x3c)

  if (fatSize % 8 !== 0) throw new Error(`FAT size ${fatSize} is not divisible by 8.`)

  return {
    title: ascii(bytes, 0x00, 12),
    gameCode: ascii(bytes, 0x0c, 4),
    makerCode: ascii(bytes, 0x10, 2),
    unitCode: bytes[0x12],
    deviceType: bytes[0x13],
    deviceCapacity: bytes[0x14],
    romVersion: bytes[0x1e],
    internalFlags: bytes[0x1f],
    arm9: { offset: arm9Offset, entry: arm9Entry, ramAddress: arm9RamAddress, size: arm9Size },
    arm7: { offset: arm7Offset, entry: arm7Entry, ramAddress: arm7RamAddress, size: arm7Size },
    fnt: { offset: fntOffset, size: fntSize },
    fat: { offset: fatOffset, size: fatSize, fileCount: fatSize / 8 },
  }
}

function parseFat(bytes, header) {
  const { offset, size } = header.fat
  const fatBytes = safeSlice(bytes, offset, offset + size, 'FAT')
  const view = new DataView(fatBytes.buffer, fatBytes.byteOffset, fatBytes.byteLength)
  const entries = []
  for (let fileId = 0; fileId < size / 8; fileId += 1) {
    const start = u32(view, fileId * 8)
    const end = u32(view, fileId * 8 + 4)
    if (end < start || end > bytes.length) {
      throw new Error(`FAT file ${fileId} has invalid range ${hex(start)}..${hex(end)}.`)
    }
    entries.push({ fileId, start, end, size: end - start })
  }
  return entries
}

function parseFnt(bytes, header, fatEntries) {
  const fntBytes = safeSlice(bytes, header.fnt.offset, header.fnt.offset + header.fnt.size, 'FNT')
  const view = new DataView(fntBytes.buffer, fntBytes.byteOffset, fntBytes.byteLength)
  if (fntBytes.length < 8) throw new Error('FNT is too small.')

  // In NitroFS the root directory's parent field stores the number of directories.
  const directoryCount = u16(view, 6)
  if (directoryCount < 1 || directoryCount * 8 > fntBytes.length) {
    throw new Error(`FNT directory count ${directoryCount} is invalid.`)
  }

  const directories = []
  for (let index = 0; index < directoryCount; index += 1) {
    const base = index * 8
    directories.push({
      id: 0xf000 + index,
      subtableOffset: u32(view, base),
      firstFileId: u16(view, base + 4),
      parentId: u16(view, base + 6),
    })
  }

  const files = []
  const visited = new Set()

  function walk(directoryId, parentPath) {
    const directoryIndex = directoryId - 0xf000
    const directory = directories[directoryIndex]
    if (!directory) throw new Error(`FNT references unknown directory ${hex(directoryId, 4)}.`)
    const visitKey = `${directoryId}:${parentPath}`
    if (visited.has(visitKey)) return
    visited.add(visitKey)

    let cursor = directory.subtableOffset
    let fileId = directory.firstFileId
    if (cursor < 0 || cursor >= fntBytes.length) {
      throw new Error(`Directory ${hex(directoryId, 4)} subtable is outside FNT.`)
    }

    while (cursor < fntBytes.length) {
      const typeAndLength = fntBytes[cursor]
      cursor += 1
      if (typeAndLength === 0) break
      const isDirectory = (typeAndLength & 0x80) !== 0
      const nameLength = typeAndLength & 0x7f
      if (nameLength === 0 || cursor + nameLength > fntBytes.length) {
        throw new Error(`Directory ${hex(directoryId, 4)} contains an invalid FNT name entry.`)
      }
      const name = ascii(fntBytes, cursor, nameLength)
      cursor += nameLength

      if (isDirectory) {
        if (cursor + 2 > fntBytes.length) throw new Error('FNT directory entry is truncated.')
        const childId = u16(view, cursor)
        cursor += 2
        walk(childId, parentPath ? `${parentPath}/${name}` : name)
      } else {
        const fat = fatEntries[fileId]
        if (!fat) throw new Error(`FNT references file ID ${fileId}, which is outside the FAT.`)
        files.push({ ...fat, path: parentPath ? `${parentPath}/${name}` : name })
        fileId += 1
      }
    }
  }

  walk(0xf000, '')

  const namedIds = new Set(files.map(file => file.fileId))
  for (const fat of fatEntries) {
    if (!namedIds.has(fat.fileId)) files.push({ ...fat, path: `__unnamed__/file_${fat.fileId}` })
  }

  files.sort((a, b) => a.fileId - b.fileId)
  return { directories, files }
}

function parseNarc(fileBytes, archivePath) {
  if (fileBytes.length < 0x10 || ascii(fileBytes, 0, 4) !== 'NARC') return null
  const view = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength)
  const declaredSize = u32(view, 0x08)
  const headerSize = u16(view, 0x0c)
  const blockCount = u16(view, 0x0e)
  if (declaredSize > fileBytes.length || headerSize < 0x10 || headerSize > fileBytes.length) return null

  const blocks = []
  let cursor = headerSize
  for (let index = 0; index < blockCount; index += 1) {
    if (cursor + 8 > fileBytes.length) break
    const magic = ascii(fileBytes, cursor, 4)
    const size = u32(view, cursor + 4)
    if (size < 8 || cursor + size > fileBytes.length) break
    blocks.push({ index, magic, offset: cursor, size })
    cursor += size
  }

  const fatBlock = blocks.find(block => block.magic === 'BTAF' || block.magic === 'FATB')
  const imageBlock = blocks.find(block => block.magic === 'GMIF' || block.magic === 'FIMG')
  const members = []

  if (fatBlock && imageBlock && fatBlock.size >= 12) {
    const memberCount = u16(view, fatBlock.offset + 8)
    const entriesOffset = fatBlock.offset + 12
    const imageDataOffset = imageBlock.offset + 8
    for (let index = 0; index < memberCount; index += 1) {
      const entryOffset = entriesOffset + index * 8
      if (entryOffset + 8 > fatBlock.offset + fatBlock.size) break
      const start = u32(view, entryOffset)
      const end = u32(view, entryOffset + 4)
      const absoluteStart = imageDataOffset + start
      const absoluteEnd = imageDataOffset + end
      if (end < start || absoluteEnd > fileBytes.length) continue
      const member = fileBytes.subarray(absoluteStart, absoluteEnd)
      members.push({
        index,
        start,
        end,
        size: end - start,
        magic: fileMagic(member),
        sha256: sha256(member),
      })
    }
  }

  return {
    path: archivePath,
    byteOrderMark: hex(u16(view, 0x04), 4),
    version: hex(u16(view, 0x06), 4),
    declaredSize,
    headerSize,
    blockCount,
    blocks,
    memberCount: members.length,
    members,
  }
}

async function main() {
  const args = process.argv.slice(2)
  const romArg = args.find(arg => !arg.startsWith('--'))
  const outFlag = args.findIndex(arg => arg === '--out')
  const outputDir = outFlag >= 0 ? args[outFlag + 1] : DEFAULT_OUTPUT_DIR

  if (!romArg) {
    fail('Usage: npm run white2:extract -- /path/to/PokemonWhite2.nds [--out generated/white2]')
  }
  if (outFlag >= 0 && !outputDir) fail('--out requires a directory path.')

  const romPath = path.resolve(romArg)
  const outputPath = path.resolve(outputDir)
  console.log(`[white2:extract] Reading ${romPath}`)

  const romBuffer = await readFile(romPath).catch(error => {
    fail(`Could not read ROM: ${error instanceof Error ? error.message : String(error)}`)
  })
  const bytes = new Uint8Array(romBuffer.buffer, romBuffer.byteOffset, romBuffer.byteLength)
  const digest = sha256(bytes)
  const header = parseHeader(bytes)

  if (header.gameCode !== EXPECTED_GAME_CODE) {
    fail(`Expected White 2 game code ${EXPECTED_GAME_CODE}, found ${header.gameCode || '(blank)'}.`)
  }
  if (digest !== EXPECTED_WHITE2_SHA256) {
    fail(`ROM SHA-256 does not match PokéRun's tested White 2 dump.\nExpected: ${EXPECTED_WHITE2_SHA256}\nFound:    ${digest}`)
  }

  const fatEntries = parseFat(bytes, header)
  const { directories, files } = parseFnt(bytes, header, fatEntries)

  console.log(`[white2:extract] Verified ${header.title} (${header.gameCode})`)
  console.log(`[white2:extract] NitroFS: ${files.length} files, ${directories.length} directories`)

  const nitroFiles = []
  const narcs = []
  for (const file of files) {
    const fileBytes = safeSlice(bytes, file.start, file.end, `NitroFS file ${file.fileId}`)
    const magic = fileMagic(fileBytes)
    const narc = parseNarc(fileBytes, file.path)
    nitroFiles.push({
      ...file,
      offsetHex: hex(file.start),
      endHex: hex(file.end),
      magic,
      sha256: sha256(fileBytes),
      narcMembers: narc?.memberCount ?? null,
    })
    if (narc) narcs.push({ fileId: file.fileId, ...narc })
  }

  const romManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: path.basename(romPath),
    sha256: digest,
    expectedSha256: EXPECTED_WHITE2_SHA256,
    exactTestedRom: digest === EXPECTED_WHITE2_SHA256,
    size: bytes.length,
    header,
    nitroFs: {
      fileCount: nitroFiles.length,
      directoryCount: directories.length,
      narcCount: narcs.length,
    },
  }

  await mkdir(outputPath, { recursive: true })
  await Promise.all([
    writeFile(path.join(outputPath, 'rom.json'), `${JSON.stringify(romManifest, null, 2)}\n`),
    writeFile(path.join(outputPath, 'nitrofs.json'), `${JSON.stringify(nitroFiles, null, 2)}\n`),
    writeFile(path.join(outputPath, 'directories.json'), `${JSON.stringify(directories, null, 2)}\n`),
    writeFile(path.join(outputPath, 'narc-index.json'), `${JSON.stringify(narcs, null, 2)}\n`),
  ])

  console.log(`[white2:extract] NARC archives: ${narcs.length}`)
  console.log(`[white2:extract] Wrote knowledge inventory to ${outputPath}`)
  console.log('[white2:extract] Next target: label map/header/event/script archives and decode map transitions.')
}

main().catch(error => {
  fail(error instanceof Error ? error.stack ?? error.message : String(error))
})
