import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

const pokerunMgbaMemoryBridge = {
  name: 'pokerun-mgba-memory-bridge',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    const normalizedId = id.replaceAll('\\', '/')
    if (!normalizedId.includes('/@thenick775/mgba-wasm/dist/mgba.js')) return null

    const marker = 'POKERUN_VITE_HEAP_BRIDGE'
    if (code.includes(marker)) return null

    const finalReturn = 'return Module}export default mGBA;'
    if (!code.includes(finalReturn)) {
      throw new Error('[PokéRun] Vite could not locate the final mGBA Module return.')
    }

    const bridge = `/* ${marker}: expose memory on the exact module Vite serves to PokéRun. */
Object.defineProperty(Module, 'HEAPU8', {
  configurable: true,
  get: () => wasmMemory && wasmMemory.buffer ? new Uint8Array(wasmMemory.buffer) : undefined
});
Object.defineProperty(Module, 'wasmMemory', {
  configurable: true,
  get: () => wasmMemory
});
`

    console.log('[PokéRun] Vite injected the final mGBA memory bridge.')
    return {
      code: code.replace(finalReturn, `${bridge}${finalReturn}`),
      map: null,
    }
  },
}

export default defineConfig({
  plugins: [pokerunMgbaMemoryBridge, react()],
  server: {
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  optimizeDeps: {
    exclude: ['@thenick775/mgba-wasm'],
  },
})
