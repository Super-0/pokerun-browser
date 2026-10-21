import type { EmulatorBridge, EmulatorStatus } from '../EmulatorBridge'
import type { Platform } from '../../../types'
import { DS_SCREEN_HEIGHT, DS_SCREEN_WIDTH, loadMelonDsRuntime, POKERUN_MELONDS_RUNTIME_STAMP, type MelonDsModule, type RuntimeCart, type RuntimeEmulator } from './runtime'

const buttonMasks = { a: 1 << 0, b: 1 << 1, select: 1 << 2, start: 1 << 3, right: 1 << 4, left: 1 << 5, up: 1 << 6, down: 1 << 7, r: 1 << 8, l: 1 << 9, x: 1 << 10, y: 1 << 11 } as const
export type DsButton = keyof typeof buttonMasks
export type DsSpeedMultiplier = 1 | 2 | 4
export type Arm9NativeCallStatus = 1 | 2 | 3 | 4
export type Arm9NativeCallResult = {
  result: number
  status: Arm9NativeCallStatus
  pc: number
  lr: number
  cpsr: number
  instructions: number
}

/** PokéRun's melonDS boundary. ARM9 methods access the emulated DS bus, never the WASM host heap. */
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
  private readonly acceleratedFrameTimers = new Set<number>()
  private lastFrameAt = 0
  private running = false
  private speedMultiplier: DsSpeedMultiplier = 1
  private acceleratedDrawPending = false
  private readonly emulatedFrameListeners = new Set<() => void>()
  private topImage: ImageData | null = null
  private bottomImage: ImageData | null = null
  private pendingBatterySave: Uint8Array | null = null
  private batterySaveListener: ((save: Uint8Array) => void | Promise<void>) | null = null
  private saveFlushTimer: number | null = null
  private saveDirty = false
  private savePath = '/pokerun/saves/game.sav'

  attachScreens(top: HTMLCanvasElement, bottom: HTMLCanvasElement) { this.topCanvas = top; this.bottomCanvas = bottom }

  setSpeedMultiplier(multiplier: DsSpeedMultiplier) {
    if (this.speedMultiplier === multiplier) return
    this.speedMultiplier = multiplier
    this.clearAcceleratedFrames()
    this.acceleratedDrawPending = false
  }
  getSpeedMultiplier() { return this.speedMultiplier }
  subscribeEmulatedFrame(listener: () => void) {
    this.emulatedFrameListeners.add(listener)
    return () => this.emulatedFrameListeners.delete(listener)
  }

  setSaveKey(key: string) {
    const safe = key.replace(/[^a-z0-9_-]/gi, '_')
    this.savePath = `/pokerun/saves/${safe || 'game'}.sav`
  }

  setBatterySaveListener(listener: ((save: Uint8Array) => void | Promise<void>) | null) {
    this.batterySaveListener = listener
  }

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
    if (this.pendingBatterySave?.length) fs.writeFile(this.savePath, this.pendingBatterySave)
    this.pendingBatterySave = null
    this.emulator?.delete?.(); this.cart?.delete?.()

    const emulator = new module.WasmEmulator()
    const candidate = emulator as Partial<RuntimeEmulator>
    const missing = [
      'readArm9U32', 'writeArm9U8', 'writeArm9U16', 'writeArm9U32',
      'getArm9Sp', 'callArm9Thumb4', 'arm9CallStatus',
      'arm9CallPc', 'arm9CallLr', 'arm9CallCpsr', 'arm9CallInstructions',
      'pokerunRuntimeVersion',
    ].filter(name => typeof (candidate as Record<string, unknown>)[name] !== 'function')
    if (missing.length) {
      emulator.delete?.()
      throw new Error(`Stale melonDS runtime loaded; missing PokéRun WASM exports: ${missing.join(', ')}. Pull dev, run npm run build:melonds, restart Vite, and reopen the tab.`)
    }
    const stamp = candidate.pokerunRuntimeVersion?.()
    if (stamp !== POKERUN_MELONDS_RUNTIME_STAMP) {
      emulator.delete?.()
      throw new Error(`Unexpected melonDS runtime stamp 0x${(stamp ?? 0).toString(16).toUpperCase()}; expected PokéRun ARM9 native-call runtime 0x${POKERUN_MELONDS_RUNTIME_STAMP.toString(16).toUpperCase()}.`)
    }

    this.emulator = emulator
    this.cart = new module.WasmNdsCart()
    if (!this.cart.loadFromFile('/pokerun/roms/game.nds')) throw new Error('melonDS rejected this .nds ROM.')
    this.emulator.setSavePath(this.savePath)
    this.emulator.loadFreeBIOS()
    if (!this.emulator.loadRom(this.cart, false)) throw new Error('melonDS could not attach the ROM cartridge.')
    this.status = 'loaded'
  }

  async start() {
    if (!this.emulator) throw new Error('Load a DS ROM before starting melonDS.')
    this.emulator.initialize(true)
    this.status = 'running'; this.running = true; this.scheduleFrame()
  }
  async pause() {
    if (this.status !== 'running') return
    this.running = false
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = null
    this.clearAcceleratedFrames()
    this.acceleratedDrawPending = false
    this.status = 'paused'
  }
  async resume() { if (this.status === 'paused') { this.running = true; this.status = 'running'; this.scheduleFrame() } }
  async reset() { if (!this.emulator) return; await this.pause(); this.emulator.initialize(true); await this.resume() }

  async exportBatterySave() {
    try {
      const fs = window.FS
      if (!fs) return null
      const bytes = fs.readFile(this.savePath)
      return bytes?.length ? new Uint8Array(bytes) : null
    } catch {
      return null
    }
  }

  async importBatterySave(save: Uint8Array) {
    this.pendingBatterySave = save.slice()
  }

  async dispose() {
    await this.flushBatterySave()
    await this.pause()
    if (this.saveFlushTimer !== null) window.clearTimeout(this.saveFlushTimer)
    this.saveFlushTimer = null
    this.emulatedFrameListeners.clear()
    this.cart?.delete?.(); this.emulator?.delete?.(); this.cart = null; this.emulator = null; this.status = 'stopped'
  }

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

  async write8(address: number, value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new Error('ARM9 8-bit writes require a value from 0 to 255.')
    this.assertEmulator().writeArm9U8(this.assertAddress(address), value)
  }
  async write16(address: number, value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error('ARM9 16-bit writes require a value from 0 to 65535.')
    this.assertEmulator().writeArm9U16(this.assertAddress(address), value)
  }
  async write32(address: number, value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error('ARM9 32-bit writes require an unsigned 32-bit value.')
    this.assertEmulator().writeArm9U32(this.assertAddress(address), value >>> 0)
  }
  async writeBytes(address: number, bytes: Uint8Array) {
    if (bytes.length > 0x10000) throw new Error('DS memory writes must be 0–65536 bytes.')
    this.assertAddress(address)
    for (let offset = 0; offset < bytes.length; offset += 1) await this.write8(address + offset, bytes[offset])
  }

  async getArm9Sp() {
    return this.assertEmulator().getArm9Sp() >>> 0
  }

  async callArm9Thumb4(functionAddress: number, r0 = 0, r1 = 0, r2 = 0, r3 = 0, stackReserve = 0x1000): Promise<Arm9NativeCallResult> {
    this.assertAddress(functionAddress)
    const args = [r0, r1, r2, r3]
    if (args.some(value => !Number.isInteger(value) || value < 0 || value > 0xffffffff)) throw new Error('ARM9 native-call arguments must be unsigned 32-bit values.')
    if (!Number.isInteger(stackReserve) || stackReserve < 0x100 || stackReserve > 0x4000 || stackReserve % 8 !== 0) throw new Error('ARM9 native-call stack reserve must be 0x100–0x4000 bytes and 8-byte aligned.')
    const emulator = this.assertEmulator()
    const result = emulator.callArm9Thumb4(functionAddress >>> 0, r0 >>> 0, r1 >>> 0, r2 >>> 0, r3 >>> 0, stackReserve) >>> 0
    const status = emulator.arm9CallStatus() as Arm9NativeCallStatus
    if (status < 1 || status > 4) throw new Error(`ARM9 native call returned unknown status ${status}.`)
    return {
      result,
      status,
      pc: emulator.arm9CallPc() >>> 0,
      lr: emulator.arm9CallLr() >>> 0,
      cpsr: emulator.arm9CallCpsr() >>> 0,
      instructions: emulator.arm9CallInstructions() >>> 0,
    }
  }

  private assertEmulator() { if (!this.emulator || this.status === 'idle' || this.status === 'stopped') throw new Error('melonDS is not running.'); return this.emulator }
  private assertAddress(address: number) { if (!Number.isInteger(address) || address < 0 || address > 0xffffffff) throw new Error('Invalid ARM9 bus address.'); return address >>> 0 }
  private clearAcceleratedFrames() {
    for (const timer of this.acceleratedFrameTimers) window.clearTimeout(timer)
    this.acceleratedFrameTimers.clear()
  }
  private scheduleAcceleratedFrames(multiplier: Exclude<DsSpeedMultiplier, 1>) {
    if (!this.emulator) return
    const displayFrameMs = 1000 / 60
    for (let index = 1; index < multiplier; index += 1) {
      const timer = window.setTimeout(() => {
        this.acceleratedFrameTimers.delete(timer)
        if (!this.running || !this.emulator || this.speedMultiplier !== multiplier) return
        this.emulator.setInput(this.inputMask)
        this.emulator.processFrame(false)
      }, displayFrameMs * index / multiplier)
      this.acceleratedFrameTimers.add(timer)
    }
  }
  private scheduleFrame() {
    this.frame = requestAnimationFrame(now => {
      if (!this.running || !this.emulator) return
      if (now - this.lastFrameAt >= 1000 / 60) {
        this.lastFrameAt = now
        this.clearAcceleratedFrames()
        const multiplier = this.speedMultiplier
        if (multiplier > 1) this.scheduleAcceleratedFrames(multiplier)
        this.emulator.setInput(this.inputMask)
        this.emulator.processFrame(false)
        if (multiplier > 1 && this.acceleratedDrawPending) {
          this.acceleratedDrawPending = false
          this.draw()
        }
      }
      this.scheduleFrame()
    })
  }

  private scheduleBatterySaveExport() {
    this.saveDirty = true
    if (this.saveFlushTimer !== null) window.clearTimeout(this.saveFlushTimer)
    this.saveFlushTimer = window.setTimeout(() => { this.saveFlushTimer = null; void this.flushBatterySave() }, 650)
  }

  private async flushBatterySave() {
    if (!this.saveDirty) return
    const save = await this.exportBatterySave()
    if (!save?.length) return
    this.saveDirty = false
    await this.batterySaveListener?.(save)
  }

  private notifyEmulatedFrame() {
    for (const listener of this.emulatedFrameListeners) {
      try { listener() } catch (error) { console.warn('melonDS emulated-frame listener failed.', error) }
    }
  }

  private installRuntimeCallbacks() {
    window.WebMelon = { _internal: { events: { onEmulatorFrameUpdate: () => {
      if (this.speedMultiplier === 1) this.draw()
      else this.acceleratedDrawPending = true
      this.notifyEmulatedFrame()
    }, onSaveWrite: () => this.scheduleBatterySaveExport(), onRumbleStart: () => undefined, onRumbleStop: () => undefined, onShutdown: () => { void this.pause() } } } }
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