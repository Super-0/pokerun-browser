#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const DEFAULT_OUTPUT_DIR = 'generated/white2'
const TILES_PER_MATRIX_CELL = 32

function fail(message) {
  console.error(`\n[white2:boundaries] ${message}\n`)
  process.exit(1)
}

function parseCli(args) {
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
    // run-all passes the ROM path through to every extraction stage. This stage
    // only consumes the already-generated matrix/zone JSON, so the positional
    // ROM argument is intentionally ignored.
  }
  return { outputDir }
}

function tileRangeForCell(cell) {
  return {
    xStart: cell.cellX * TILES_PER_MATRIX_CELL,
    xEnd: cell.cellX * TILES_PER_MATRIX_CELL + TILES_PER_MATRIX_CELL - 1,
    yStart: cell.cellY * TILES_PER_MATRIX_CELL,
    yEnd: cell.cellY * TILES_PER_MATRIX_CELL + TILES_PER_MATRIX_CELL - 1,
  }
}

function directionalTrigger(matrixId, source, destination, direction, sourceRange, destinationRange) {
  const base = {
    matrixId,
    sourceZoneId: source.zoneId,
    destinationZoneId: destination.zoneId,
    direction,
    sourceCell: {
      cellX: source.cellX,
      cellY: source.cellY,
      mapModelId: source.mapModelId,
    },
    destinationCell: {
      cellX: destination.cellX,
      cellY: destination.cellY,
      mapModelId: destination.mapModelId,
    },
    sourceTileRange: sourceRange,
    destinationTileRange: destinationRange,
  }

  if (direction === 'east') {
    return {
      ...base,
      sourceEdge: {
        fixedAxis: 'x',
        fixedCoordinate: sourceRange.xEnd,
        spanAxis: 'y',
        spanStart: sourceRange.yStart,
        spanEnd: sourceRange.yEnd,
      },
      destinationEntry: {
        fixedAxis: 'x',
        fixedCoordinate: destinationRange.xStart,
      },
      step: { x: 1, y: 0 },
    }
  }

  if (direction === 'west') {
    return {
      ...base,
      sourceEdge: {
        fixedAxis: 'x',
        fixedCoordinate: sourceRange.xStart,
        spanAxis: 'y',
        spanStart: sourceRange.yStart,
        spanEnd: sourceRange.yEnd,
      },
      destinationEntry: {
        fixedAxis: 'x',
        fixedCoordinate: destinationRange.xEnd,
      },
      step: { x: -1, y: 0 },
    }
  }

  if (direction === 'south') {
    return {
      ...base,
      sourceEdge: {
        fixedAxis: 'y',
        fixedCoordinate: sourceRange.yEnd,
        spanAxis: 'x',
        spanStart: sourceRange.xStart,
        spanEnd: sourceRange.xEnd,
      },
      destinationEntry: {
        fixedAxis: 'y',
        fixedCoordinate: destinationRange.yStart,
      },
      step: { x: 0, y: 1 },
    }
  }

  if (direction === 'north') {
    return {
      ...base,
      sourceEdge: {
        fixedAxis: 'y',
        fixedCoordinate: sourceRange.yStart,
        spanAxis: 'x',
        spanStart: sourceRange.xStart,
        spanEnd: sourceRange.xEnd,
      },
      destinationEntry: {
        fixedAxis: 'y',
        fixedCoordinate: destinationRange.yEnd,
      },
      step: { x: 0, y: -1 },
    }
  }

  throw new Error(`Unsupported boundary direction ${direction}.`)
}

function deriveTriggers(boundaries) {
  const triggers = []

  for (const boundary of boundaries) {
    const sourceRange = tileRangeForCell(boundary.source)
    const destinationRange = tileRangeForCell(boundary.destination)

    triggers.push(directionalTrigger(
      boundary.matrixId,
      boundary.source,
      boundary.destination,
      boundary.source.direction,
      sourceRange,
      destinationRange,
    ))

    triggers.push(directionalTrigger(
      boundary.matrixId,
      boundary.destination,
      boundary.source,
      boundary.destination.direction,
      destinationRange,
      sourceRange,
    ))
  }

  return triggers.sort((a, b) =>
    a.sourceZoneId - b.sourceZoneId
    || a.destinationZoneId - b.destinationZoneId
    || a.direction.localeCompare(b.direction)
    || a.sourceEdge.fixedCoordinate - b.sourceEdge.fixedCoordinate
    || a.sourceEdge.spanStart - b.sourceEdge.spanStart
  )
}

function validateHeaderMatrices(triggers, zones) {
  const warnings = []
  for (const trigger of triggers) {
    const source = zones[trigger.sourceZoneId]
    const destination = zones[trigger.destinationZoneId]
    if (!source || !destination) {
      warnings.push({
        kind: 'missing-zone-header',
        sourceZoneId: trigger.sourceZoneId,
        destinationZoneId: trigger.destinationZoneId,
      })
      continue
    }

    if (source.matrix !== trigger.matrixId || destination.matrix !== trigger.matrixId) {
      warnings.push({
        kind: 'matrix-mismatch',
        matrixId: trigger.matrixId,
        sourceZoneId: trigger.sourceZoneId,
        sourceHeaderMatrixId: source.matrix,
        destinationZoneId: trigger.destinationZoneId,
        destinationHeaderMatrixId: destination.matrix,
      })
    }
  }
  return warnings
}

function buildIndex(triggers) {
  const byZone = {}
  for (const trigger of triggers) {
    const key = String(trigger.sourceZoneId)
    ;(byZone[key] ??= []).push(trigger)
  }
  return {
    schemaVersion: 1,
    coordinateSystem: {
      livePositionUnit: 'tile',
      tilesPerMatrixCell: TILES_PER_MATRIX_CELL,
      matrixCellFormula: 'floor(tileCoordinate / 32)',
      worldFx32Formula: 'tileCoordinate * 16 * 0x1000 + tileCenterOffset',
    },
    byZone,
  }
}

async function main() {
  const { outputDir } = parseCli(process.argv.slice(2))
  const outputPath = path.resolve(outputDir)

  const [boundaries, zones] = await Promise.all([
    readFile(path.join(outputPath, 'zone-boundaries.json'), 'utf8')
      .then(JSON.parse)
      .catch(error => fail(`Could not read zone-boundaries.json. Run the matrix extraction first: ${error instanceof Error ? error.message : String(error)}`)),
    readFile(path.join(outputPath, 'zones.json'), 'utf8')
      .then(JSON.parse)
      .catch(error => fail(`Could not read zones.json. Run the main extraction first: ${error instanceof Error ? error.message : String(error)}`)),
  ])

  const triggers = deriveTriggers(boundaries)
  const warnings = validateHeaderMatrices(triggers, zones)
  const index = buildIndex(triggers)

  await Promise.all([
    writeFile(path.join(outputPath, 'zone-boundary-triggers.json'), `${JSON.stringify(triggers, null, 2)}\n`),
    writeFile(path.join(outputPath, 'zone-boundary-trigger-index.json'), `${JSON.stringify(index, null, 2)}\n`),
  ])

  const manifestPath = path.join(outputPath, 'rom.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.decoded = {
    ...(manifest.decoded ?? {}),
    directionalBoundaryTriggers: triggers.length,
    boundaryTriggerValidationWarnings: warnings.length,
  }
  manifest.coordinateSystems = {
    ...(manifest.coordinateSystems ?? {}),
    overworldMatrix: {
      tilesPerCell: TILES_PER_MATRIX_CELL,
      matrixCellFormula: 'floor(tileCoordinate / 32)',
      source: 'GetChunkCoordOfWorld: ((coordinate / 0x1000) / 16) / 32',
    },
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(`[white2:boundaries] Directional tile-edge triggers: ${triggers.length}`)
  console.log(`[white2:boundaries] Zone/header matrix validation warnings: ${warnings.length}`)
  console.log('[white2:boundaries] Wrote zone-boundary-triggers.json and zone-boundary-trigger-index.json')

  if (warnings.length) {
    console.log('[white2:boundaries] First validation warnings:')
    console.log(JSON.stringify(warnings.slice(0, 10), null, 2))
  }
}

main().catch(error => fail(error instanceof Error ? error.stack ?? error.message : String(error)))
