import type { Platform } from '../../types'

export type EmulatorStatus = 'idle' | 'loaded' | 'running' | 'paused' | 'stopped'

/**
 * The only API PokéRun's core is allowed to use to talk to an emulator.
 * mGBA, melonDS, and development mocks should all implement this contract.
 */
export interface EmulatorBridge {
  readonly platform: Platform
  readonly status: EmulatorStatus

  loadRom(rom: ArrayBuffer): Promise<void>
  start(): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  reset(): Promise<void>

  /** Read raw emulated memory. Game adapters translate these bytes into Pokémon state. */
  readMemory(address: number, length: number): Promise<Uint8Array>

  /** Canonical in-game battery save. Save states are intentionally a separate future API. */
  exportBatterySave(): Promise<Uint8Array | null>
  importBatterySave(save: Uint8Array): Promise<void>

  dispose(): Promise<void>
}
