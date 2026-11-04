export const DS_SCREEN_WIDTH = 256
export const DS_SCREEN_HEIGHT = 192

const MELONDS_RUNTIME_VERSION = 'arm9-call-v13-prk63-wireless-audit'
const MELONDS_RUNTIME_CACHE_TOKEN = import.meta.env.DEV
  ? `${MELONDS_RUNTIME_VERSION}-${Date.now().toString(36)}`
  : MELONDS_RUNTIME_VERSION

export const POKERUN_MELONDS_RUNTIME_STAMP = 0x50524B3D
export const POKERUN_ARM9_CALL_BUDGET = 1000000

type WasmCart = { loadFromFile(path: string): boolean; delete?: () => void }
type WasmEmulator = {
  loadFreeBIOS(): void
  setSavePath(path: string): void
  loadRom(cart: WasmCart, reset: boolean): boolean
  initialize(direct: boolean): void
  processFrame(hidden: boolean): void
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
  callArm9Thumb8Atomic(functionAddress: number, r0: number, r1: number, r2: number, r3: number, r4stack: number, r5stack: number, r6stack: number, r7stack: number, stackReserve: number): number
  arm9CallStatus(): number
  arm9CallPc(): number
  arm9CallLr(): number
  arm9CallCpsr(): number
  arm9CallInstructions(): number
  arm9CallBudget(): number
  pokerunRuntimeVersion(): number
  prk63WifiStarts(): number
  prk63WifiStops(): number
  prk63MpTxCalls(): number
  prk63MpRxPolls(): number
  prk63MpHostRxPolls(): number
  prk63NetTxCalls(): number
  delete?: () => void
}

export type MelonDsModule = {
  HEAPU8: Uint8Array
  WasmEmulator: new () => WasmEmulator
  WasmNdsCart: new () => WasmCart
}

declare global {
  interface Window {
    HEAPU8?: Uint8Array
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
      locateFile: file => `/emulators/melonds/${file}?v=${MELONDS_RUNTIME_CACHE_TOKEN}`,
      onRuntimeInitialized: () => {
        // Current Emscripten keeps HEAPU8 as a script global instead of
        // exporting it on Module. Read it on every draw so a new memory view
        // is used if the WASM memory ever grows.
        if (!(window.HEAPU8 instanceof Uint8Array)) {
          reject(new Error('melonDS initialized without an accessible WASM framebuffer heap.'))
          return
        }
        Object.defineProperty(window.Module, 'HEAPU8', {
          configurable: true,
          get: () => window.HEAPU8,
        })

        const module = window.Module as MelonDsModule
        let probe: WasmEmulator | null = null
        try {
          probe = new module.WasmEmulator()
          const stamp = probe.pokerunRuntimeVersion?.()
          const budget = probe.arm9CallBudget?.()
          const hasAtomicStackArgs = typeof probe.callArm9Thumb8Atomic === 'function'
          const hasPrk63WirelessCounters = [
            'prk63WifiStarts', 'prk63WifiStops', 'prk63MpTxCalls',
            'prk63MpRxPolls', 'prk63MpHostRxPolls', 'prk63NetTxCalls',
          ].every(key => typeof (probe as unknown as Record<string, unknown>)[key] === 'function')
          if (stamp !== POKERUN_MELONDS_RUNTIME_STAMP || budget !== POKERUN_ARM9_CALL_BUDGET || !hasAtomicStackArgs || !hasPrk63WirelessCounters) {
            reject(new Error(
              `Stale melonDS runtime loaded (stamp=0x${(stamp ?? 0).toString(16).toUpperCase()}, ARM9 budget=${budget ?? 0}, atomic8=${hasAtomicStackArgs}, prk63Counters=${hasPrk63WirelessCounters}); ` +
              `expected stamp=0x${POKERUN_MELONDS_RUNTIME_STAMP.toString(16).toUpperCase()}, budget=${POKERUN_ARM9_CALL_BUDGET}, atomic8=true. ` +
              'Run npm run build:melonds, restart Vite, and reopen the tab.',
            ))
            return
          }
        } catch (error) {
          reject(error instanceof Error ? error : new Error('Could not verify the PokéRun melonDS runtime.'))
          return
        } finally {
          probe?.delete?.()
        }

        resolve(module)
      },
    }
    const script = document.createElement('script')
    script.dataset.pokerunMelonds = 'true'
    script.src = `/emulators/melonds/wasmemulator.js?v=${MELONDS_RUNTIME_CACHE_TOKEN}`
    script.async = true
    script.onerror = () => reject(new Error('Could not load the melonDS runtime. Run the documented build:melonds command first.'))
    document.head.append(script)
  })
  return loading
}

export type RuntimeEmulator = WasmEmulator
export type RuntimeCart = WasmCart
