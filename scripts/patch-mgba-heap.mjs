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

const heapDeclaration = /\bvar\s+HEAP8\s*,\s*HEAPU8\b[^;]*;/
const match = source.match(heapDeclaration)

if (!match) {
  throw new Error(
    '[PokéRun] Could not locate the Emscripten heap declaration in @thenick775/mgba-wasm. ' +
    'The package layout may have changed.',
  )
}

const bridge = `${match[0]}\n/* ${marker}: expose the current Emscripten heap without copying it. */\nObject.defineProperty(Module, 'HEAPU8', { configurable: true, get: () => HEAPU8 });`
source = source.replace(heapDeclaration, bridge)

await writeFile(mgbaPath, source, 'utf8')
console.log('[PokéRun] Exposed mGBA HEAPU8 for live game-state reads.')
