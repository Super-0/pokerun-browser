import type { GameDefinition, Platform } from '../../types'
import { getGameRuntimeSupport } from '../game/gameSupport'

export interface RomMetadata {
  fileName: string
  size: number
  platform: Platform
  extension: string
  /** SHA-256 of local bytes; used for revision-safe adapters, never uploaded. */
  sha256: string
}

export interface LoadedRom extends RomMetadata {
  bytes: Uint8Array
}

export interface RomValidationResult {
  valid: boolean
  message: string
  metadata?: Omit<RomMetadata, 'sha256'>
}

function getExtension(fileName: string) {
  const dot = fileName.lastIndexOf('.')
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : ''
}

export function validateRomFile(file: File, game: GameDefinition): RomValidationResult {
  const runtime = getGameRuntimeSupport(game.id)
  const extension = getExtension(file.name)

  if (!runtime.acceptedRomExtensions.includes(extension)) {
    return {
      valid: false,
      message: `${game.title} expects ${runtime.acceptedRomExtensions.join(' or ')} ROM files.`,
    }
  }

  if (file.size === 0) {
    return { valid: false, message: 'That ROM file is empty.' }
  }

  return {
    valid: true,
    message: `${file.name} is ready to load locally.`,
    metadata: {
      fileName: file.name,
      size: file.size,
      platform: game.platform,
      extension,
    },
  }
}

export async function loadRomFile(file: File, game: GameDefinition): Promise<LoadedRom> {
  const validation = validateRomFile(file, game)
  if (!validation.valid || !validation.metadata) {
    throw new Error(validation.message)
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  return { ...validation.metadata, bytes, sha256: await fingerprintRom(bytes) }
}

export async function fingerprintRom(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function formatRomSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
