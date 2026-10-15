import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const source = resolve(root, 'third_party/ds-anywhere')
const patch = resolve(root, 'third_party/patches/0001-expose-arm9-bus-reads.patch')
const build = resolve(source, 'build-pokerun-wasm')
const output = resolve(root, 'public/emulators/melonds')
const expectedRevision = '53c7c6cb362560a9e362ae754a162f638fa3cd64'

function run(command, args, cwd = root) { execFileSync(command, args, { cwd, stdio: 'inherit' }) }

if (!existsSync(resolve(source, '.git'))) throw new Error('Missing third_party/ds-anywhere. Run: git submodule update --init --recursive')
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
if (revision !== expectedRevision) throw new Error(`DS Anywhere must be pinned to ${expectedRevision}; found ${revision}.`)

// The patch is PokéRun-owned and can change while the pinned upstream revision stays fixed.
// Always restore tracked upstream files first so an older applied patch cannot block a newer one.
run('git', ['reset', '--hard', expectedRevision], source)
run('git', ['apply', '--check', patch], source)
run('git', ['apply', patch], source)

// This runtime is intentionally rebuilt from a clean CMake directory. Incremental Emscripten
// builds can otherwise leave an older Embind API in wasmemulator.wasm after the PokéRun patch changes.
rmSync(build, { recursive: true, force: true })
run('emcmake', ['cmake', '-S', 'wasmelonDS', '-B', build, '-DBUILD_QT_SDL=OFF', '-DENABLE_OGLRENDERER=OFF', '-DENABLE_GDBSTUB=OFF'], source)
run('cmake', ['--build', build, '--target', 'wasmemulator', '-j2'], source)
mkdirSync(output, { recursive: true })
copyFileSync(resolve(build, 'wasmemulator.js'), resolve(output, 'wasmemulator.js'))
copyFileSync(resolve(build, 'wasmemulator.wasm'), resolve(output, 'wasmemulator.wasm'))
console.log('Built reproducible melonDS runtime into public/emulators/melonds/.')
