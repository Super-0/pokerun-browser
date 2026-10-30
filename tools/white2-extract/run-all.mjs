#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)

for (const script of ['index.mjs', 'matrix-extract.mjs', 'boundary-trigger-extract.mjs', 'runtime-boundary-export.mjs']) {
  const result = spawnSync(process.execPath, [path.join(root, script), ...args], {
    stdio: 'inherit',
  })
  if (result.error) {
    console.error(`[white2:extract] Failed to launch ${script}:`, result.error)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}
