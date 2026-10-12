import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const packageJsonPath = require.resolve('@thenick775/mgba-wasm/package.json')
const mgbaPath = join(dirname(packageJsonPath), 'dist', 'mgba.js')
const marker = 'POKERUN_HEAP_BRIDGE'

let source = await readFile(mgbaPath, 'utf8')

if (source.includes(marker)) {
  console.log('[PokéRun] mGBA heap bridge already installed.')
  process.exit(0)
}

const heapAssignment = /\bHEAPU8\s*=\s*new\s+Uint8Array\s*\([^)]*\)/
const heapMatch = source.match(heapAssignment)

if (heapMatch) {
  const bridge = `${heapMatch[0]}\n/* ${marker}: expose the live Emscripten heap without copying it. */\nObject.defineProperty(Module, 'HEAPU8', { configurable: true, get: () => HEAPU8 })`
  source = source.replace(heapAssignment, bridge)
} else {
  const wasmMemoryAssignment = /\bwasmMemory\s*=\s*new\s+WebAssembly\.Memory\s*\([^;]*\)/
  const memoryMatch = source.match(wasmMemoryAssignment)

  if (!memoryMatch) {
    const heapMention = source.includes('HEAPU8') ? 'HEAPU8 exists, but its initializer was not recognized.' : 'HEAPU8 does not appear in the generated bundle.'
    throw new Error(
      '[PokéRun] Could not locate an mGBA memory initializer. ' + heapMention,
    )
  }

  const bridge = `${memoryMatch[0]}\n/* ${marker}: expose the live Emscripten heap through wasmMemory. */\nObject.defineProperty(Module, 'HEAPU8', { configurable: true, get: () => new Uint8Array(wasmMemory.buffer) })`
  source = source.replace(wasmMemoryAssignment, bridge)
}

await writeFile(mgbaPath, source, 'utf8')
console.log('[PokéRun] Exposed mGBA HEAPU8 for live game-state reads.')
