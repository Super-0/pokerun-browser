import type { GameId, Platform } from '../../types'

export type RomSourceProviderId = 'google-drive' | 'local'

export interface RomSourceReference {
  provider: RomSourceProviderId
  fileId?: string
  fileName: string
  size: number
  extension: string
  platform: Platform
  modifiedTime?: string
}

export interface RomLibraryManifest {
  version: 1
  games: Partial<Record<GameId, RomSourceReference>>
}

export const emptyRomLibraryManifest = (): RomLibraryManifest => ({
  version: 1,
  games: {},
})
