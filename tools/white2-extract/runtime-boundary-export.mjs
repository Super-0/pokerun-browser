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

function buildIndex(triggers) {
  const byZone = {}
  for (const trigger of triggers) {
    const key = String(trigger.sourceZoneId)
    ;(byZone[key] ??= []).push(trigger)
  }
  return {
    schemaVersion: 1,
    generatedFrom: 'verified White 2 ROM static matrix data',
    safeOnly: true,
    triggerCount: triggers.length,
    byZone,
  }
}

async function main() {
  const { outputDir } = parseCli(process.argv.slice(2))
  const outputPath = path.resolve(outputDir)
  const [triggers, zones] = await Promise.all([
    readFile(path.join(outputPath, 'zone-boundary-triggers.json'), 'utf8').then(JSON.parse),
    readFile(path.join(outputPath, 'zones.json'), 'utf8').then(JSON.parse),
  ])

  const safe = triggers.filter(trigger => safeTrigger(trigger, zones))
  const quarantined = triggers.filter(trigger => !safeTrigger(trigger, zones))
  const index = buildIndex(safe)

  await mkdir(path.dirname(runtimeOutput), { recursive: true })
  await writeFile(runtimeOutput, `${JSON.stringify(index, null, 2)}\n`)

  console.log(`[white2:runtime-boundaries] Safe directional triggers: ${safe.length}`)
  console.log(`[white2:runtime-boundaries] Quarantined triggers: ${quarantined.length}`)
  console.log(`[white2:runtime-boundaries] Wrote ${path.relative(root, runtimeOutput)}`)
  if (quarantined.length) {
    console.log('[white2:runtime-boundaries] Quarantined pairs:')
    console.log(JSON.stringify(quarantined.map(trigger => ({
      sourceZoneId: trigger.sourceZoneId,
      destinationZoneId: trigger.destinationZoneId,
      matrixId: trigger.matrixId,
    })), null, 2))
  }
}

main().catch(error => fail(error instanceof Error ? error.stack ?? error.message : String(error)))
