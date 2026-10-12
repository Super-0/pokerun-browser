import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const packageJsonPath = require.resolve('@thenick775/mgba-wasm/package.json')
const mgbaPath = join(dirname(packageJsonPath), 'dist', 'mgba.js')
const marker = 'POKERUN_HEAP_BRIDGE'

let source = await readFile(mgbaPath, 'utf8')

// The generated Emscripten bundle contains separate memory-view setup code for
// the pthread worker and the main module. Patching only the first HEAPU8
// assignment can therefore expose memory in a worker while leaving the Module
// returned to PokéRun unchanged. Patch every unbridged HEAPU8 initializer.
const heapAssignment = /\bHEAPU8\s*=\s*new\s+Uint8Array\s*\([^)]*\)/g
const heapMatches = [...source.matchAll(heapAssignment)]
let patchedCount = 0

if (heapMatches.length > 0) {
  source = source.replace(heapAssignment, (match, offset) => {
    const followingSource = source.slice(offset + match.length, offset + match.length + 240)
    if (followingSource.includes(marker)) return match

    patchedCount += 1
    return `${match};\n/* ${marker}: expose the live Emscripten heap without copying it. */\nObject.defineProperty(Module, 'HEAPU8', { configurable: true, get: () => HEAPU8 })`
  })
} else {
  const wasmMemoryAssignment = /\bwasmMemory\s*=\s*new\s+WebAssembly\.Memory\s*\([^;]*\)/g
  const memoryMatches = [...source.matchAll(wasmMemoryAssignment)]

  if (memoryMatches.length === 0) {
    const heapMention = source.includes('HEAPU8')
      ? 'HEAPU8 exists, but its initializer was not recognized.'
      : 'HEAPU8 does not appear in the generated bundle.'
    throw new Error('[PokéRun] Could not locate an mGBA memory initializer. ' + heapMention)
  }

  source = source.replace(wasmMemoryAssignment, (match, offset) => {
    const followingSource = source.slice(offset + match.length, offset + match.length + 260)
    if (followingSource.includes(marker)) return match

    patchedCount += 1
    return `${match};\n/* ${marker}: expose the live Emscripten heap through wasmMemory. */\nObject.defineProperty(Module, 'HEAPU8', { configurable: true, get: () => new Uint8Array(wasmMemory.buffer) })`
  })
}

if (patchedCount === 0) {
  console.log('[PokéRun] All mGBA heap initializers are already bridged.')
  process.exit(0)
}

await writeFile(mgbaPath, source, 'utf8')
console.log(`[PokéRun] Exposed mGBA HEAPU8 in ${patchedCount} additional runtime context(s).`)
