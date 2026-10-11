import { games } from '../../data/games'
import type { GameId, Platform } from '../../types'
import { getGameFamily, type GameFamilyId } from './gameFamilies'

export type EmulatorId = 'mgba' | 'melonds'
export type ScreenLayout = 'single' | 'dual'

export interface GameRuntimeSupport {
  gameId: GameId
  familyId: GameFamilyId
  emulator: EmulatorId
  platform: Platform
  acceptedRomExtensions: readonly string[]
  screenLayout: ScreenLayout
}

const extensionsByPlatform: Record<Platform, readonly string[]> = {
  GB: ['.gb'],
  GBC: ['.gbc'],
  GBA: ['.gba'],
  NDS: ['.nds'],
}

export const gameRuntimeSupport = Object.fromEntries(
  games.map(game => {
    const family = getGameFamily(game.id)
    const support: GameRuntimeSupport = {
      gameId: game.id,
      familyId: family.id,
      emulator: family.emulator,
      platform: game.platform,
      acceptedRomExtensions: extensionsByPlatform[game.platform],
      screenLayout: game.platform === 'NDS' ? 'dual' : 'single',
    }
    return [game.id, support]
  }),
) as Record<GameId, GameRuntimeSupport>

export function getGameRuntimeSupport(gameId: GameId): GameRuntimeSupport {
  const support = gameRuntimeSupport[gameId]
  if (!support) throw new Error(`No runtime support registered for ${gameId}`)
  return support
}

export function getSupportedGameIds(): GameId[] {
  return games.map(game => game.id)
}

export function assertAllGamesRegistered() {
  for (const game of games) {
    if (!gameRuntimeSupport[game.id]) {
      throw new Error(`Game ${game.id} is missing runtime support`)
    }
  }

  return true
}

assertAllGamesRegistered()
