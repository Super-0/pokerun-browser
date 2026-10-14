import type { GameId } from '../../types'

export type MultiplayerGameStatus = 'experimental' | 'supported' | 'planned'
export interface MultiplayerGameDefinition { gameId: GameId; status: MultiplayerGameStatus; maxPlayers: number; adapterFamily: string }

export const multiplayerGames: readonly MultiplayerGameDefinition[] = [
  { gameId: 'white2', status: 'experimental', maxPlayers: 2, adapterFamily: 'gen5-b2w2' },
]
