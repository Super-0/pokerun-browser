import type { EmulatorBridge, EmulatorStatus } from '../EmulatorBridge'
import type { Platform } from '../../../types'
import { DS_SCREEN_HEIGHT, DS_SCREEN_WIDTH, loadMelonDsRuntime, type MelonDsModule, type RuntimeCart, type RuntimeEmulator } from './runtime'

const buttonMasks = { a: 1 << 0, b: 1 << 1, select: 1 << 2, start: 1 << 3, right: 1 << 4, left: 1 << 5, up: 1 << 6, down: 1 << 7, r: 1 << 8, l: 1 << 9, x: 1 << 10, y: 1 << 11 } as const
export type DsButton = keyof typeof buttonMasks

/** PokéRun's melonDS boundary. ARM9 methods read the emulated DS bus, never the WASM host heap. */
export class MelonDsBridge implements EmulatorBridge {
  readonly platform: Platform = 'NDS'
  status: EmulatorStatus = 'idle'
  private module: MelonDsModule | null = null
  private emulator: RuntimeEmulator | null = null
  private cart: RuntimeCart | null = null
  private inputMask = 0
  private topCanvas: HTMLCanvasElement | null = null
  private bottomCanvas: HTMLCanvasElement | null = null
  private frame: number | null = null
  private lastFrameAt = 0
  private running = false
  private topImage: ImageData | null = null
  private bottomImage: ImageData | null = null

  attachScreens(top: HTMLCanvasElement, bottom: HTMLCanvasElement) { this.topCanvas = top; this.bottomCanvas = bottom }

  async loadRom(rom: ArrayBuffer) {
    if (!this.topCanvas || !this.bottomCanvas) throw new Error('DS screen canvases are not ready.')
    this.module = await loadMelonDsRuntime()
    this.installRuntimeCallbacks()
    const module = this.module
    const fs = window.FS
    if (!fs) throw new Error('melonDS virtual filesystem is unavailable.')
    try { fs.mkdir('/pokerun') } catch { /* directory already exists */ }
    try { fs.mkdir('/pokerun/roms') } catch { /* directory already exists */ }
    try { fs.mkdir('/pokerun/saves') } catch { /* directory already exists */ }
    fs.writeFile('/pokerun/roms/game.nds', new Uint8Array(rom))
    this.emulator?.delete?.(); this.cart?.delete?.()
    this.emulator = new module.WasmEmulator()
    this.cart = new module.WasmNdsCart()
    if (!this.cart.loadFromFile('/pokerun/roms/game.nds')) throw new Error('melonDS rejected this .nds ROM.')
    this.emulator.setSavePath('/pokerun/saves/game.sav')
    this.emulator.loadFreeBIOS()
    if (!this.emulator.loadRom(this.cart, false)) throw new Error('melonDS could not attach the ROM cartridge.')
    this.status = 'loaded'
  }

  async start() {
    if (!this.emulator) throw new Error('Load a DS ROM before starting melonDS.')
    this.emulator.initialize(true)
    this.status = 'running'; this.running = true; this.scheduleFrame()
  }
  async pause() { if (this.status === 'running') { this.running = false; if (this.frame) cancelAnimationFrame(this.frame); this.frame = null; this.status = 'paused' } }
  async resume() { if (this.status === 'paused') { this.running = true; this.status = 'running'; this.scheduleFrame() } }
  async reset() { if (!this.emulator) return; await this.pause(); this.emulator.initialize(true); await this.resume() }
  async exportBatterySave() { return null }
  async importBatterySave(_save: Uint8Array) { throw new Error('melonDS save import is not implemented yet.') }
  async dispose() { await this.pause(); this.cart?.delete?.(); this.emulator?.delete?.(); this.cart = null; this.emulator = null; this.status = 'stopped' }

  press(button: DsButton, pressed: boolean) { this.inputMask = pressed ? this.inputMask | buttonMasks[button] : this.inputMask & ~buttonMasks[button] }
  touch(clientX: number, clientY: number) {
    if (!this.bottomCanvas || !this.emulator) return
    const rect = this.bottomCanvas.getBoundingClientRect()
    const x = Math.max(0, Math.min(DS_SCREEN_WIDTH - 1, Math.floor((clientX - rect.left) / rect.width * DS_SCREEN_WIDTH)))
    const y = Math.max(0, Math.min(DS_SCREEN_HEIGHT - 1, Math.floor((clientY - rect.top) / rect.height * DS_SCREEN_HEIGHT)))
    this.emulator.touchScreen(x, y)
  }
  releaseTouch() { this.emulator?.releaseScreen() }

  async readMemory(address: number, length: number) { return this.readBytes(address, length) }
  async read8(address: number) { return this.assertEmulator().readArm9U8(this.assertAddress(address)) >>> 0 }
  async read16(address: number) { return this.assertEmulator().readArm9U16(this.assertAddress(address)) >>> 0 }
  async read32(address: number) { return this.assertEmulator().readArm9U32(this.assertAddress(address)) >>> 0 }
  async readBytes(address: number, length: number) {
    if (!Number.isInteger(length) || length < 0 || length > 0x10000) throw new Error('DS memory reads must be 0–65536 bytes.')
    this.assertAddress(address); const bytes = new Uint8Array(length)
    for (let offset = 0; offset < length; offset += 1) bytes[offset] = await this.read8(address + offset)
    return bytes
  }

  private assertEmulator() { if (!this.emulator || this.status === 'idle' || this.status === 'stopped') throw new Error('melonDS is not running.'); return this.emulator }
  private assertAddress(address: number) { if (!Number.isInteger(address) || address < 0 || address > 0xffffffff) throw new Error('Invalid ARM9 bus address.'); return address >>> 0 }
  private scheduleFrame() { this.frame = requestAnimationFrame(now => { if (!this.running || !this.emulator) return; if (now - this.lastFrameAt >= 1000 / 60) { this.lastFrameAt = now; this.emulator.setInput(this.inputMask); this.emulator.processFrame(false) } this.scheduleFrame() }) }
  private installRuntimeCallbacks() {
    window.WebMelon = { _internal: { events: { onEmulatorFrameUpdate: () => this.draw(), onSaveWrite: () => undefined, onRumbleStart: () => undefined, onRumbleStop: () => undefined, onShutdown: () => { void this.pause() } } } }
  }
  private draw() {
    if (!this.module || !this.emulator || !this.topCanvas || !this.bottomCanvas) return
    const topContext = this.topCanvas.getContext('2d'); const bottomContext = this.bottomCanvas.getContext('2d')
    if (!topContext || !bottomContext) return
    this.topImage ??= topContext.createImageData(DS_SCREEN_WIDTH, DS_SCREEN_HEIGHT)
    this.bottomImage ??= bottomContext.createImageData(DS_SCREEN_WIDTH, DS_SCREEN_HEIGHT)
    this.topImage.data.set(new Uint8ClampedArray(this.module.HEAPU8.buffer, this.emulator.getTopScreen(), DS_SCREEN_WIDTH * DS_SCREEN_HEIGHT * 4))
    this.bottomImage.data.set(new Uint8ClampedArray(this.module.HEAPU8.buffer, this.emulator.getBottomScreen(), DS_SCREEN_WIDTH * DS_SCREEN_HEIGHT * 4))
    topContext.putImageData(this.topImage, 0, 0); bottomContext.putImageData(this.bottomImage, 0, 0)
  }
}
