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
      action(transaction.objectStore(BATTERY_STORE), resolve, reject)
      transaction.onerror = () => reject(transaction.error ?? new Error('Multiplayer save transaction failed.'))
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

  create(gameId: GameId, rom: LoadedRom, identity: MultiplayerRomIdentity) {
    const profiles = readProfiles()
    const now = new Date().toISOString()
    const slotNumber = Math.max(0, ...profiles.filter(profile => profile.gameId === gameId).map(profile => profile.slotNumber)) + 1
    const profile: MultiplayerSaveProfile = {
      id: crypto.randomUUID(),
      slotNumber,
      gameId,
      fileName: rom.fileName,
      romSha256: rom.sha256,
      title: identity.title,
      gameCode: identity.gameCode,
      createdAt: now,
      updatedAt: now,
    }
    writeProfiles([...profiles, profile])
    romSessionStore.set(romKey(profile.id), rom)
    return profile
  }

  async restoreRom(profileId: string) {
    return romSessionStore.restore(romKey(profileId))
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
