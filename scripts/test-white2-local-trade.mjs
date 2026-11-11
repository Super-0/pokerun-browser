import { access, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const privateRoot = resolve('local-test-assets')
const checkpoint = join(privateRoot, 'white2-checkpoint', 'Default', 'IndexedDB')
const driver = join(privateRoot, 'white2-greeting-driver.mjs')

for (const path of [checkpoint, driver]) {
  try {
    await stat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.error(`Missing private White 2 trade prerequisite: ${path}`)
      console.error('Run npm run test:white2:prepare with a verified ROM and disposable saves, then provide the private greeting driver.')
      process.exitCode = 2
      process.exit()
    }
    throw error
  }
}

await access(resolve('public/emulators/melonds/wasmemulator.js'))
await access(resolve('public/emulators/melonds/wasmemulator.wasm'))

process.env.VITE_POKERUN_WHITE2_LOCAL_MULTIPLAYER = '1'
process.env.POKERUN_WHITE2_NORMAL_UI = '1'
process.env.POKERUN_WHITE2_UNATTENDED = '1'
process.env.POKERUN_WORKER_RADIO = '1'
process.env.POKERUN_TRACE_GAME_NEGOTIATION = '1'
process.env.POKERUN_EXPECT_WHITE2 = 'trade-confirmed'
process.argv[2] = 'greeting'
await import('./test-white2-private.mjs')
