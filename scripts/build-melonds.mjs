import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const source = resolve(root, 'third_party/ds-anywhere')
const patches = [
  resolve(root, 'third_party/patches/0001-expose-arm9-bus-reads.patch'),
  resolve(root, 'third_party/patches/0002-real-hidden-fast-forward-frames.patch'),
]
const build = resolve(source, 'build-pokerun-wasm')
const output = resolve(root, 'public/emulators/melonds')
const expectedRevision = '53c7c6cb362560a9e362ae754a162f638fa3cd64'
const requiredRuntimeSymbols = [
  'writeArm9U8', 'writeArm9U16', 'writeArm9U32',
  'getArm9Sp', 'callArm9Thumb4', 'arm9CallStatus',
  'arm9CallPc', 'arm9CallLr', 'arm9CallCpsr', 'arm9CallInstructions',
  'pokerunRuntimeVersion',
]

function run(command, args, cwd = root) { execFileSync(command, args, { cwd, stdio: 'inherit' }) }
function containsAscii(buffer, text) { return buffer.indexOf(Buffer.from(text, 'utf8')) !== -1 }

function restorePinnedSource() {
  try {
    execFileSync('git', ['reset', '--hard', expectedRevision], { cwd: source, stdio: 'inherit' })
  } catch (error) {
    console.warn('[PokéRun] Could not restore the pinned ds-anywhere source after the build.', error)
  }
  rmSync(build, { recursive: true, force: true })
}

if (!existsSync(resolve(source, '.git'))) throw new Error('Missing third_party/ds-anywhere. Run: git submodule update --init --recursive')
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
if (revision !== expectedRevision) throw new Error(`DS Anywhere must be pinned to ${expectedRevision}; found ${revision}.`)

let published = false
try {
  // PokéRun-owned patches can change while the pinned upstream revision stays fixed.
  // Always restore tracked upstream files first so an older applied patch cannot block a newer one.
  run('git', ['reset', '--hard', expectedRevision], source)
  // --recount makes the build resilient to stale unified-diff hunk counts when a
  // PokéRun-owned patch is edited by hand; git still validates the actual context.
  for (const patch of patches) {
    run('git', ['apply', '--recount', '--check', patch], source)
    run('git', ['apply', '--recount', patch], source)
  }

  // Apply build requirements after restoring and patching upstream.
  const wasmCmake = resolve(source, 'wasmelonDS/src/frontend/wasm/CMakeLists.txt')
  writeFileSync(wasmCmake, readFileSync(wasmCmake, 'utf8') +
    '\ntarget_compile_features(wasmemulator PRIVATE cxx_std_20)\n')

  const patchedCpp = readFileSync(resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.cpp'), 'utf8')
  for (const symbol of requiredRuntimeSymbols) {
    if (!patchedCpp.includes(`.function("${symbol}"`)) throw new Error(`PokéRun melonDS patch did not expose ${symbol} through Embind.`)
  }

  // Rebuild from scratch, but keep the last served runtime in place until the new
  // JS/WASM pair has compiled and passed export verification. A compiler failure
  // should not turn into a confusing browser-side 404 on the next launch.
  rmSync(build, { recursive: true, force: true })
  run('emcmake', ['cmake', '-S', 'wasmelonDS', '-B', build, '-DBUILD_QT_SDL=OFF', '-DENABLE_OGLRENDERER=OFF', '-DENABLE_GDBSTUB=OFF',
    '-DCMAKE_C_FLAGS=-pthread',
    '-DCMAKE_CXX_FLAGS=-pthread',
    '-DCMAKE_EXE_LINKER_FLAGS=-pthread'], source)
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

  // Publish only after the candidate runtime is known-good so wasmemulator.js and
  // wasmemulator.wasm are always replaced as a verified pair.
  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
  copyFileSync(builtJsPath, resolve(output, 'wasmemulator.js'))
  copyFileSync(builtWasmPath, resolve(output, 'wasmemulator.wasm'))
  published = true
} finally {
  // ds-anywhere is a pinned third-party source tree. The patches above are the
  // canonical PokéRun changes, so never leave generated or applied build state
  // behind in the submodule after a build attempt.
  restorePinnedSource()
}

if (published) {
  console.log(`Built verified melonDS runtime into public/emulators/melonds/ with exports: ${requiredRuntimeSymbols.join(', ')}.`)
}
