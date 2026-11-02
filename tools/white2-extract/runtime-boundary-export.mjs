#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const DEFAULT_OUTPUT_DIR = 'generated/white2'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runtimeOutput = path.join(root, 'public/dev-generated/white2-boundary-trigger-index.json')

function fail(message) {
  console.error(`\n[white2:runtime-boundaries] ${message}\n`)
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
    }
  }
  return { outputDir }
}

function safeTrigger(trigger, zones) {
  const source = zones[trigger.sourceZoneId]
  const destination = zones[trigger.destinationZoneId]
  return Boolean(
    source
    && destination
    && source.matrix === trigger.matrixId
    && destination.matrix === trigger.matrixId
  )
}

function buildWarpAdjacency(warps) {
  const adjacency = new Map()
  for (const warp of warps) {
    const source = warp.sourceZoneId
    const destination = warp.destinationZoneId
    if (!Number.isInteger(source) || !Number.isInteger(destination) || source === destination) continue
    let destinations = adjacency.get(source)
    if (!destinations) {
      destinations = new Set()
      adjacency.set(source, destinations)
    }
    destinations.add(destination)
  }
  return adjacency
}

function hasWarp(adjacency, source, destination) {
  return adjacency.get(source)?.has(destination) ?? false
}

function intermediateWarpBridge(trigger, adjacency) {
  const source = trigger.sourceZoneId
  const destination = trigger.destinationZoneId
  const sourceWarps = adjacency.get(source)
  if (!sourceWarps) return null

  // Route gates/tunnels are represented differently from ordinary seamless
  // overworld edges: the matrix places route A beside route B, but normal play
  // enters a third zone G before reaching B. Require a reciprocal A <-> G <-> B
  // native-warp graph so an unrelated one-way/script warp cannot quarantine an
  // otherwise legitimate static boundary.
  for (const intermediate of sourceWarps) {
    if (intermediate === source || intermediate === destination) continue
    if (
      hasWarp(adjacency, intermediate, source)
      && hasWarp(adjacency, destination, intermediate)
      && hasWarp(adjacency, intermediate, destination)
    ) {
      return intermediate
    }
  }
  return null
}

function buildIndex(triggers, quarantined) {
  const byZone = {}
  for (const trigger of triggers) {
    const key = String(trigger.sourceZoneId)
    ;(byZone[key] ??= []).push(trigger)
  }

  const quarantinedByZone = {}
  for (const entry of quarantined) {
    const key = String(entry.sourceZoneId)
    ;(quarantinedByZone[key] ??= []).push(entry)
  }

  return {
    schemaVersion: 2,
    generatedFrom: 'verified White 2 ROM static matrix data plus native warp graph',
    safeOnly: true,
    traversableOnly: true,
    triggerCount: triggers.length,
    quarantinedCount: quarantined.length,
    byZone,
    quarantinedByZone,
  }
}

async function main() {
  const { outputDir } = parseCli(process.argv.slice(2))
  const outputPath = path.resolve(outputDir)
  const [triggers, zones, warps] = await Promise.all([
    readFile(path.join(outputPath, 'zone-boundary-triggers.json'), 'utf8').then(JSON.parse),
    readFile(path.join(outputPath, 'zones.json'), 'utf8').then(JSON.parse),
    readFile(path.join(outputPath, 'warps.json'), 'utf8').then(JSON.parse),
  ])

  const matrixSafe = triggers.filter(trigger => safeTrigger(trigger, zones))
  const matrixQuarantined = triggers
    .filter(trigger => !safeTrigger(trigger, zones))
    .map(trigger => ({
      sourceZoneId: trigger.sourceZoneId,
      destinationZoneId: trigger.destinationZoneId,
      direction: trigger.direction,
      matrixId: trigger.matrixId,
      reason: 'matrix-header-mismatch',
      intermediateZoneId: null,
    }))

  const adjacency = buildWarpAdjacency(warps)
  const traversable = []
  const gateQuarantined = []
  for (const trigger of matrixSafe) {
    const intermediateZoneId = intermediateWarpBridge(trigger, adjacency)
    if (intermediateZoneId === null) {
      traversable.push(trigger)
      continue
    }
    gateQuarantined.push({
      sourceZoneId: trigger.sourceZoneId,
      destinationZoneId: trigger.destinationZoneId,
      direction: trigger.direction,
      matrixId: trigger.matrixId,
      reason: 'intermediate-warp-bridge',
      intermediateZoneId,
    })
  }

  const quarantined = [...matrixQuarantined, ...gateQuarantined]
    .sort((a, b) =>
      a.sourceZoneId - b.sourceZoneId
      || a.destinationZoneId - b.destinationZoneId
      || a.direction.localeCompare(b.direction)
    )
  const index = buildIndex(traversable, quarantined)

  await mkdir(path.dirname(runtimeOutput), { recursive: true })
  await writeFile(runtimeOutput, `${JSON.stringify(index, null, 2)}\n`)

  console.log(`[white2:runtime-boundaries] Traversable directional triggers: ${traversable.length}`)
  console.log(`[white2:runtime-boundaries] Quarantined matrix/header triggers: ${matrixQuarantined.length}`)
  console.log(`[white2:runtime-boundaries] Quarantined gate/tunnel bridge triggers: ${gateQuarantined.length}`)
  console.log(`[white2:runtime-boundaries] Wrote ${path.relative(root, runtimeOutput)}`)
  if (quarantined.length) {
    console.log('[white2:runtime-boundaries] Quarantined boundaries:')
    console.log(JSON.stringify(quarantined, null, 2))
  }
}

main().catch(error => fail(error instanceof Error ? error.stack ?? error.message : String(error)))