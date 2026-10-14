import type { GameDefinition } from '../../types'
import { fingerprintRom, type LoadedRom } from './RomLoader'

interface DevelopmentRomDefinition {
  url: string
  fileName: string
  extension: string
}

const developmentRoms: Partial<Record<GameDefinition['id'], DevelopmentRomDefinition>> = {
  emerald: {
    url: '/dev-roms/emerald.gba',
    fileName: 'emerald.gba',
    extension: '.gba',
  },
}

export function hasDevelopmentRom(game: GameDefinition) {
  return import.meta.env.DEV && Boolean(developmentRoms[game.id])
}

export async function loadDevelopmentRom(game: GameDefinition): Promise<LoadedRom | null> {
  if (!import.meta.env.DEV) return null

  const definition = developmentRoms[game.id]
  if (!definition) return null

  try {
    const response = await fetch(definition.url, { cache: 'no-store' })
    if (!response.ok) return null

    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('text/html')) return null

    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0) return null

    return {
      fileName: definition.fileName,
      size: bytes.byteLength,
      platform: game.platform,
      extension: definition.extension,
      sha256: await fingerprintRom(bytes),
      bytes,
    }
  } catch {
    return null
  }
}
