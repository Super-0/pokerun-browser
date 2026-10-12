import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const packageJsonPath = require.resolve('@thenick775/mgba-wasm/package.json')
const mgbaPath = join(dirname(packageJsonPath), 'dist', 'mgba.js')
const marker = 'POKERUN_HEAP_BRIDGE'

let source = await readFile(mgbaPath, 'utf8')

// Remove older PokéRun bridge blocks first. Older versions exposed HEAPU8 only,
// which can become detached when Emscripten replaces the WebAssembly.Memory
// buffer while the threaded runtime is starting.
const oldBridge = /\/\* POKERUN_HEAP_BRIDGE:[\s\S]*?\*\/\s*Object\.defineProperty\(Module,\s*['"]HEAPU8['"],\s*\{\s*configurable:\s*true,\s*get:\s*\(\)\s*=>\s*(?:HEAPU8|new Uint8Array\(wasmMemory\.buffer\))\s*\}\);?/g
source = source.replace(oldBridge, '')

// Emscripten emits updateMemoryViews() in both the main runtime and pthread
// workers. Bridge every HEAPU8 refresh so the Module returned to PokéRun keeps
// access to both the current typed-array view and the underlying memory object.
// Exposing wasmMemory is important because its .buffer can be refreshed after
// startup even when an older HEAPU8 view has been detached.
const heapAssignment = /\bHEAPU8\s*=\s*new\s+Uint8Array\s*\([^)]*\)/g
const heapMatches = [...source.matchAll(heapAssignment)]

if (heapMatches.length === 0) {
  throw new Error('[PokéRun] Could not locate any mGBA HEAPU8 initializers.')
}

let patchedCount = 0
source = source.replace(heapAssignment, match => {
  patchedCount += 1
  return `${match};\n/* ${marker}: expose the live Emscripten heap and memory object. */\nObject.defineProperty(Module, 'HEAPU8', { configurable: true, get: () => HEAPU8 });\nObject.defineProperty(Module, 'wasmMemory', { configurable: true, get: () => wasmMemory })`
})

await writeFile(mgbaPath, source, 'utf8')
console.log(`[PokéRun] Exposed mGBA HEAPU8 + wasmMemory in ${patchedCount} runtime context(s).`)
