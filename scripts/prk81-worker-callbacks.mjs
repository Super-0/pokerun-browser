import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// PRK81E: make the five native WebMelon events work on both Window and WorkerGlobalScope.
export function applyPrk81WorkerCallbacks(source) {
  const path = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.cpp')
  const current = readFileSync(path, 'utf8')
  const key = 'window.WebMelon._internal.events.'
  const hits = current.split(key).length - 1
  if (hits !== 5) throw new Error('PRK81E pinned callbacks mismatch: ' + hits)
  let next = current.replaceAll(key, 'globalThis.WebMelon._internal.events.')
  const before = 'return 0x50524B47;'
  if (next.split(before).length !== 2) throw new Error('PRK81E native stamp mismatch')
  next = next.replace(before, 'return 0x50524B48;')
  writeFileSync(path, next)
  console.log('[PokéRun] PRK81E worker-portable native events installed')
}
