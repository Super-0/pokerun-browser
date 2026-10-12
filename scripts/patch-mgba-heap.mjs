import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const packageJsonPath = require.resolve('@thenick775/mgba-wasm/package.json')
const mgbaPath = join(dirname(packageJsonPath), 'dist', 'mgba.js')
const workerMarker = 'POKERUN_HEAP_BRIDGE'
const mainMarker = 'POKERUN_MAIN_HEAP_BRIDGE'
const finalMarker = 'POKERUN_FINAL_HEAP_BRIDGE'

let source = await readFile(mgbaPath, 'utf8')

// Remove the oldest bridge that was injected beside Emscripten HEAPU8 setup.
// Those occurrences can belong to pthread worker bootstrap rather than the
// main Module returned to PokéRun.
const oldWorkerBridge = /\/\* POKERUN_HEAP_BRIDGE:[\s\S]*?\*\/\s*Object\.defineProperty\(Module,\s*['"]HEAPU8['"],\s*\{\s*configurable:\s*true,\s*get:\s*\(\)\s*=>\s*(?:HEAPU8|new Uint8Array\(wasmMemory\.buffer\))\s*\}\);?\s*(?:Object\.defineProperty\(Module,\s*['"]wasmMemory['"],\s*\{\s*configurable:\s*true,\s*get:\s*\(\)\s*=>\s*wasmMemory\s*\}\);?)?/g
source = source.replace(oldWorkerBridge, '')

// Remove the previous main bridge. It was injected near Module.loadGame, which
// executes before Emscripten finishes startup. Emscripten can subsequently
// normalize its Module API and remove those properties before mGBA is returned.
const oldMainMarkerIndex = source.indexOf(`/* ${mainMarker}:`)
if (oldMainMarkerIndex >= 0) {
  const loadGameIndex = source.indexOf('Module.loadGame=', oldMainMarkerIndex)
  if (loadGameIndex < 0) {
    throw new Error('[PokéRun] Found the old main heap bridge but could not locate Module.loadGame after it.')
  }
  source = source.slice(0, oldMainMarkerIndex) + source.slice(loadGameIndex)
}

// The final-return bridge is already in the only place that survives Emscripten
// startup, so no additional patching is needed.
if (source.includes(finalMarker)) {
  await writeFile(mgbaPath, source, 'utf8')
  console.log('[PokéRun] Final mGBA memory bridge is already installed.')
  process.exit(0)
}

// Install immediately before the mGBA factory returns Module. At this point
// createWasm() and run() have completed, so these properties cannot be stripped
// by later Emscripten initialization code.
const finalReturn = 'return Module}export default mGBA;'
const finalReturnIndex = source.lastIndexOf(finalReturn)

if (finalReturnIndex < 0) {
  throw new Error('[PokéRun] Could not locate the final mGBA Module return.')
}

const bridge = `/* ${finalMarker}: expose memory on the final Module returned by createMgba(). */
Object.defineProperty(Module, 'HEAPU8', {
  configurable: true,
  get: () => wasmMemory && wasmMemory.buffer ? new Uint8Array(wasmMemory.buffer) : undefined
});
Object.defineProperty(Module, 'wasmMemory', {
  configurable: true,
  get: () => wasmMemory
});
`

source = source.slice(0, finalReturnIndex) + bridge + source.slice(finalReturnIndex)

await writeFile(mgbaPath, source, 'utf8')
console.log(`[PokéRun] Installed final mGBA memory bridge (${finalMarker}); removed legacy ${workerMarker}/${mainMarker} bridges.`)
