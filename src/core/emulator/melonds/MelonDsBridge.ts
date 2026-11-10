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

export type MelonDsFrameStats = {
  frames: number
  hiddenFrames: number
  visibleFrames: number
  processMs: number
  hiddenProcessMs: number
  visibleProcessMs: number
  batches: number
  batchMs: number
  rafCallbacks: number
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
  private lastFrameAt = 0
  private frameAccumulator = 0
  private running = false
  private speedMultiplier: DsSpeedMultiplier = 1
  private readonly frameStats: MelonDsFrameStats = { frames: 0, hiddenFrames: 0, visibleFrames: 0, processMs: 0, hiddenProcessMs: 0, visibleProcessMs: 0, batches: 0, batchMs: 0, rafCallbacks: 0 }
  private readonly emulatedFrameListeners = new Set<() => void>()
  private topImage: ImageData | null = null
  private bottomImage: ImageData | null = null
  private pendingBatterySave: Uint8Array | null = null
  private batterySaveListener: ((save: Uint8Array) => void | Promise<void>) | null = null
  private saveFlushTimer: number | null = null
  private saveDirty = false
  private savePath = '/pokerun/saves/game.sav'
  private workerFrameTimer: number | null = null
  private workerNextFrameAt = 0
  private readonly radioOutputListeners = new Set<() => void>()
  private readonly workerRadioRequested = import.meta.env.DEV &&
    sessionStorage.getItem('pokerun:prk80-worker-radio') === '1'
  private get workerRadio() { return this.workerRadioRequested && this.devWirelessFirmwareRole !== 0 }
  private devWirelessFirmwareRole: 0 | 1 | 2 = 0

  /** PRK71: assign before loadRom. Applies only to in-memory firmware of a
   * verified real-player DEV session; never writes MACs into battery saves.
   */
  setDevWirelessFirmwareRole(role: 1 | 2) {
    if (!import.meta.env.DEV || this.emulator || this.status !== 'idle') {
      throw new Error('PRK71 wireless role must be assigned before emulator startup in DEV.')
    }
    this.devWirelessFirmwareRole = role
  }

  attachScreens(top: HTMLCanvasElement, bottom: HTMLCanvasElement) { this.topCanvas = top; this.bottomCanvas = bottom }

  setSpeedMultiplier(multiplier: DsSpeedMultiplier) { this.speedMultiplier = multiplier }
  getSpeedMultiplier() { return this.speedMultiplier }
  getFrameStats(): MelonDsFrameStats { return { ...this.frameStats } }

  /** PRK63: read-only counters from the native Wi-Fi callback boundary.
   * No raw packets or emulator memory are read, and no transport is enabled.
   * These counts refer to this emulator, not the simulated P2 actor.
   */
  getNativeWirelessProbeCounters() {
    const emu = this.assertEmulator()
    return {
      wifiStarts: emu.prk63WifiStarts() >>> 0,
      wifiStops: emu.prk63WifiStops() >>> 0,
      mpTxAttempts: emu.prk63MpTxCalls() >>> 0,
      mpRxPolls: emu.prk63MpRxPolls() >>> 0,
      mpHostRxPolls: emu.prk63MpHostRxPolls() >>> 0,
      netTxAttempts: emu.prk63NetTxCalls() >>> 0,
      // PRK65: Frame-control classifications, not packet payloads.
      txManagement: emu.prk65TxMgmt() >>> 0,
      txControl: emu.prk65TxControl() >>> 0,
      txData: emu.prk65TxData() >>> 0,
      txEmptyOrInvalid: emu.prk65TxInvalid() >>> 0,
      txBeacons: emu.prk65TxBeacon() >>> 0,
      txProbes: emu.prk65TxProbe() >>> 0,
      txMpCommands: emu.prk65TxCommand() >>> 0,
      txMpReplies: emu.prk65TxReply() >>> 0,
      txMpAcks: emu.prk65TxAck() >>> 0,
    }
  }
  /** PRK66: development-only, explicitly opt-in, same-origin local radio.
   * This exposes raw frames to the paired browser tab, but never stores them
   * or sends them to a network service. Not a trade or a live save operation.
   */
  setNativeWirelessDevLinkEnabled(enabled: boolean) {
    if (!import.meta.env.DEV) throw new Error('PRK66 radio bridge is development-only.')
    const emulator = this.assertEmulator()
    if (this.workerRadio) emulator.pokerunSetRadioWaiting?.(enabled)
    emulator.prk66SetEnabled(enabled)
  }
  receiveNativeWirelessDevReply(bytes: Uint8Array, timestamp: number, aid: number, traceSequence = 0) {
    if (!import.meta.env.DEV) throw new Error('PRK79 radio replies are development-only.')
    return this.assertEmulator().prk79InjectReply(bytes, timestamp, aid, traceSequence)
  }
  setPrk80DeferHostPoll(mode: number) {
    if (!this.workerRadio) this.assertEmulator().setPrk80DeferHostPoll(mode)
  }
  setGreetingTrace(enabled: boolean) {
    this.assertEmulator().setGreetingTrace(enabled)
  }
  drainGreetingTrace() {
    return this.assertEmulator().drainGreetingTrace()
  }
  subscribeRadioOutput(listener: () => void) {
    this.radioOutputListeners.add(listener)
    return () => this.radioOutputListeners.delete(listener)
  }
  takeNativeWirelessOutgoingFrame() {
    if (!import.meta.env.DEV) throw new Error('PRK66 radio bridge is development-only.')
    return this.assertEmulator().prk66TakeOutgoing()
  }
  receiveNativeWirelessDevFrame(bytes: Uint8Array, timestamp: number) {
    if (!import.meta.env.DEV) throw new Error('PRK66 radio bridge is development-only.')
    return this.assertEmulator().prk66InjectIncoming(bytes, timestamp)
  }
  getNativeWirelessDevLinkCounters() {
    const emu = this.assertEmulator()
    return {
      outgoingEnqueued: emu.prk66TxQueued() >>> 0,
      incomingEnqueued: emu.prk66RxQueued() >>> 0,
      incomingConsumed: emu.prk66RxConsumed() >>> 0,
      dropped: emu.prk66FramesDropped() >>> 0,
      mpRepliesTx: emu.prk79ReplyTx() >>> 0,
      mpRepliesQueued: emu.prk79ReplyRx() >>> 0,
      mpReplyHostPolls: emu.prk79HostPoll() >>> 0,
      mpReplyHostMatched: emu.prk79HostMatch() >>> 0,
      mpReplyStale: emu.prk79Stale() >>> 0,
      mpReplyEmpty: emu.prk79Empty() >>> 0,
      mpHostEmptyPoll: emu.prk80EmptyPoll() >>> 0,
      mpHostMissPoll: emu.prk80MissPoll() >>> 0,
      mpHostPendingMiss: emu.prk80PendingMiss() >>> 0,
      mpHostFutureMatch: emu.prk80FutureMatch() >>> 0,
      mpHostAckFail: emu.prk80AckFail() >>> 0,
      mpHostAckOk: emu.prk80AckOk() >>> 0,
      firmwareRoleApplied: emu.prk71AppliedFirmwareMacRole() >>> 0,
      // PRK72: TX raw-radio callbacks vs native RX-ring/IRQ deliveries.
      // One counter per frame type, no packet data exposed.
      handshakeStages: Array.from({ length: 11 }, (_, kind) => ({
        kind, sent: emu.prk72TxKind(kind) >>> 0,
        receivedByHardware: emu.prk72RxKind(kind) >>> 0,
      })),
      // PRK67: exact native receiver acceptance checks, after PRK66 dequeue.
      wifiAccepted: emu.prk67RxAccepted() >>> 0,
      wifiBadLength: emu.prk67RxBadLength() >>> 0,
      wifiBadChannel: emu.prk67RxBadChannel() >>> 0,
      wifiMpFiltered: emu.prk67RxMpFiltered() >>> 0,
      wifiBeaconsAccepted: emu.prk67RxBeacon() >>> 0,
      wifiAssociationAccepted: emu.prk67RxAssocAccepted() >>> 0,
      // PRK69: only aggregate per-channel counts, never MACs or payloads.
      radioCurrentChannel: emu.prk69CurrentChannel() >>> 0,
      radioChannelChanges: emu.prk69ChannelChanges() >>> 0,
      // PRK70: receiver hardware paths; only counts, never MAC addresses.
      rxBeaconSameLocalMac: emu.prk70BeaconSameMac() >>> 0,
      rxBeaconDifferentLocalMac: emu.prk70BeaconDifferentMac() >>> 0,
      rxNativeCompleted: emu.prk70NativeRxFinished() >>> 0,
      rxDestinationRejected: emu.prk70DestFiltered() >>> 0,
      rxWepRejected: emu.prk70WepFiltered() >>> 0,
      rxBeaconBssidMatched: emu.prk70BeaconBssidMatched() >>> 0,
      rxBeaconHardwareFiltered: emu.prk70BeaconFilterDropped() >>> 0,
      rxNativeRingIrq: emu.prk70RxRingIrq() >>> 0,
      radioChannels: Array.from({ length: 15 }, (_, channel) => ({
        channel,
        tx: emu.prk69TxChannel(channel) >>> 0,
        accepted: emu.prk69AcceptedChannel(channel) >>> 0,
        rejected: emu.prk69WrongChannel(channel) >>> 0,
        tuned: emu.prk69TunedChannel(channel) >>> 0,
      })),
    }
  }

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

    if (this.workerRadio && (!crossOriginIsolated || !emulator.pokerunStartFrame ||
        !emulator.pokerunFramePending || !emulator.pokerunSetRadioWaiting)) {
      emulator.delete?.()
      throw new Error('Worker radio requires cross-origin isolation and POKERUN_NATIVE_WORKER_RADIO=1 at native build time.')
    }
    this.emulator = emulator
    this.cart = new module.WasmNdsCart()
    if (!this.cart.loadFromFile('/pokerun/roms/game.nds')) throw new Error('melonDS rejected this .nds ROM.')
    this.emulator.setSavePath(this.savePath)
    if (this.devWirelessFirmwareRole) {
      // Firmware identity is set BEFORE melonDS generates firmware and before
      // direct boot copies its header to emulated DS memory.
      if (!this.emulator.prk71SetFirmwareMacRole(this.devWirelessFirmwareRole)) {
        throw new Error('PRK71 could not assign the firmware MAC identity before boot.')
      }
    }
    this.emulator.loadFreeBIOS()
    if (this.devWirelessFirmwareRole &&
        this.emulator.prk71AppliedFirmwareMacRole() !== this.devWirelessFirmwareRole) {
      throw new Error('PRK71 firmware identity was not applied before ROM startup.')
    }
    if (!this.emulator.loadRom(this.cart, false)) throw new Error('melonDS could not attach the ROM cartridge.')
    this.status = 'loaded'
  }

  async start() {
    if (!this.emulator) throw new Error('Load a DS ROM before starting melonDS.')
    this.emulator.initialize(true)
    this.status = 'running'; this.running = true; this.scheduleFrame()
  }
  async pause() {
    if (this.status === 'running') {
      this.running = false
      if (this.frame) cancelAnimationFrame(this.frame)
      this.frame = null
      this.lastFrameAt = 0
      this.frameAccumulator = 0
      this.status = 'paused'
      if (this.workerRadio) {
        if (this.workerFrameTimer !== null) window.clearTimeout(this.workerFrameTimer)
        this.workerFrameTimer = null
        this.workerNextFrameAt = 0
        this.emulator?.pokerunSetRadioWaiting?.(false)
        await this.waitForWorkerFrame()
      }
    }
  }
  async resume() { if (this.status === 'paused') { this.running = true; this.status = 'running'; this.scheduleFrame() } }
  async reset() { if (!this.emulator) return; await this.pause(); this.emulator.initialize(true); await this.resume() }

  async exportBatterySave() {
    if (this.emulator?.pokerunFramePending?.()) await this.waitForWorkerFrame()
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
    await this.pause()
    await this.flushBatterySave()
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
  async read8(address: number) { if (this.emulator?.pokerunFramePending?.()) await this.waitForWorkerFrame(); return this.assertEmulator().readArm9U8(this.assertAddress(address)) >>> 0 }
  async read16(address: number) { if (this.emulator?.pokerunFramePending?.()) await this.waitForWorkerFrame(); return this.assertEmulator().readArm9U16(this.assertAddress(address)) >>> 0 }
  async read32(address: number) { if (this.emulator?.pokerunFramePending?.()) await this.waitForWorkerFrame(); return this.assertEmulator().readArm9U32(this.assertAddress(address)) >>> 0 }
  async readBytes(address: number, length: number) {
    if (!Number.isInteger(length) || length < 0 || length > 0x10000) throw new Error('DS memory reads must be 0–65536 bytes.')
    this.assertAddress(address); const bytes = new Uint8Array(length)
    for (let offset = 0; offset < length; offset += 1) bytes[offset] = await this.read8(address + offset)
    return bytes
  }

  async write8(address: number, value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new Error('ARM9 8-bit writes require a value from 0 to 255.')
    if (this.emulator?.pokerunFramePending?.()) await this.waitForWorkerFrame()
    this.assertEmulator().writeArm9U8(this.assertAddress(address), value)
  }
  async write16(address: number, value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error('ARM9 16-bit writes require a value from 0 to 65535.')
    if (this.emulator?.pokerunFramePending?.()) await this.waitForWorkerFrame()
    this.assertEmulator().writeArm9U16(this.assertAddress(address), value)
  }
  async write32(address: number, value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error('ARM9 32-bit writes require an unsigned 32-bit value.')
    if (this.emulator?.pokerunFramePending?.()) await this.waitForWorkerFrame()
    this.assertEmulator().writeArm9U32(this.assertAddress(address), value >>> 0)
  }
  async writeBytes(address: number, bytes: Uint8Array) {
    if (bytes.length > 0x10000) throw new Error('DS memory writes must be 0–65536 bytes.')
    this.assertAddress(address)
    for (let offset = 0; offset < bytes.length; offset += 1) await this.write8(address + offset, bytes[offset])
  }

  async getArm9Sp() {
    if (this.emulator?.pokerunFramePending?.()) await this.waitForWorkerFrame()
    return this.assertEmulator().getArm9Sp() >>> 0
  }

  async callArm9Thumb4(functionAddress: number, r0 = 0, r1 = 0, r2 = 0, r3 = 0, stackReserve = 0x1000): Promise<Arm9NativeCallResult> {
    this.assertAddress(functionAddress)
    const args = [r0, r1, r2, r3]
    if (args.some(value => !Number.isInteger(value) || value < 0 || value > 0xffffffff)) throw new Error('ARM9 native-call arguments must be unsigned 32-bit values.')
    if (!Number.isInteger(stackReserve) || stackReserve < 0x100 || stackReserve > 0x4000 || stackReserve % 8 !== 0) throw new Error('ARM9 native-call stack reserve must be 0x100–0x4000 bytes and 8-byte aligned.')
    if (this.emulator?.pokerunFramePending?.()) await this.waitForWorkerFrame()
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
  private async waitForWorkerFrame() {
    while (this.emulator?.pokerunFramePending?.()) {
      await new Promise<void>(resolve => window.setTimeout(resolve, 0))
    }
  }
  private scheduleWorkerFrame() {
    if (!this.running || !this.emulator || this.workerFrameTimer !== null) return
    const interval = 1000 / 60
    const now = performance.now()
    this.workerNextFrameAt = Math.max(this.workerNextFrameAt, now - interval)
    this.workerFrameTimer = window.setTimeout(() => {
      this.workerFrameTimer = null
      if (!this.running || !this.emulator) return
      this.emulator.setInput(this.inputMask)
      if (this.emulator.pokerunStartFrame?.()) this.workerNextFrameAt += interval
    }, Math.max(0, this.workerNextFrameAt - now))
  }

  private completeWorkerFrame(elapsed: number) {
    if (!this.running || !this.workerRadio || this.emulator?.pokerunFramePending?.()) return
    this.frameStats.frames++
    this.frameStats.visibleFrames++
    this.frameStats.batches++
    this.frameStats.processMs += elapsed
    this.frameStats.visibleProcessMs += elapsed
    this.frameStats.batchMs += elapsed
    this.draw()
    this.notifyEmulatedFrame()
    this.scheduleWorkerFrame()
  }
  private scheduleFrame() {
    if (this.workerRadio) {
      this.workerNextFrameAt = performance.now()
      this.scheduleWorkerFrame()
      return
    }
    this.frame = requestAnimationFrame(now => {
      if (!this.running || !this.emulator) return
      this.frameStats.rafCallbacks += 1
      const frameInterval = 1000 / 60

      if (this.lastFrameAt === 0) {
        this.lastFrameAt = now
        this.frameAccumulator = frameInterval
      } else {
        const elapsed = Math.max(0, now - this.lastFrameAt)
        this.lastFrameAt = now

        // Preserve fractional rAF timing without allowing a large catch-up backlog.
        this.frameAccumulator = Math.min(
          this.frameAccumulator + elapsed,
          frameInterval * 2,
        )
      }

      if (this.frameAccumulator >= frameInterval) {
        // Run at most one emulator batch per browser callback.
        this.frameAccumulator %= frameInterval

        const batchStart = performance.now()
        this.emulator.setInput(this.inputMask)
        for (let index = 0; index < this.speedMultiplier; index += 1) {
          const hidden = index < this.speedMultiplier - 1
          const frameStart = performance.now()
          this.emulator.processFrame(hidden)
          const processMs = performance.now() - frameStart
          this.frameStats.processMs += processMs
          this.frameStats.frames += 1
          if (hidden) {
            this.frameStats.hiddenFrames += 1
            this.frameStats.hiddenProcessMs += processMs
          } else {
            this.frameStats.visibleFrames += 1
            this.frameStats.visibleProcessMs += processMs
          }
        }
        this.frameStats.batches += 1
        this.frameStats.batchMs += performance.now() - batchStart
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
    window.WebMelon = { _internal: { events: { onEmulatorFrameUpdate: () => { this.draw(); this.notifyEmulatedFrame() }, onSaveWrite: () => this.scheduleBatterySaveExport(), onWorkerFrame: (elapsed: number) => this.completeWorkerFrame(elapsed), onRadioOutput: () => { for (const listener of this.radioOutputListeners) listener() }, onRumbleStart: () => undefined, onRumbleStop: () => undefined, onShutdown: () => { void this.pause() } } } }
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