import type { PartyMember, RunState } from '../../types'
import type { EmulatorBridge } from '../emulator/EmulatorBridge'
import type { GameSnapshot, GameStateAdapter } from '../game/GameStateAdapter'

export type RunEvent =
  | { type: 'map_changed'; from: string; to: string }
  | { type: 'party_changed' }
  | { type: 'pokemon_fainted'; member: PartyMember }
  | { type: 'badges_changed'; from: number; to: number }
  | { type: 'wild_encounter_started'; species: string }
  | { type: 'battle_ended' }

export interface RunSyncResult {
  run: RunState
  snapshot: GameSnapshot
  events: RunEvent[]
}

function partyChanged(a: PartyMember[], b: PartyMember[]) {
  return JSON.stringify(a) !== JSON.stringify(b)
}

/**
 * Converts live emulator state into stable Nuzlocke run state.
 * This is the seam between game-specific memory parsing and the React UI.
 */
export class RunEngine {
  private previousSnapshot: GameSnapshot | null

  constructor(
    private readonly adapter: GameStateAdapter,
    private readonly emulator: EmulatorBridge,
    initialSnapshot: GameSnapshot | null = null,
  ) {
    this.previousSnapshot = initialSnapshot
  }

  async sync(currentRun: RunState): Promise<RunSyncResult> {
    const snapshot = await this.adapter.readSnapshot(this.emulator)
    const previous = this.previousSnapshot
    const events: RunEvent[] = []

    let next: RunState = {
      ...currentRun,
      currentMap: snapshot.mapName,
      badges: snapshot.badges,
      party: snapshot.party.map(member => ({ ...member })),
      playTimeSeconds: snapshot.playTimeSeconds ?? currentRun.playTimeSeconds,
      updatedAt: new Date().toISOString(),
    }

    if (previous) {
      if (previous.mapName !== snapshot.mapName) {
        events.push({ type: 'map_changed', from: previous.mapName, to: snapshot.mapName })
        next = { ...next, encounterStatus: 'AVAILABLE', encounterSpecies: undefined }
      }

      if (partyChanged(previous.party, snapshot.party)) {
        events.push({ type: 'party_changed' })
      }

      for (const member of snapshot.party) {
        const old = previous.party.find(candidate => candidate.id === member.id)
        if (old && old.hp > 0 && member.hp === 0) {
          events.push({ type: 'pokemon_fainted', member })
          next = { ...next, deaths: next.deaths + 1 }
        }
      }

      if (previous.badges !== snapshot.badges) {
        events.push({ type: 'badges_changed', from: previous.badges, to: snapshot.badges })
      }

      if (previous.battle.kind === 'none' && snapshot.battle.kind === 'wild' && snapshot.battle.opponentSpecies) {
        events.push({ type: 'wild_encounter_started', species: snapshot.battle.opponentSpecies })
        if (next.encounterStatus === 'AVAILABLE') {
          next = {
            ...next,
            encounterStatus: 'IN_PROGRESS',
            encounterSpecies: snapshot.battle.opponentSpecies,
          }
        }
      }

      if (previous.battle.kind !== 'none' && snapshot.battle.kind === 'none') {
        events.push({ type: 'battle_ended' })
      }
    }

    this.previousSnapshot = snapshot
    return { run: next, snapshot, events }
  }

  resetBaseline(snapshot: GameSnapshot | null = null) {
    this.previousSnapshot = snapshot
  }
}
