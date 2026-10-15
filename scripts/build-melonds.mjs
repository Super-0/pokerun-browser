import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const source = resolve(root, 'third_party/ds-anywhere')
const patch = resolve(root, 'third_party/patches/0001-expose-arm9-bus-reads.patch')
const build = resolve(source, 'build-pokerun-wasm')
const output = resolve(root, 'public/emulators/melonds')
const expectedRevision = '53c7c6cb362560a9e362ae754a162f638fa3cd64'
const requiredRuntimeSymbols = ['writeArm9U8', 'writeArm9U16', 'writeArm9U32', 'pokerunRuntimeVersion']

function run(command, args, cwd = root) { execFileSync(command, args, { cwd, stdio: 'inherit' }) }
function containsAscii(buffer, text) { return buffer.indexOf(Buffer.from(text, 'utf8')) !== -1 }

if (!existsSync(resolve(source, '.git'))) throw new Error('Missing third_party/ds-anywhere. Run: git submodule update --init --recursive')
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
if (revision !== expectedRevision) throw new Error(`DS Anywhere must be pinned to ${expectedRevision}; found ${revision}.`)

// The patch is PokéRun-owned and can change while the pinned upstream revision stays fixed.
// Always restore tracked upstream files first so an older applied patch cannot block a newer one.
run('git', ['reset', '--hard', expectedRevision], source)
run('git', ['apply', '--check', patch], source)
run('git', ['apply', patch], source)

const patchedCpp = readFileSync(resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.cpp'), 'utf8')
for (const symbol of requiredRuntimeSymbols) {
  if (!patchedCpp.includes(`.function("${symbol}"`)) throw new Error(`PokéRun melonDS patch did not expose ${symbol} through Embind.`)
}

// Rebuild from scratch. We intentionally delete both the CMake directory and served output so
// an older JS/WASM pair cannot survive a patch/API change.
rmSync(build, { recursive: true, force: true })
rmSync(output, { recursive: true, force: true })
run('emcmake', ['cmake', '-S', 'wasmelonDS', '-B', build, '-DBUILD_QT_SDL=OFF', '-DENABLE_OGLRENDERER=OFF', '-DENABLE_GDBSTUB=OFF'], source)
run('cmake', ['--build', build, '--target', 'wasmemulator', '-j2'], source)

const builtJsPath = resolve(build, 'wasmemulator.js')
const builtWasmPath = resolve(build, 'wasmemulator.wasm')
const builtJs = readFileSync(builtJsPath)
const builtWasm = readFileSync(builtWasmPath)
for (const symbol of requiredRuntimeSymbols) {
  if (!containsAscii(builtJs, symbol) && !containsAscii(builtWasm, symbol)) {
    throw new Error(`Built melonDS runtime is missing required PokéRun export ${symbol}; refusing to publish stale WASM.`)
  }
}

mkdirSync(output, { recursive: true })
copyFileSync(builtJsPath, resolve(output, 'wasmemulator.js'))
copyFileSync(builtWasmPath, resolve(output, 'wasmemulator.wasm'))
console.log(`Built verified melonDS runtime into public/emulators/melonds/ with exports: ${requiredRuntimeSymbols.join(', ')}.`)
