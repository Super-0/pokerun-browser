import type { Platform } from '../../types'
import type { EmulatorBridge, EmulatorStatus } from './EmulatorBridge'

/**
 * Development-only emulator shell. It lets the rest of PokéRun be built before
 * mGBA/melonDS are connected, while preserving the same interface production uses.
 */
export class MockEmulatorBridge implements EmulatorBridge {
  status: EmulatorStatus = 'idle'
  private batterySave: Uint8Array | null = null

  constructor(public readonly platform: Platform) {}

  async loadRom(_rom: ArrayBuffer) {
    this.status = 'loaded'
  }

  async start() {
    this.status = 'running'
  }

  async pause() {
    if (this.status === 'running') this.status = 'paused'
  }

  async resume() {
    if (this.status === 'paused' || this.status === 'loaded') this.status = 'running'
  }

  async reset() {
    if (this.status !== 'idle') this.status = 'running'
  }

  async readMemory(_address: number, length: number) {
    return new Uint8Array(length)
  }

  async exportBatterySave() {
    return this.batterySave ? new Uint8Array(this.batterySave) : null
  }

  async importBatterySave(save: Uint8Array) {
    this.batterySave = new Uint8Array(save)
  }

  async dispose() {
    this.status = 'stopped'
  }
}
