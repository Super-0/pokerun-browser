import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerPlayerState, MultiplayerRomIdentity } from '../core/protocol'

export const TESTED_WHITE2_SHA256 = '54bec4091ba3eb89f4e1ee4e2f3421005835804376a34e5e45f3157e1f55625a'
export const WHITE2_BASE_POINTER = 0x02000024
export const WHITE2_POSITION_OFFSET = 0x36780

const directionByValue = {
  0x00: 'north',
  0x40: 'west',
  0x80: 'south',
  0xc0: 'east',
} as const

export type White2LiveState = MultiplayerPlayerState & { z: number }

/**
 * Revision-specific White 2 live-state reader.
 *
 * These offsets were manually validated against TESTED_WHITE2_SHA256 using
 * controlled one-tile movement and an outside -> building map transition.
 * Raw memory knowledge stays here; generic multiplayer code only sees the
 * normalized MultiplayerPlayerState shape.
 */
export class White2LiveStateAdapter {
  constructor(private readonly bridge: MelonDsBridge) {}

  static supportsRom(rom: MultiplayerRomIdentity) {
    return rom.gameId === 'white2' && rom.sha256?.toLowerCase() === TESTED_WHITE2_SHA256
  }

  async read(): Promise<White2LiveState> {
    const base = await this.bridge.read32(WHITE2_BASE_POINTER)
    const position = (base + WHITE2_POSITION_OFFSET) >>> 0
    const [mapId, x, z, y, rawDirection] = await Promise.all([
      this.bridge.read16(position + 0x00),
      this.bridge.read16(position + 0x06),
      this.bridge.read16(position + 0x0a),
      this.bridge.read16(position + 0x0e),
      this.bridge.read8(position + 0x19),
    ])
    const direction = directionByValue[rawDirection as keyof typeof directionByValue]
    if (!direction) throw new Error(`Unsupported White 2 facing value 0x${rawDirection.toString(16).padStart(2, '0').toUpperCase()}.`)
    return { location: { mapId }, x, y, z, direction }
  }
}
