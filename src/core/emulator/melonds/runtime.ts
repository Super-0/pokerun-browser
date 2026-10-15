export const DS_SCREEN_WIDTH = 256
export const DS_SCREEN_HEIGHT = 192

const MELONDS_RUNTIME_VERSION = 'arm9-call-v3'

export const POKERUN_MELONDS_RUNTIME_STAMP = 0x50524B33

type WasmCart = { loadFromFile(path: string): boolean; delete?: () => void }
type WasmEmulator = {
  loadFreeBIOS(): void
  setSavePath(path: string): void
  loadRom(cart: WasmCart, reset: boolean): boolean
  initialize(direct: boolean): void
  processFrame(ghost: boolean): void
  setInput(mask: number): void
  touchScreen(x: number, y: number): void
  releaseScreen(): void
  getTopScreen(): number
  getBottomScreen(): number
  readArm9U8(address: number): number
  readArm9U16(address: number): number
  readArm9U32(address: number): number
  writeArm9U8(address: number, value: number): void
  writeArm9U16(address: number, value: number): void
  writeArm9U32(address: number, value: number): void
  getArm9Sp(): number
  callArm9Thumb4(functionAddress: number, r0: number, r1: number, r2: number, r3: number, stackReserve: number): number
  arm9CallStatus(): number
  pokerunRuntimeVersion(): number
  delete?: () => void
}

export type MelonDsModule = {
  HEAPU8: Uint8Array
  WasmEmulator: new () => WasmEmulator
  WasmNdsCart: new () => WasmCart
}

declare global {
  interface Window {
    Module?: Partial<MelonDsModule> & { onRuntimeInitialized?: () => void; locateFile?: (path: string) => string }
    FS?: {
      writeFile(path: string, data: Uint8Array): void
      readFile(path: string): Uint8Array
      mkdir(path: string): void
      unlink?(path: string): void
      analyzePath?(path: string): { exists: boolean }
    }
    WebMelon?: { _internal: { events: Record<string, () => void> } }
  }
}

let loading: Promise<MelonDsModule> | null = null

/** Loads the locally generated Emscripten artifact. The source lives in the pinned GPL submodule. */
export function loadMelonDsRuntime() {
  if (loading) return loading
  loading = new Promise((resolve, reject) => {
    if (document.querySelector('script[data-pokerun-melonds]')) return reject(new Error('melonDS runtime script was already requested but did not initialize.'))
    window.Module = {
      locateFile: file => `/emulators/melonds/${file}?v=${MELONDS_RUNTIME_VERSION}`,
      onRuntimeInitialized: () => resolve(window.Module as MelonDsModule),
    }
    const script = document.createElement('script')
    script.dataset.pokerunMelonds = 'true'
    script.src = `/emulators/melonds/wasmemulator.js?v=${MELONDS_RUNTIME_VERSION}`
    script.async = true
    script.onerror = () => reject(new Error('Could not load the melonDS runtime. Run the documented build:melonds command first.'))
    document.head.append(script)
  })
  return loading
}

export type RuntimeEmulator = WasmEmulator
export type RuntimeCart = WasmCart
