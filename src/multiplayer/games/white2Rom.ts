import type { LoadedRom } from '../../core/rom/RomLoader'
import type { MultiplayerRomIdentity } from '../core/protocol'

const decoder = new TextDecoder('ascii')
function headerText(bytes: Uint8Array, start: number, length: number) { return decoder.decode(bytes.slice(start, start + length)).replaceAll('\0', '').trim() }

/** Header validation is deliberately conservative: it proves a Gen-5 White 2-looking cart, not a universal supported revision. */
export function identifyWhite2Rom(rom: LoadedRom): MultiplayerRomIdentity {
  const title = headerText(rom.bytes, 0, 12)
  const gameCode = headerText(rom.bytes, 0x0c, 4)
  const looksLikeWhite2 = /^POKEMON\s+W2$/i.test(title) && /^IR.D$/i.test(gameCode)
  return {
    gameId: 'white2', fileName: rom.fileName, sha256: rom.sha256, title, gameCode,
    status: looksLikeWhite2 ? 'verified' : 'unsupported',
  }
}
