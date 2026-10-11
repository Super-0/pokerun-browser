import type { GameId, PartyMember } from '../../types'
import type { EmulatorBridge } from '../emulator/EmulatorBridge'

export interface BattleSnapshot {
  kind: 'none' | 'wild' | 'trainer'
  opponentSpecies?: string
  trainerName?: string
}

export interface GameSnapshot {
  gameId: GameId
  capturedAt: number
  mapId: string
  mapName: string
  badges: number
  party: PartyMember[]
  battle: BattleSnapshot
  playTimeSeconds?: number
  money?: number
  levelCap?: number
  nextBoss?: string
}

/**
 * A game-state adapter knows what bytes mean for one game family.
 * UI code should never contain memory addresses or ROM-specific parsing logic.
 */
export interface GameStateAdapter {
  readonly id: string
  readonly supportedGames: readonly GameId[]
  readonly pollIntervalMs: number

  supports(gameId: GameId): boolean
  readSnapshot(emulator: EmulatorBridge): Promise<GameSnapshot>
}
