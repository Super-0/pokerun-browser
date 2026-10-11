import type { GameDefinition, GameId } from '../../types'
import { getGameRuntimeSupport } from '../game/gameSupport'
import { type LoadedRom } from './RomLoader'
import { emptyRomLibraryManifest, type RomLibraryManifest, type RomSourceReference } from './RomSource'

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata'
const MANIFEST_NAME = 'pokerun-library.json'

interface GoogleTokenResponse {
  access_token?: string
  error?: string
  error_description?: string
}

interface GoogleTokenClient {
  requestAccessToken(options?: { prompt?: string }): void
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(options: {
            client_id: string
            scope: string
            callback: (response: GoogleTokenResponse) => void
          }): GoogleTokenClient
        }
      }
    }
  }
}

let googleScriptPromise: Promise<void> | null = null

function loadGoogleIdentityServices() {
  if (window.google?.accounts?.oauth2) return Promise.resolve()
  if (googleScriptPromise) return googleScriptPromise

  googleScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-pokerun-google-identity]')
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('Google Identity Services failed to load.')), { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.dataset.pokerunGoogleIdentity = 'true'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Google Identity Services failed to load.'))
    document.head.appendChild(script)
  })

  return googleScriptPromise
}

function extensionOf(fileName: string) {
  const dot = fileName.lastIndexOf('.')
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : ''
}

interface DriveFile {
  id: string
  name: string
  size?: string
  modifiedTime?: string
}

interface DriveFileList {
  files?: DriveFile[]
  nextPageToken?: string
}

export class GoogleDriveRomProvider {
  readonly id = 'google-drive' as const
  private accessToken: string | null = null
  private tokenClient: GoogleTokenClient | null = null

  get configured() {
    return Boolean(import.meta.env.VITE_GOOGLE_CLIENT_ID)
  }

  get connected() {
    return Boolean(this.accessToken)
  }

  async connect() {
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined
    if (!clientId) {
      throw new Error('Google Drive is not configured yet. Add VITE_GOOGLE_CLIENT_ID to your .env file.')
    }

    await loadGoogleIdentityServices()
    if (!window.google?.accounts?.oauth2) throw new Error('Google Identity Services is unavailable.')

    if (!this.tokenClient) {
      this.tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: DRIVE_SCOPE,
        callback: () => undefined,
      })
    }

    await new Promise<void>((resolve, reject) => {
      if (!this.tokenClient || !window.google?.accounts?.oauth2) return reject(new Error('Google Drive sign-in is unavailable.'))

      this.tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: DRIVE_SCOPE,
        callback: response => {
          if (response.error || !response.access_token) {
            reject(new Error(response.error_description || response.error || 'Google Drive authorization failed.'))
            return
          }
          this.accessToken = response.access_token
          resolve()
        },
      })

      this.tokenClient.requestAccessToken({ prompt: this.accessToken ? '' : 'consent' })
    })
  }

  disconnect() {
    this.accessToken = null
  }

  async listRomCandidates(game: GameDefinition): Promise<RomSourceReference[]> {
    this.requireToken()
    const runtime = getGameRuntimeSupport(game.id)
    const results: DriveFile[] = []
    let pageToken: string | undefined

    do {
      const params = new URLSearchParams({
        q: 'trashed = false',
        spaces: 'drive',
        pageSize: '1000',
        fields: 'nextPageToken,files(id,name,size,modifiedTime)',
      })
      if (pageToken) params.set('pageToken', pageToken)

      const response = await this.driveFetch<DriveFileList>(`https://www.googleapis.com/drive/v3/files?${params}`)
      results.push(...(response.files ?? []))
      pageToken = response.nextPageToken
    } while (pageToken)

    return results
      .filter(file => runtime.acceptedRomExtensions.includes(extensionOf(file.name)))
      .map(file => ({
        provider: 'google-drive',
        fileId: file.id,
        fileName: file.name,
        size: Number(file.size ?? 0),
        extension: extensionOf(file.name),
        platform: game.platform,
        modifiedTime: file.modifiedTime,
      }))
      .sort((a, b) => a.fileName.localeCompare(b.fileName))
  }

  async loadRom(reference: RomSourceReference, game: GameDefinition): Promise<LoadedRom> {
    const token = this.requireToken()
    if (!reference.fileId) throw new Error('This Google Drive ROM reference is missing a file ID.')

    const runtime = getGameRuntimeSupport(game.id)
    if (!runtime.acceptedRomExtensions.includes(reference.extension)) {
      throw new Error(`${game.title} expects ${runtime.acceptedRomExtensions.join(' or ')} ROM files.`)
    }

    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(reference.fileId)}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) throw new Error(`Google Drive could not download ${reference.fileName}.`)

    const bytes = new Uint8Array(await response.arrayBuffer())
    return {
      fileName: reference.fileName,
      size: bytes.byteLength,
      platform: game.platform,
      extension: reference.extension,
      bytes,
    }
  }

  async getLinkedRom(gameId: GameId) {
    const manifest = await this.readManifest()
    return manifest.games[gameId] ?? null
  }

  async linkRom(gameId: GameId, reference: RomSourceReference) {
    const manifest = await this.readManifest()
    manifest.games[gameId] = reference
    await this.writeManifest(manifest)
  }

  private requireToken() {
    if (!this.accessToken) throw new Error('Connect Google Drive first.')
    return this.accessToken
  }

  private async driveFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
    const token = this.requireToken()
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    })
    if (!response.ok) throw new Error(`Google Drive request failed (${response.status}).`)
    return response.json() as Promise<T>
  }

  private async findManifestFileId() {
    const params = new URLSearchParams({
      q: `name = '${MANIFEST_NAME}' and trashed = false`,
      spaces: 'appDataFolder',
      pageSize: '1',
      fields: 'files(id,name)',
    })
    const response = await this.driveFetch<{ files?: DriveFile[] }>(`https://www.googleapis.com/drive/v3/files?${params}`)
    return response.files?.[0]?.id ?? null
  }

  private async readManifest(): Promise<RomLibraryManifest> {
    const fileId = await this.findManifestFileId()
    if (!fileId) return emptyRomLibraryManifest()

    try {
      return await this.driveFetch<RomLibraryManifest>(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      )
    } catch {
      return emptyRomLibraryManifest()
    }
  }

  private async writeManifest(manifest: RomLibraryManifest) {
    const token = this.requireToken()
    let fileId = await this.findManifestFileId()

    if (!fileId) {
      const created = await this.driveFetch<{ id: string }>('https://www.googleapis.com/drive/v3/files?fields=id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: MANIFEST_NAME,
          parents: ['appDataFolder'],
          mimeType: 'application/json',
        }),
      })
      fileId = created.id
    }

    const response = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(manifest),
      },
    )

    if (!response.ok) throw new Error('PokéRun could not save the ROM library link to Google Drive.')
  }
}

export const googleDriveRomProvider = new GoogleDriveRomProvider()
