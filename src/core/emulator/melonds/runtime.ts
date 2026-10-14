export const DS_SCREEN_WIDTH = 256
export const DS_SCREEN_HEIGHT = 192

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
    FS?: { writeFile(path: string, data: Uint8Array): void; mkdir(path: string): void }
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
      locateFile: file => `/emulators/melonds/${file}`,
      onRuntimeInitialized: () => resolve(window.Module as MelonDsModule),
    }
    const script = document.createElement('script')
    script.dataset.pokerunMelonds = 'true'
    script.src = '/emulators/melonds/wasmemulator.js'
    script.async = true
    script.onerror = () => reject(new Error('Could not load the melonDS runtime. Run the documented build:melonds command first.'))
    document.head.append(script)
  })
  return loading
}

export type RuntimeEmulator = WasmEmulator
export type RuntimeCart = WasmCart
