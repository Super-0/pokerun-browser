import type { LoadedRom } from './RomLoader'

const DB_NAME = 'pokerun-local'
const DB_VERSION = 1
const ROM_STORE = 'roms'

type StoredRom = Omit<LoadedRom, 'bytes'> & {
  runId: string
  bytes: Uint8Array | ArrayBuffer
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this browser.'))
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(ROM_STORE)) {
        database.createObjectStore(ROM_STORE, { keyPath: 'runId' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open PokéRun local storage.'))
  })
}

async function withRomStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void,
) {
  const database = await openDatabase()

  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(ROM_STORE, mode)
      const store = transaction.objectStore(ROM_STORE)
      action(store, resolve, reject)
      transaction.onerror = () => reject(transaction.error ?? new Error('PokéRun local storage transaction failed.'))
    })
  } finally {
    database.close()
  }
}

/**
 * Keeps ROM bytes in memory while a run is open and mirrors them into IndexedDB.
 * ROMs never leave the user's browser; persistence only makes saved runs resumable
 * after a refresh or later browser session on the same device/profile.
 */
class RomSessionStore {
  private readonly roms = new Map<string, LoadedRom>()

  set(runId: string, rom: LoadedRom) {
    this.roms.set(runId, rom)
    void this.persist(runId, rom).catch(error => {
      console.warn('Could not persist ROM locally. This run will still work for the current session.', error)
    })
  }

  get(runId: string) {
    return this.roms.get(runId) ?? null
  }

  async restore(runId: string) {
    const cached = this.get(runId)
    if (cached) return cached

    try {
      const stored = await withRomStore<StoredRom | null>('readonly', (store, resolve, reject) => {
        const request = store.get(runId)
        request.onsuccess = () => resolve((request.result as StoredRom | undefined) ?? null)
        request.onerror = () => reject(request.error)
      })

      if (!stored) return null

      const bytes = stored.bytes instanceof Uint8Array
        ? new Uint8Array(stored.bytes)
        : new Uint8Array(stored.bytes)

      const rom: LoadedRom = {
        fileName: stored.fileName,
        size: stored.size,
        platform: stored.platform,
        extension: stored.extension,
        bytes,
      }

      this.roms.set(runId, rom)
      return rom
    } catch (error) {
      console.warn('Could not restore ROM from local browser storage.', error)
      return null
    }
  }

  has(runId: string) {
    return this.roms.has(runId)
  }

  delete(runId: string) {
    this.roms.delete(runId)
    void withRomStore<void>('readwrite', (store, resolve, reject) => {
      const request = store.delete(runId)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    }).catch(error => console.warn('Could not remove persisted ROM.', error))
  }

  clear() {
    this.roms.clear()
    void withRomStore<void>('readwrite', (store, resolve, reject) => {
      const request = store.clear()
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    }).catch(error => console.warn('Could not clear persisted ROMs.', error))
  }

  private async persist(runId: string, rom: LoadedRom) {
    const stored: StoredRom = {
      runId,
      fileName: rom.fileName,
      size: rom.size,
      platform: rom.platform,
      extension: rom.extension,
      bytes: rom.bytes.slice(),
    }

    await withRomStore<void>('readwrite', (store, resolve, reject) => {
      const request = store.put(stored)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }
}

export const romSessionStore = new RomSessionStore()
