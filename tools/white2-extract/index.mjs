#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const EXPECTED_WHITE2_SHA256 = '54bec4091ba3eb89f4e1ee4e2f3421005835804376a34e5e45f3157e1f55625a'
const EXPECTED_GAME_CODE = 'IRDO'
const DEFAULT_OUTPUT_DIR = 'generated/white2'

// Archive identities recovered by the current Black 2 / White 2 decompilation.
// PokéRun still parses the user's ROM directly; these labels only describe what
// the numbered NitroFS archives contain.
const KNOWN_ARCHIVES = {
  'a/0/0/8': 'map-models',
  'a/0/0/9': 'map-matrices',
  'a/0/1/2': 'zone-headers',
  'a/0/1/3': 'areas',
  'a/0/1/4': 'map-textures',
  'a/0/4/7': 'field-actor-data',
  'a/0/4/8': 'field-actor-graphics',
  'a/0/5/7': 'npc-caches',
  'a/0/8/5': 'town-map',
  'a/1/2/6': 'zone-events',
  'a/1/2/7': 'wild-encounters',
  'a/1/7/4': 'exterior-prop-textures',
  'a/1/7/5': 'interior-prop-textures',
  'a/2/0/8': 'walking-pokemon',
  'a/2/2/5': 'exterior-props',
  'a/2/2/6': 'interior-props',
}

const ZONE_HEADER_SIZE = 0x30
const BG_EVENT_SIZE = 20
const NPC_EVENT_SIZE = 36
const WARP_EVENT_SIZE = 20
const TRIGGER_EVENT_SIZE = 22
const NO_ZONE = 0xffff

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

function dataView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function u16(view, offset) {
  return view.getUint16(offset, true)
}

function i16(view, offset) {
  return view.getInt16(offset, true)
}

function u32(view, offset) {
  return view.getUint32(offset, true)
}

function i32(view, offset) {
  return view.getInt32(offset, true)
}

function hex(value, width = 8) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(width, '0')}`
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
  if (!romPath) fail('Usage: npm run white2:extract -- /path/to/PokemonWhite2.nds [--out generated/white2]')
  return { romPath, outputDir }
}

function parseHeader(bytes) {
  if (bytes.length < 0x200) throw new Error('File is too small to be a Nintendo DS ROM.')
  const view = dataView(bytes)
  const fntOffset = u32(view, 0x40)
  const fntSize = u32(view, 0x44)
  const fatOffset = u32(view, 0x48)
  const fatSize = u32(view, 0x4c)
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
    arm9: { offset: u32(view, 0x20), entry: u32(view, 0x24), ramAddress: u32(view, 0x28), size: u32(view, 0x2c) },
    arm7: { offset: u32(view, 0x30), entry: u32(view, 0x34), ramAddress: u32(view, 0x38), size: u32(view, 0x3c) },
    fnt: { offset: fntOffset, size: fntSize },
    fat: { offset: fatOffset, size: fatSize, fileCount: fatSize / 8 },
  }
}

function parseFat(bytes, header) {
  const { offset, size } = header.fat
  const fatBytes = safeSlice(bytes, offset, offset + size, 'FAT')
  const view = dataView(fatBytes)
  const entries = []
  for (let fileId = 0; fileId < size / 8; fileId += 1) {
    const start = u32(view, fileId * 8)
    const end = u32(view, fileId * 8 + 4)
    if (end < start || end > bytes.length) throw new Error(`FAT file ${fileId} has invalid range ${hex(start)}..${hex(end)}.`)
    entries.push({ fileId, start, end, size: end - start })
  }
  return entries
}

function parseFnt(bytes, header, fatEntries) {
  const fntBytes = safeSlice(bytes, header.fnt.offset, header.fnt.offset + header.fnt.size, 'FNT')
  const view = dataView(fntBytes)
  if (fntBytes.length < 8) throw new Error('FNT is too small.')

  const directoryCount = u16(view, 6)
  if (directoryCount < 1 || directoryCount * 8 > fntBytes.length) throw new Error(`FNT directory count ${directoryCount} is invalid.`)

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
    const directory = directories[directoryId - 0xf000]
    if (!directory) throw new Error(`FNT references unknown directory ${hex(directoryId, 4)}.`)
    const visitKey = `${directoryId}:${parentPath}`
    if (visited.has(visitKey)) return
    visited.add(visitKey)

    let cursor = directory.subtableOffset
    let fileId = directory.firstFileId
    if (cursor < 0 || cursor >= fntBytes.length) throw new Error(`Directory ${hex(directoryId, 4)} subtable is outside FNT.`)

    while (cursor < fntBytes.length) {
      const typeAndLength = fntBytes[cursor++]
      if (typeAndLength === 0) break
      const isDirectory = (typeAndLength & 0x80) !== 0
      const nameLength = typeAndLength & 0x7f
      if (nameLength === 0 || cursor + nameLength > fntBytes.length) throw new Error(`Directory ${hex(directoryId, 4)} contains an invalid FNT entry.`)
      const name = ascii(fntBytes, cursor, nameLength)
      cursor += nameLength

      if (isDirectory) {
        if (cursor + 2 > fntBytes.length) throw new Error('FNT directory entry is truncated.')
        const childId = u16(view, cursor)
        cursor += 2
        walk(childId, parentPath ? `${parentPath}/${name}` : name)
      } else {
        const fat = fatEntries[fileId]
        if (!fat) throw new Error(`FNT references file ID ${fileId}, outside the FAT.`)
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

function readNarc(fileBytes, archivePath) {
  if (fileBytes.length < 0x10 || ascii(fileBytes, 0, 4) !== 'NARC') return null
  const view = dataView(fileBytes)
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
      const bytes = fileBytes.subarray(absoluteStart, absoluteEnd)
      members.push({ index, start, end, size: end - start, magic: fileMagic(bytes), sha256: sha256(bytes), bytes })
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
    members,
  }
}

function narcJson(narc) {
  return {
    path: narc.path,
    byteOrderMark: narc.byteOrderMark,
    version: narc.version,
    declaredSize: narc.declaredSize,
    headerSize: narc.headerSize,
    blockCount: narc.blockCount,
    blocks: narc.blocks,
    memberCount: narc.members.length,
    members: narc.members.map(({ bytes: _bytes, ...member }) => member),
  }
}

function parseZoneHeaders(member) {
  if (!member || member.length % ZONE_HEADER_SIZE !== 0) throw new Error('Zone-header NARC member is not a multiple of 0x30 bytes.')
  const view = dataView(member)
  const zones = []
  for (let zoneId = 0; zoneId < member.length / ZONE_HEADER_SIZE; zoneId += 1) {
    const base = zoneId * ZONE_HEADER_SIZE
    const encountersRaw = u16(view, base + 0x14)
    const placeRaw = u16(view, base + 0x1a)
    const envRaw = u16(view, base + 0x1c)
    const flagsRaw = u16(view, base + 0x1e)
    const iconRaw = u16(view, base + 0x22)
    zones.push({
      zoneId,
      mapType: member[base],
      npcCache: member[base + 1],
      area: u16(view, base + 0x02),
      matrix: u16(view, base + 0x04),
      scripts: u16(view, base + 0x06),
      initScripts: u16(view, base + 0x08),
      text: u16(view, base + 0x0a),
      bgm: [u16(view, base + 0x0c), u16(view, base + 0x0e), u16(view, base + 0x10), u16(view, base + 0x12)],
      encounters: (encountersRaw & 0x1fff) === 0x1fff ? null : encountersRaw & 0x1fff,
      encounterSlot: encountersRaw >>> 13,
      entities: u16(view, base + 0x16),
      parent: u16(view, base + 0x18),
      place: placeRaw & 0x03ff,
      placeDisplay: placeRaw >>> 10,
      weather: envRaw & 0x3f,
      projection: (envRaw >>> 6) & 7,
      camera: envRaw >>> 9,
      transition: flagsRaw & 0x1f,
      battleBackground: (flagsRaw >>> 5) & 0x1f,
      permissions: {
        cycling: Boolean((flagsRaw >>> 10) & 1),
        flag11: Boolean((flagsRaw >>> 11) & 1),
        escapeRope: Boolean((flagsRaw >>> 12) & 1),
        flyFrom: Boolean((flagsRaw >>> 13) & 1),
        cycleSurfBgm: Boolean((flagsRaw >>> 14) & 1),
        entralinkWarp: Boolean((flagsRaw >>> 15) & 1),
      },
      cameraBoundary: u16(view, base + 0x20),
      nameIcon: iconRaw & 0x1fff,
      easyLevel: iconRaw >>> 13,
      fly: { x: i32(view, base + 0x24), y: i32(view, base + 0x28), z: i32(view, base + 0x2c) },
    })
  }
  return zones
}

function parseGridWarpPosition(view, offset) {
  return {
    kind: 'grid',
    x: u16(view, offset),
    y: u16(view, offset + 2),
    z: u16(view, offset + 4),
    width: u16(view, offset + 6),
    height: u16(view, offset + 8),
    parameter: u16(view, offset + 10),
  }
}

function parseRailWarpPosition(view, offset) {
  return {
    kind: 'rail',
    component: u16(view, offset),
    front: u16(view, offset + 2),
    side: i16(view, offset + 4),
    frontSpan: u16(view, offset + 6),
    sideSpan: u16(view, offset + 8),
    parameter: u16(view, offset + 10),
  }
}

function parseZoneEvents(member, zoneId, entityFile) {
  if (!member) return null
  if (member.length === 4 && member.every(byte => byte === 0)) {
    return { zoneId, entityFile, placeholder: true, counts: { bgEvents: 0, npcs: 0, warps: 0, triggers: 0 }, warps: [] }
  }
  if (member.length < 8) throw new Error(`Zone ${zoneId} entity file ${entityFile} is too small.`)

  const view = dataView(member)
  const initScriptsOffset = u32(view, 0)
  const counts = { bgEvents: member[4], npcs: member[5], warps: member[6], triggers: member[7] }
  let cursor = 8 + counts.bgEvents * BG_EVENT_SIZE + counts.npcs * NPC_EVENT_SIZE
  const warps = []

  for (let warpIndex = 0; warpIndex < counts.warps; warpIndex += 1) {
    if (cursor + WARP_EVENT_SIZE > member.length) throw new Error(`Zone ${zoneId} warp ${warpIndex} extends past its entity file.`)
    const destinationZoneId = u16(view, cursor)
    const destinationWarpIndex = u16(view, cursor + 2)
    const unknown4 = member[cursor + 4]
    const transition = member[cursor + 5]
    const isRail = u16(view, cursor + 6) !== 0
    const position = isRail ? parseRailWarpPosition(view, cursor + 8) : parseGridWarpPosition(view, cursor + 8)
    warps.push({
      sourceZoneId: zoneId,
      sourceEntityFile: entityFile,
      sourceWarpIndex: warpIndex,
      destinationZoneId: destinationZoneId === NO_ZONE ? null : destinationZoneId,
      destinationWarpIndex,
      transition,
      unknown4,
      position,
    })
    cursor += WARP_EVENT_SIZE
  }

  cursor += counts.triggers * TRIGGER_EVENT_SIZE
  if (cursor > member.length) throw new Error(`Zone ${zoneId} event tables extend past entity file ${entityFile}.`)

  return { zoneId, entityFile, placeholder: false, initScriptsOffset, counts, warps }
}

function resolveWarpGraph(eventsByZone) {
  const flat = []
  for (const events of eventsByZone.values()) {
    for (const warp of events.warps) {
      const destinationEvents = warp.destinationZoneId === null ? null : eventsByZone.get(warp.destinationZoneId)
      const arrival = destinationEvents?.warps?.[warp.destinationWarpIndex] ?? null
      flat.push({
        ...warp,
        destinationPosition: arrival?.position ?? null,
        destinationTransition: arrival?.transition ?? null,
        resolved: Boolean(arrival),
      })
    }
  }
  return flat.sort((a, b) => a.sourceZoneId - b.sourceZoneId || a.sourceWarpIndex - b.sourceWarpIndex)
}

function getNitroFileBytes(romBytes, filesByPath, wantedPath) {
  const file = filesByPath.get(wantedPath)
  if (!file) throw new Error(`Required NitroFS archive ${wantedPath} was not found.`)
  return safeSlice(romBytes, file.start, file.end, wantedPath)
}

async function main() {
  const { romPath: romArg, outputDir } = parseCli(process.argv.slice(2))
  const romPath = path.resolve(romArg)
  const outputPath = path.resolve(outputDir)
  console.log(`[white2:extract] Reading ${romPath}`)

  const romBuffer = await readFile(romPath).catch(error => fail(`Could not read ROM: ${error instanceof Error ? error.message : String(error)}`))
  const bytes = new Uint8Array(romBuffer.buffer, romBuffer.byteOffset, romBuffer.byteLength)
  const digest = sha256(bytes)
  const header = parseHeader(bytes)

  if (header.gameCode !== EXPECTED_GAME_CODE) fail(`Expected White 2 game code ${EXPECTED_GAME_CODE}, found ${header.gameCode || '(blank)'}.`)
  if (digest !== EXPECTED_WHITE2_SHA256) {
    fail(`ROM SHA-256 does not match PokéRun's tested White 2 dump.\nExpected: ${EXPECTED_WHITE2_SHA256}\nFound:    ${digest}`)
  }

  const fatEntries = parseFat(bytes, header)
  const { directories, files } = parseFnt(bytes, header, fatEntries)
  const filesByPath = new Map(files.map(file => [file.path, file]))

  console.log(`[white2:extract] Verified ${header.title} (${header.gameCode})`)
  console.log(`[white2:extract] NitroFS: ${files.length} files, ${directories.length} directories`)

  const nitroFiles = []
  const narcs = []
  for (const file of files) {
    const fileBytes = safeSlice(bytes, file.start, file.end, `NitroFS file ${file.fileId}`)
    const narc = readNarc(fileBytes, file.path)
    nitroFiles.push({
      ...file,
      offsetHex: hex(file.start),
      endHex: hex(file.end),
      magic: fileMagic(fileBytes),
      sha256: sha256(fileBytes),
      knowledgeRole: KNOWN_ARCHIVES[file.path] ?? null,
      narcMembers: narc?.members.length ?? null,
    })
    if (narc) narcs.push({ fileId: file.fileId, knowledgeRole: KNOWN_ARCHIVES[file.path] ?? null, ...narcJson(narc) })
  }

  const zoneNarc = readNarc(getNitroFileBytes(bytes, filesByPath, 'a/0/1/2'), 'a/0/1/2')
  if (!zoneNarc || zoneNarc.members.length !== 1) throw new Error('Expected a/0/1/2 to be a one-member NARC of zone headers.')
  const zones = parseZoneHeaders(zoneNarc.members[0].bytes)

  const eventNarc = readNarc(getNitroFileBytes(bytes, filesByPath, 'a/1/2/6'), 'a/1/2/6')
  if (!eventNarc) throw new Error('Expected a/1/2/6 to be the zone-events NARC.')

  const eventsByZone = new Map()
  const eventSummaries = []
  for (const zone of zones) {
    const member = eventNarc.members[zone.entities]?.bytes
    if (!member) throw new Error(`Zone ${zone.zoneId} references missing entity file ${zone.entities}.`)
    const parsed = parseZoneEvents(member, zone.zoneId, zone.entities)
    eventsByZone.set(zone.zoneId, parsed)
    eventSummaries.push({
      zoneId: zone.zoneId,
      entityFile: zone.entities,
      placeholder: parsed.placeholder,
      counts: parsed.counts,
      initScriptsOffset: parsed.initScriptsOffset ?? null,
    })
  }

  const warps = resolveWarpGraph(eventsByZone)
  const zonesWithCounts = zones.map(zone => ({
    ...zone,
    eventCounts: eventsByZone.get(zone.zoneId)?.counts ?? null,
  }))

  const anchorWarps = warps.filter(warp =>
    (warp.sourceZoneId === 427 && warp.destinationZoneId === 428)
    || (warp.sourceZoneId === 428 && warp.destinationZoneId === 427)
  )

  const romManifest = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    source: path.basename(romPath),
    sha256: digest,
    expectedSha256: EXPECTED_WHITE2_SHA256,
    exactTestedRom: true,
    size: bytes.length,
    header,
    nitroFs: { fileCount: nitroFiles.length, directoryCount: directories.length, narcCount: narcs.length },
    decoded: {
      zoneHeaders: zones.length,
      entityFiles: eventNarc.members.length,
      warps: warps.length,
      resolvedWarps: warps.filter(warp => warp.resolved).length,
    },
    validationAnchors: {
      zone427To428OrReverse: anchorWarps,
    },
  }

  await mkdir(outputPath, { recursive: true })
  await Promise.all([
    writeFile(path.join(outputPath, 'rom.json'), `${JSON.stringify(romManifest, null, 2)}\n`),
    writeFile(path.join(outputPath, 'nitrofs.json'), `${JSON.stringify(nitroFiles, null, 2)}\n`),
    writeFile(path.join(outputPath, 'directories.json'), `${JSON.stringify(directories, null, 2)}\n`),
    writeFile(path.join(outputPath, 'narc-index.json'), `${JSON.stringify(narcs, null, 2)}\n`),
    writeFile(path.join(outputPath, 'zones.json'), `${JSON.stringify(zonesWithCounts, null, 2)}\n`),
    writeFile(path.join(outputPath, 'events-index.json'), `${JSON.stringify(eventSummaries, null, 2)}\n`),
    writeFile(path.join(outputPath, 'warps.json'), `${JSON.stringify(warps, null, 2)}\n`),
  ])

  console.log(`[white2:extract] NARC archives: ${narcs.length}`)
  console.log(`[white2:extract] Decoded zones: ${zones.length}`)
  console.log(`[white2:extract] Native warps: ${warps.length} (${warps.filter(warp => warp.resolved).length} destination positions resolved)`)
  console.log(`[white2:extract] 427 ↔ 428 anchor records: ${anchorWarps.length}`)
  if (anchorWarps.length) console.log(JSON.stringify(anchorWarps, null, 2))
  console.log(`[white2:extract] Wrote knowledge inventory to ${outputPath}`)
  console.log('[white2:extract] Next static-navigation target: decode a/0/0/9 map matrices for seamless route/town boundaries.')
}

main().catch(error => fail(error instanceof Error ? error.stack ?? error.message : String(error)))
