import type { LoadedRom } from './RomLoader'

/**
 * ROM bytes intentionally stay outside persisted RunState.
 * The browser keeps them in memory for the active session only.
 * A future IndexedDB implementation can replace this without changing screens.
 */
class RomSessionStore {
  private readonly roms = new Map<string, LoadedRom>()

  set(runId: string, rom: LoadedRom) {
    this.roms.set(runId, rom)
  }

  get(runId: string) {
    return this.roms.get(runId) ?? null
  }

  has(runId: string) {
    return this.roms.has(runId)
  }

  delete(runId: string) {
    this.roms.delete(runId)
  }

  clear() {
    this.roms.clear()
  }
}

export const romSessionStore = new RomSessionStore()
