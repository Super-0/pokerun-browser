import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const source = resolve(root, 'third_party/ds-anywhere')
const patches = [
  resolve(root, 'third_party/patches/0001-expose-arm9-bus-reads.patch'),
  resolve(root, 'third_party/patches/0002-real-hidden-fast-forward-frames.patch'),
  resolve(root, 'third_party/patches/0003-raise-arm9-native-call-budget.patch'),
  resolve(root, 'third_party/patches/0004-scheduler-aware-arm9-native-calls.patch'),
  resolve(root, 'third_party/patches/0005-atomic-arm9-stack-args.patch'),
  resolve(root, 'third_party/patches/0006-scheduler-aware-arm9-stack-args.patch'),
  resolve(root, 'third_party/patches/0007-isolate-arm9-injected-stack.patch'),
]
const build = resolve(source, 'build-pokerun-wasm')
const output = resolve(root, 'public/emulators/melonds')
const expectedRevision = '53c7c6cb362560a9e362ae754a162f638fa3cd64'
const requiredRuntimeSymbols = [
  'writeArm9U8', 'writeArm9U16', 'writeArm9U32',
  'getArm9Sp', 'callArm9Thumb4', 'callArm9Thumb8Atomic', 'arm9CallStatus',
  'arm9CallPc', 'arm9CallLr', 'arm9CallCpsr', 'arm9CallInstructions',
  'arm9CallBudget', 'pokerunRuntimeVersion',
]

function run(command, args, cwd = root) { execFileSync(command, args, { cwd, stdio: 'inherit' }) }
function containsAscii(buffer, text) { return buffer.indexOf(Buffer.from(text, 'utf8')) !== -1 }

// The historical 0006/0007 unified diffs were written with inaccurate hunk
// headers; git apply rejects them even after --recount. Apply ONLY these known
// C++ hunks by exact, unique old-context matches instead. Never do a fuzzy
// replacement: changing source upstream must stop the build.
function applyExactWasmCppPatch(patchPath) {
  const cppPath = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.cpp')
  const targetHeader = 'diff --git a/wasmelonDS/src/frontend/wasm/WasmEmulator.cpp b/wasmelonDS/src/frontend/wasm/WasmEmulator.cpp'
  const lines = readFileSync(patchPath, 'utf8').split(/\r?\n/)
  const hunks = []
  let target = false
  let current = null

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (line !== targetHeader) throw new Error(`Unexpected file in ${patchPath}: ${line}`)
      target = true
      current = null
    } else if (target && line.startsWith('@@ ')) {
      current = { header: line, operations: [] }
      hunks.push(current)
    } else if (target && current && /^[ +\-]/.test(line)) {
      current.operations.push(line)
    } else if (target && current && line.startsWith('\\ No newline')) {
      throw new Error(`Unsupported non-terminated patch hunk in ${patchPath}`)
    }
  }

  const expectedHunks = patchPath.includes('0006-') ? 6 : 3
  if (hunks.length !== expectedHunks) {
    throw new Error(`Expected ${expectedHunks} validated C++ hunks in ${patchPath}, got ${hunks.length}`)
  }

  const sourceLines = readFileSync(cppPath, 'utf8').split('\n')
  for (const hunk of hunks) {
    const before = hunk.operations.filter(op => op[0] !== '+').map(op => op.slice(1))
    const after = hunk.operations.filter(op => op[0] !== '-').map(op => op.slice(1))
    if (!before.length) throw new Error(`Refusing insertion-only hunk in ${patchPath}: ${hunk.header}`)
    const hits = []
    for (let offset = 0; offset <= sourceLines.length - before.length; offset += 1) {
      if (sourceLines[offset] === before[0] && before.every((line, idx) => sourceLines[offset + idx] === line)) {
        hits.push(offset)
      }
    }
    if (hits.length !== 1) {
      throw new Error(`Patch ${patchPath} ${hunk.header} matched ${hits.length} locations (expected exactly one)`)
    }
    sourceLines.splice(hits[0], before.length, ...after)
  }

  writeFileSync(cppPath, sourceLines.join('\n'))
  console.log(`[PokéRun] Strictly applied ${hunks.length} C++ hunks from ${patchPath}`)
}

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
  // Git applies 0001-0005 as usual. Historical 0006/0007 headers are rejected
  // by git apply even with --recount; match their C++ contents exactly instead.
  for (const patch of patches.slice(0, 5)) {
    run('git', ['apply', '--recount', '--check', patch], source)
    run('git', ['apply', '--recount', patch], source)
  }
  for (const patch of patches.slice(5)) applyExactWasmCppPatch(patch)

  // Apply build requirements after restoring and patching upstream.
  const wasmCmake = resolve(source, 'wasmelonDS/src/frontend/wasm/CMakeLists.txt')
  writeFileSync(wasmCmake, readFileSync(wasmCmake, 'utf8') +
    '\ntarget_compile_features(wasmemulator PRIVATE cxx_std_20)\n')

  const patchedCpp = readFileSync(resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.cpp'), 'utf8')
  for (const symbol of requiredRuntimeSymbols) {
    if (!patchedCpp.includes(`.function("${symbol}"`)) throw new Error(`PokéRun melonDS patch did not expose ${symbol} through Embind.`)
  }
  if (!patchedCpp.includes('arm.PokerunInstructionLimit = 1000000;')) {
    throw new Error('PokéRun melonDS patch did not install the 1,000,000-instruction ARM9 native-call budget.')
  }
  if (!patchedCpp.includes('nds->RunFrame();')) {
    throw new Error('PokéRun melonDS patch did not retain scheduler-aware ARM9 native calls.')
  }
  if (!patchedCpp.includes('u32 WasmEmulator::callArm9Thumb8Atomic')) {
    throw new Error('PokéRun melonDS patch did not install the stack-argument ARM9 bridge.')
  }
  if (!patchedCpp.includes('PRK11 scheduler-aware stack-argument bridge')) {
    throw new Error('PokéRun stack-argument bridge is not scheduler-aware PRK11.')
  }
  if (!patchedCpp.includes('const u32 injectedSp = originalSp - (stackReserve >> 2);') ||
      !patchedCpp.includes('arm.R[13] = injectedSp;')) {
    throw new Error('PokéRun melonDS patch did not isolate the injected stack arguments.')
  }
  if (!patchedCpp.includes('return 0x50524B3C;')) {
    throw new Error('PokéRun melonDS patch did not install the PRK32 runtime stamp.')
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
