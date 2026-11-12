import { inspectGen3Save, type Gen3SaveInfo } from './gen3Save'

export type SaveInspection =
  | {
      mode: 'editable'
      label: string
      detail: string
      family: 'gen3'
      info: Gen3SaveInfo
    }
  | {
      mode: 'read-only'
      label: string
      detail: string
      family: 'game-boy' | 'nintendo-ds' | 'gen3-unverified' | 'unknown'
    }

function gen3FooterCount(bytes: Uint8Array) {
  if (bytes.byteLength !== 0x20000) return 0
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let count = 0
  for (let sector = 0; sector < 28; sector++) {
    const offset = sector * 0x1000
    if (view.getUint32(offset + 0xFF8, true) === 0x08012025) count++
  }
  return count
}

function isDesmume(bytes: Uint8Array) {
  // DeSmuME's .dsv adds an emulator metadata footer after the DS save data.
  const tail = bytes.slice(Math.max(0, bytes.byteLength - 256))
  const marker = new TextEncoder().encode('DeSmuME Save')
  for (let i = 0; i <= tail.length - marker.length; i++) {
    if (marker.every((value, j) => tail[i + j] === value)) return true
  }
  return false
}

/**
 * Detect the format by data, not by filename. Unsupported formats are shown
 * read-only so the user can keep a backup without risking save corruption.
 */
export function inspectSave(bytes: Uint8Array): SaveInspection {
  const size = bytes.byteLength
  if (size === 0) throw new Error('This save file is empty.')
  if (size > 8 * 1024 * 1024) {
    throw new Error('This file is too large for the save editor (8 MiB maximum).')
  }

  if (size === 0x20000) {
    try {
      const info = inspectGen3Save(bytes)
      return {
        mode: 'editable',
        family: 'gen3',
        label: info.gameLabel,
        detail: 'Generation III • 128 KiB flash save • checksums verified',
        info,
      }
    } catch (cause) {
      const hasSignature = gen3FooterCount(bytes) >= 2
      const reason = cause instanceof Error ? cause.message : 'The save layout could not be verified.'
      return {
        mode: 'read-only',
        family: hasSignature ? 'gen3-unverified' : 'unknown',
        label: hasSignature ? 'Generation III save (unverified)' : '128 KiB battery save',
        detail: hasSignature
          ? reason
          : 'This file size is shared by multiple save formats. The game could not be determined safely.',
      }
    }
  }

  if (isDesmume(bytes)) {
    return {
      mode: 'read-only',
      family: 'nintendo-ds',
      label: 'Nintendo DS / DeSmuME save',
      detail: 'DeSmuME save container detected. Game-specific editing is not available yet.',
    }
  }

  if ([0x8000, 0x10000].includes(size)) {
    return {
      mode: 'read-only',
      family: 'game-boy',
      label: 'Game Boy–sized battery save',
      detail: 'File size suggests a GB/GBC save, but no game-specific signature was verified.',
    }
  }

  if ([0x40000, 0x80000, 0x100000].includes(size)) {
    return {
      mode: 'read-only',
      family: 'nintendo-ds',
      label: 'Nintendo DS–sized battery save',
      detail: 'File size suggests a DS save, but Diamond/Pearl/Platinum, HGSS and BW/B2W2 need distinct parsers.',
    }
  }

  return {
    mode: 'read-only',
    family: 'unknown',
    label: 'Unknown save format',
    detail: 'PokéRun could not safely identify this file. No editing controls are enabled.',
  }
}
