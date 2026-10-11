import type { GameId, RunState } from '../../types'
import type { EmulatorBridge } from '../emulator/EmulatorBridge'
import type { BattleSnapshot, GameSnapshot, GameStateAdapter } from './GameStateAdapter'
import { getGameFamily } from './gameFamilies'

function cloneSnapshot(snapshot: GameSnapshot): GameSnapshot {
  return {
    ...snapshot,
    party: snapshot.party.map(member => ({ ...member })),
    battle: { ...snapshot.battle },
  }
}

/**
 * Mutable development adapter used by the HUD simulator. The UI talks to it
 * through the same GameStateAdapter interface real memory parsers will use.
 */
export class MockGameStateAdapter implements GameStateAdapter {
  readonly id: string
  readonly supportedGames: readonly GameId[]
  readonly pollIntervalMs = 100
  private snapshot: GameSnapshot

  constructor(run: RunState) {
    const family = getGameFamily(run.gameId)
    this.id = `mock:${family.id}`
    this.supportedGames = family.games
    this.snapshot = {
      gameId: run.gameId,
      capturedAt: Date.now(),
      mapId: run.currentMap.toLowerCase().replace(/\s+/g, '-'),
      mapName: run.currentMap,
      badges: run.badges,
      party: run.party.map(member => ({ ...member })),
      battle: { kind: 'none' },
      playTimeSeconds: run.playTimeSeconds,
    }
  }

  supports(gameId: GameId) {
    return this.supportedGames.includes(gameId)
  }

  async readSnapshot(_emulator: EmulatorBridge) {
    this.snapshot.capturedAt = Date.now()
    return cloneSnapshot(this.snapshot)
  }

  peek() {
    return cloneSnapshot(this.snapshot)
  }

  enterMap(mapName: string) {
    this.snapshot.mapId = mapName.toLowerCase().replace(/\s+/g, '-')
    this.snapshot.mapName = mapName
    this.snapshot.battle = { kind: 'none' }
  }

  setBattle(battle: BattleSnapshot) {
    this.snapshot.battle = { ...battle }
  }

  damagePartyMember(index: number, damage: number) {
    const member = this.snapshot.party[index]
    if (!member) return
    member.hp = Math.max(0, member.hp - damage)
    if (member.hp === 0) member.status = 'FAINTED'
  }

  faintPartyMember(index: number) {
    const member = this.snapshot.party[index]
    if (!member) return
    member.hp = 0
    member.status = 'FAINTED'
  }

  earnBadge() {
    this.snapshot.badges = Math.min(8, this.snapshot.badges + 1)
  }

  tick(seconds = 1) {
    this.snapshot.playTimeSeconds = (this.snapshot.playTimeSeconds ?? 0) + seconds
  }
}
