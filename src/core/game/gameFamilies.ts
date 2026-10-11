import type { GameId } from '../../types'

export type GameFamilyId =
  | 'gen1-rby'
  | 'gen2-gsc'
  | 'gen3-rse'
  | 'gen3-frlg'
  | 'gen4-dppt'
  | 'gen4-hgss'
  | 'gen5-bw'
  | 'gen5-b2w2'

export interface GameFamilyDefinition {
  id: GameFamilyId
  games: readonly GameId[]
  emulator: 'mgba' | 'melonds'
}

export const gameFamilies: readonly GameFamilyDefinition[] = [
  { id: 'gen1-rby', games: ['red', 'blue', 'yellow'], emulator: 'mgba' },
  { id: 'gen2-gsc', games: ['gold', 'silver', 'crystal'], emulator: 'mgba' },
  { id: 'gen3-rse', games: ['ruby', 'sapphire', 'emerald'], emulator: 'mgba' },
  { id: 'gen3-frlg', games: ['firered', 'leafgreen'], emulator: 'mgba' },
  { id: 'gen4-dppt', games: ['diamond', 'pearl', 'platinum'], emulator: 'melonds' },
  { id: 'gen4-hgss', games: ['heartgold', 'soulsilver'], emulator: 'melonds' },
  { id: 'gen5-bw', games: ['black', 'white'], emulator: 'melonds' },
  { id: 'gen5-b2w2', games: ['black2', 'white2'], emulator: 'melonds' },
]

export function getGameFamily(gameId: GameId): GameFamilyDefinition {
  const family = gameFamilies.find(candidate => candidate.games.includes(gameId))
  if (!family) throw new Error(`No game family registered for ${gameId}`)
  return family
}
