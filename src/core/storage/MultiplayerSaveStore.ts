import type { LoadedRom } from '../rom/RomLoader'
import { romSessionStore } from '../rom/RomSessionStore'
import type { MultiplayerRomIdentity } from '../../multiplayer/core/protocol'
import type { GameId } from '../../types'

const META_KEY = 'pokerun-multiplayer-save-profiles-v1'
const DB_NAME = 'pokerun-multiplayer-save-data'
const DB_VERSION = 1
const BATTERY_STORE = 'battery-saves'

export type MultiplayerSaveProfile = {
  id: string
  slotNumber: number
  gameId: GameId
  fileName: string
  romSha256: string
  /** Optional shared ROM source. Derived saves keep independent battery bytes. */
  romSourceProfileId?: string
  title?: string
  gameCode?: string
  createdAt: string
  updatedAt: string
  lastSavedAt?: string
}

type StoredBatterySave = { profileId: string; bytes: Uint8Array | ArrayBuffer }

function readProfiles(): MultiplayerSaveProfile[] {
  try {
    const raw = localStorage.getItem(META_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as MultiplayerSaveProfile[] : []
  } catch {
    return []
  }
}

function writeProfiles(profiles: MultiplayerSaveProfile[]) {
  localStorage.setItem(META_KEY, JSON.stringify(profiles))
}

function romKey(profileId: string) { return `multiplayer:${profileId}` }

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(BATTERY_STORE)) database.createObjectStore(BATTERY_STORE, { keyPath: 'profileId' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open multiplayer save storage.'))
  })
}

async function withBatteryStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void) {
  const database = await openDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(BATTERY_STORE, mode)
      let requestResolved = false
      let value: T
      // The IDB request's success event can fire before the transaction is
      // committed. A dev-harness reload at that instant can lose the imported
      // battery save. Only report success once the transaction is complete.
      transaction.oncomplete = () => {
        if (requestResolved) resolve(value)
        else reject(new Error('Multiplayer save transaction completed without a result.'))
      }
      transaction.onerror = () => reject(transaction.error ?? new Error('Multiplayer save transaction failed.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Multiplayer save transaction aborted.'))
      action(transaction.objectStore(BATTERY_STORE), result => {
        value = result
        requestResolved = true
      }, reject)
    })
  } finally {
    database.close()
  }
}

class MultiplayerSaveStore {
  list(gameId?: GameId) {
    return readProfiles()
      .filter(profile => !gameId || profile.gameId === gameId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  private createProfile(gameId: GameId, rom: LoadedRom, identity: MultiplayerRomIdentity, romSourceProfileId?: string) {
    const profiles = readProfiles()
    const now = new Date().toISOString()
    const slotNumber = Math.max(0, ...profiles.filter(profile => profile.gameId === gameId).map(profile => profile.slotNumber)) + 1
    const profile: MultiplayerSaveProfile = {
      id: crypto.randomUUID(),
      slotNumber,
      gameId,
      fileName: rom.fileName,
      romSha256: rom.sha256,
      ...(romSourceProfileId ? { romSourceProfileId } : {}),
      title: identity.title,
      gameCode: identity.gameCode,
      createdAt: now,
      updatedAt: now,
    }
    writeProfiles([...profiles, profile])
    // Only an independent ROM slot owns separate ROM bytes in IndexedDB.
    // Derived .sav profiles reuse an existing ROM and must never start a
    // second, unawaited 500 MB storage write just before a page reload.
    if (!romSourceProfileId) romSessionStore.set(romKey(profile.id), rom)
    return profile
  }

  create(gameId: GameId, rom: LoadedRom, identity: MultiplayerRomIdentity) {
    return this.createProfile(gameId, rom, identity)
  }

  /**
   * PRK63: a test save is independent of the source battery save, but it
   * references the source cartridge ROM rather than copying ROM bytes.
   * Resolving the chain to its oldest available root avoids alias chains.
   */
  createDerived(sourceProfileId: string, rom: LoadedRom, identity: MultiplayerRomIdentity) {
    const profiles = readProfiles()
    const source = profiles.find(profile => profile.id === sourceProfileId)
    if (!source || source.romSha256 !== rom.sha256 ||
        source.gameId !== identity.gameId || identity.status !== 'verified') {
      throw new Error('Cannot create a test save: the source ROM profile does not match.')
    }
    let root = source
    const visited = new Set<string>([root.id])
    while (root.romSourceProfileId) {
      const parent = profiles.find(profile => profile.id === root.romSourceProfileId)
      if (!parent || parent.romSha256 !== rom.sha256 || parent.gameId !== source.gameId ||
          visited.has(parent.id)) break
      root = parent
      visited.add(root.id)
    }
    return this.createProfile(source.gameId, rom, identity, root.id)
  }

  async restoreRom(profileId: string) {
    const profiles = readProfiles()
    const selected = profiles.find(profile => profile.id === profileId)
    if (!selected) return null
    const visited = new Set<string>()
    const resolve = async (id: string): Promise<LoadedRom | null> => {
      if (visited.has(id)) return null
      visited.add(id)
      const candidate = profiles.find(profile => profile.id === id)
      if (!candidate || candidate.gameId !== selected.gameId ||
          candidate.romSha256 !== selected.romSha256) return null
      if (candidate.romSourceProfileId) {
        const sourced = await resolve(candidate.romSourceProfileId)
        if (sourced) return sourced
      }
      const found = await romSessionStore.restore(romKey(id))
      return found?.sha256 === selected.romSha256 ? found : null
    }

    const existing = await resolve(profileId)
    if (existing) return existing

    // Recovery for test profiles created before PRK63's shared-ROM fix:
    // their local profile and .sav persisted, but the second ROM write could
    // be interrupted by reload. Find an older verified same-game ROM already
    // stored in this browser and remember it as the shared source.
    const candidates = profiles
      .filter(profile => profile.gameId === selected.gameId &&
        profile.romSha256 === selected.romSha256 && profile.id !== profileId)
      .sort((a, b) => a.slotNumber - b.slotNumber)
    for (const candidate of candidates) {
      const recovered = await resolve(candidate.id)
      if (!recovered) continue
      writeProfiles(readProfiles().map(profile =>
        profile.id === profileId
          ? { ...profile, romSourceProfileId: candidate.id }
          : profile,
      ))
      console.info('[PokéRun save] PRK63 RECOVERED SHARED ROM SOURCE', {
        repairedSlot: selected.slotNumber,
        sourceSlot: candidate.slotNumber,
        fingerprintMatched: true,
        batterySaveUnchanged: true,
      })
      return recovered
    }
    return null
  }

  async loadBatterySave(profileId: string) {
    try {
      const stored = await withBatteryStore<StoredBatterySave | null>('readonly', (store, resolve, reject) => {
        const request = store.get(profileId)
        request.onsuccess = () => resolve((request.result as StoredBatterySave | undefined) ?? null)
        request.onerror = () => reject(request.error)
      })
      if (!stored) return null
      return stored.bytes instanceof Uint8Array ? new Uint8Array(stored.bytes) : new Uint8Array(stored.bytes)
    } catch (error) {
      console.warn('Could not restore multiplayer battery save.', error)
      return null
    }
  }

  async saveBatterySave(profileId: string, bytes: Uint8Array) {
    await withBatteryStore<void>('readwrite', (store, resolve, reject) => {
      const request = store.put({ profileId, bytes: bytes.slice() } satisfies StoredBatterySave)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
    const profiles = readProfiles()
    const now = new Date().toISOString()
    writeProfiles(profiles.map(profile => profile.id === profileId ? { ...profile, updatedAt: now, lastSavedAt: now } : profile))
  }

  async delete(profileId: string) {
    writeProfiles(readProfiles().filter(profile => profile.id !== profileId))
    romSessionStore.delete(romKey(profileId))
    await withBatteryStore<void>('readwrite', (store, resolve, reject) => {
      const request = store.delete(profileId)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }
}

export const multiplayerSaveStore = new MultiplayerSaveStore()
