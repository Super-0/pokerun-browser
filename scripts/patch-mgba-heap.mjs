import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const packageJsonPath = require.resolve('@thenick775/mgba-wasm/package.json')
const mgbaPath = join(dirname(packageJsonPath), 'dist', 'mgba.js')
const workerMarker = 'POKERUN_HEAP_BRIDGE'
const mainMarker = 'POKERUN_MAIN_HEAP_BRIDGE'

let source = await readFile(mgbaPath, 'utf8')

// Remove the older bridge that was injected next to Emscripten's HEAPU8 setup.
// In this package that code can belong to pthread worker bootstrap rather than
// the Module object returned to PokéRun, so it did not give the app a stable
// memory handle.
const oldBridge = /\/\* POKERUN_HEAP_BRIDGE:[\s\S]*?\*\/\s*Object\.defineProperty\(Module,\s*['"]HEAPU8['"],\s*\{\s*configurable:\s*true,\s*get:\s*\(\)\s*=>\s*(?:HEAPU8|new Uint8Array\(wasmMemory\.buffer\))\s*\}\);?\s*(?:Object\.defineProperty\(Module,\s*['"]wasmMemory['"],\s*\{\s*configurable:\s*true,\s*get:\s*\(\)\s*=>\s*wasmMemory\s*\}\);?)?/g
source = source.replace(oldBridge, '')

// If the main-module bridge is already present, the script has done its job.
if (source.includes(mainMarker)) {
  await writeFile(mgbaPath, source, 'utf8')
  console.log('[PokéRun] Main mGBA memory bridge is already installed.')
  process.exit(0)
}

// pre.js attaches public APIs such as Module.loadGame directly to the Module
// returned by createMgba(). Injecting next to that API guarantees these accessors
// live on the same object PokéRun receives instead of a pthread worker Module.
const mainModuleAnchor = /Module\.loadGame\s*=\s*\(/
const anchorMatch = source.match(mainModuleAnchor)

if (!anchorMatch) {
  throw new Error('[PokéRun] Could not locate the main mGBA Module API anchor.')
}

const bridge = `/* ${mainMarker}: expose memory on the Module returned by createMgba(). */
Object.defineProperty(Module, 'HEAPU8', {
  configurable: true,
  get: () => wasmMemory && wasmMemory.buffer ? new Uint8Array(wasmMemory.buffer) : undefined
});
Object.defineProperty(Module, 'wasmMemory', {
  configurable: true,
  get: () => wasmMemory
});
`

source = source.replace(mainModuleAnchor, `${bridge}${anchorMatch[0]}`)

await writeFile(mgbaPath, source, 'utf8')
console.log(`[PokéRun] Installed main mGBA memory bridge (${mainMarker}); removed legacy ${workerMarker} bridges.`)
