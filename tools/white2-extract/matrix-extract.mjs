#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const EXPECTED_WHITE2_SHA256 = '54bec4091ba3eb89f4e1ee4e2f3421005835804376a34e5e45f3157e1f55625a'
const DEFAULT_OUTPUT_DIR = 'generated/white2'
const MATRIX_ARCHIVE_PATH = 'a/0/0/9'
const NONE = 0xffffffff

function fail(message) {
  console.error(`\n[white2:matrices] ${message}\n`)
  process.exit(1)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function dataView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function ascii(bytes, start, length) {
  return Buffer.from(bytes.subarray(start, start + length)).toString('ascii')
}

function u16(view, offset) {
  return view.getUint16(offset, true)
}

function u32(view, offset) {
  return view.getUint32(offset, true)
}

function parseCli(args) {
  let romPath = null
  let outputDir = DEFAULT_OUTPUT_DIR
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--out') {
      outputDir = args[index + 1]
      index += 1
      if (!outputDir) fail('--out requires a directory path.')
      continue
    }
    if (arg.startsWith('--')) fail(`Unknown option ${arg}.`)
    if (romPath) fail(`Unexpected extra argument ${arg}.`)
    romPath = arg
  }
  if (!romPath) fail('Usage: node tools/white2-extract/matrix-extract.mjs /path/to/PokemonWhite2.nds [--out generated/white2]')
  return { romPath, outputDir }
}

function readNarcMembers(fileBytes) {
  if (fileBytes.length < 0x10 || ascii(fileBytes, 0, 4) !== 'NARC') throw new Error('Map-matrix archive is not a NARC.')
  const view = dataView(fileBytes)
  const headerSize = u16(view, 0x0c)
  const blockCount = u16(view, 0x0e)
  let cursor = headerSize
  let fatBlock = null
  let imageBlock = null

  for (let index = 0; index < blockCount; index += 1) {
    if (cursor + 8 > fileBytes.length) throw new Error('NARC block header extends past archive.')
    const magic = ascii(fileBytes, cursor, 4)
    const size = u32(view, cursor + 4)
    if (size < 8 || cursor + size > fileBytes.length) throw new Error(`Invalid NARC block ${magic}.`)
    if (magic === 'BTAF' || magic === 'FATB') fatBlock = { offset: cursor, size }
    if (magic === 'GMIF' || magic === 'FIMG') imageBlock = { offset: cursor, size }
    cursor += size
  }

  if (!fatBlock || !imageBlock) throw new Error('Map-matrix NARC is missing FAT or image blocks.')
  const count = u16(view, fatBlock.offset + 8)
  const entriesOffset = fatBlock.offset + 12
  const imageDataOffset = imageBlock.offset + 8
  const members = []

  for (let index = 0; index < count; index += 1) {
    const entry = entriesOffset + index * 8
    if (entry + 8 > fatBlock.offset + fatBlock.size) throw new Error(`Matrix NARC FAT entry ${index} is truncated.`)
    const start = u32(view, entry)
    const end = u32(view, entry + 4)
    if (end < start || imageDataOffset + end > fileBytes.length) throw new Error(`Matrix NARC member ${index} has an invalid range.`)
    members.push(fileBytes.subarray(imageDataOffset + start, imageDataOffset + end))
  }
  return members
}

function rows(values, width) {
  const result = []
  for (let index = 0; index < values.length; index += width) result.push(values.slice(index, index + width))
  return result
}

function parseMatrix(bytes, matrixId) {
  if (bytes.length < 8) throw new Error(`Matrix ${matrixId} is smaller than its header.`)
  const view = dataView(bytes)
  const hasZonesRaw = u16(view, 0)
  const unknown = u16(view, 2)
  const width = u16(view, 4)
  const height = u16(view, 6)
  if (hasZonesRaw !== 0 && hasZonesRaw !== 1) throw new Error(`Matrix ${matrixId} has unexpected hasZones value ${hasZonesRaw}.`)
  if (unknown !== 0) throw new Error(`Matrix ${matrixId} has unexpected header value ${unknown}.`)
  if (!width || !height) throw new Error(`Matrix ${matrixId} has invalid size ${width}x${height}.`)

  const cellCount = width * height
  const expected = 8 + cellCount * 4 * (hasZonesRaw ? 2 : 1)
  if (bytes.length !== expected) throw new Error(`Matrix ${matrixId} is ${bytes.length} bytes; expected ${expected} for ${width}x${height}.`)

  const maps = []
  for (let index = 0; index < cellCount; index += 1) {
    const value = u32(view, 8 + index * 4)
    maps.push(value === NONE ? null : value)
  }

  let zones = null
  if (hasZonesRaw) {
    zones = []
    const zoneOffset = 8 + cellCount * 4
    for (let index = 0; index < cellCount; index += 1) {
      const value = u32(view, zoneOffset + index * 4)
      zones.push(value === NONE ? null : value)
    }
  }

  return {
    matrixId,
    width,
    height,
    hasZones: Boolean(hasZonesRaw),
    maps: rows(maps, width),
    zones: zones ? rows(zones, width) : null,
  }
}

function deriveBoundaries(matrices) {
  const boundaries = []
  const directions = [
    { dx: 1, dy: 0, direction: 'east', reverse: 'west' },
    { dx: 0, dy: 1, direction: 'south', reverse: 'north' },
  ]

  for (const matrix of matrices) {
    if (!matrix.zones) continue
    for (let y = 0; y < matrix.height; y += 1) {
      for (let x = 0; x < matrix.width; x += 1) {
        const sourceZoneId = matrix.zones[y][x]
        if (sourceZoneId === null) continue

        for (const edge of directions) {
          const nx = x + edge.dx
          const ny = y + edge.dy
          if (nx >= matrix.width || ny >= matrix.height) continue
          const destinationZoneId = matrix.zones[ny][nx]
          if (destinationZoneId === null || destinationZoneId === sourceZoneId) continue

          boundaries.push({
            matrixId: matrix.matrixId,
            source: {
              cellX: x,
              cellY: y,
              zoneId: sourceZoneId,
              mapModelId: matrix.maps[y][x],
              direction: edge.direction,
            },
            destination: {
              cellX: nx,
              cellY: ny,
              zoneId: destinationZoneId,
              mapModelId: matrix.maps[ny][nx],
              direction: edge.reverse,
            },
          })
        }
      }
    }
  }

  return boundaries
}

function summarizeZoneAdjacency(boundaries) {
  const byPair = new Map()
  for (const boundary of boundaries) {
    const a = boundary.source.zoneId
    const b = boundary.destination.zoneId
    const low = Math.min(a, b)
    const high = Math.max(a, b)
    const key = `${low}:${high}`
    let summary = byPair.get(key)
    if (!summary) {
      summary = { zoneA: low, zoneB: high, boundaryCount: 0, matrices: new Set(), edges: [] }
      byPair.set(key, summary)
    }
    summary.boundaryCount += 1
    summary.matrices.add(boundary.matrixId)
    summary.edges.push(boundary)
  }

  return [...byPair.values()]
    .map(summary => ({ ...summary, matrices: [...summary.matrices].sort((a, b) => a - b) }))
    .sort((a, b) => a.zoneA - b.zoneA || a.zoneB - b.zoneB)
}

async function main() {
  const { romPath: romArg, outputDir } = parseCli(process.argv.slice(2))
  const romPath = path.resolve(romArg)
  const outputPath = path.resolve(outputDir)

  const romBuffer = await readFile(romPath).catch(error => fail(`Could not read ROM: ${error instanceof Error ? error.message : String(error)}`))
  const romBytes = new Uint8Array(romBuffer.buffer, romBuffer.byteOffset, romBuffer.byteLength)
  const digest = sha256(romBytes)
  if (digest !== EXPECTED_WHITE2_SHA256) fail(`ROM SHA-256 does not match PokéRun's tested White 2 dump.\nExpected: ${EXPECTED_WHITE2_SHA256}\nFound:    ${digest}`)

  const nitroFiles = JSON.parse(await readFile(path.join(outputPath, 'nitrofs.json'), 'utf8').catch(error => fail(`Could not read prior NitroFS inventory. Run the main extraction pass first: ${error instanceof Error ? error.message : String(error)}`)))
  const matrixFile = nitroFiles.find(file => file.path === MATRIX_ARCHIVE_PATH)
  if (!matrixFile) fail(`NitroFS inventory does not contain ${MATRIX_ARCHIVE_PATH}.`)
  if (matrixFile.start < 0 || matrixFile.end > romBytes.length || matrixFile.end < matrixFile.start) fail('Map-matrix archive has an invalid ROM range.')

  const archive = romBytes.subarray(matrixFile.start, matrixFile.end)
  const members = readNarcMembers(archive)
  const matrices = members.map((member, matrixId) => parseMatrix(member, matrixId))
  const boundaries = deriveBoundaries(matrices)
  const adjacency = summarizeZoneAdjacency(boundaries)

  await Promise.all([
    writeFile(path.join(outputPath, 'map-matrices.json'), `${JSON.stringify(matrices, null, 2)}\n`),
    writeFile(path.join(outputPath, 'zone-boundaries.json'), `${JSON.stringify(boundaries, null, 2)}\n`),
    writeFile(path.join(outputPath, 'zone-adjacency.json'), `${JSON.stringify(adjacency, null, 2)}\n`),
  ])

  const manifestPath = path.join(outputPath, 'rom.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.decoded = {
    ...(manifest.decoded ?? {}),
    mapMatrices: matrices.length,
    matricesWithZones: matrices.filter(matrix => matrix.hasZones).length,
    seamlessZoneBoundaries: boundaries.length,
    adjacentZonePairs: adjacency.length,
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(`[white2:matrices] Decoded map matrices: ${matrices.length} (${matrices.filter(matrix => matrix.hasZones).length} include zone grids)`)
  console.log(`[white2:matrices] Seamless zone boundaries: ${boundaries.length}`)
  console.log(`[white2:matrices] Unique adjacent-zone pairs: ${adjacency.length}`)
  console.log(`[white2:matrices] Wrote map-matrices.json, zone-boundaries.json, and zone-adjacency.json`)
}

main().catch(error => fail(error instanceof Error ? error.stack ?? error.message : String(error)))
