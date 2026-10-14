import type { RomMetadata } from '../core/rom/RomLoader'
import { DEFAULT_RUN_SETTINGS } from '../core/run/runSettings'
import { runRepository } from '../core/storage/RunRepository'
import type { GameId, RunSettings, RunState } from '../types'

export const starterParty = [
  { id: '1', species: 'Samurott', nickname: 'Samurott', level: 31, hp: 83, maxHp: 91, status: 'OK' as const },
  { id: '2', species: 'Crobat', nickname: 'Crobat', level: 30, hp: 74, maxHp: 74, status: 'OK' as const },
  { id: '3', species: 'Magneton', nickname: 'Magneton', level: 29, hp: 46, maxHp: 61, status: 'OK' as const },
  { id: '4', species: 'Krokorok', nickname: 'Krokorok', level: 30, hp: 72, maxHp: 72, status: 'OK' as const },
]

type LegacyRunState = RunState & {
  settings?: Partial<RunSettings>
  ruleset?: 'Standard' | 'Hardcore' | 'Custom'
}

function normalizeSettings(run: LegacyRunState): RunSettings {
  if (run.settings) return { ...DEFAULT_RUN_SETTINGS, ...run.settings }

  if (run.ruleset === 'Hardcore') {
    return {
      ...DEFAULT_RUN_SETTINGS,
      faintAsDeath: true,
      encounterTracking: true,
      levelCaps: true,
      encounterMode: 'FirstPerArea',
      runLogDetail: 'Detailed',
    }
  }

  if (run.ruleset === 'Standard') {
    return {
      ...DEFAULT_RUN_SETTINGS,
      faintAsDeath: true,
      encounterTracking: true,
      encounterMode: 'FirstPerArea',
    }
  }

  return { ...DEFAULT_RUN_SETTINGS }
}

/** Backward-compatible facade while screens are migrated onto repository APIs. */
export function loadRuns(): RunState[] {
  return runRepository.list().map(run => ({
    ...run,
    settings: normalizeSettings(run as LegacyRunState),
  }))
}

export function saveRuns(runs: RunState[]) {
  runRepository.saveAll(runs)
}

export function createRun(
  gameId: GameId,
  runType: RunState['runType'],
  settings: RunSettings,
  seed: string,
  rom?: RomMetadata,
): RunState {
  const now = new Date().toISOString()
  const prior = runRepository.list().filter(run => run.gameId === gameId)
  return {
    id: crypto.randomUUID(),
    gameId,
    createdAt: now,
    updatedAt: now,
    runNumber: prior.length + 1,
    runType,
    settings: { ...settings },
    seed,
    romLoaded: Boolean(rom),
    romFileName: rom?.fileName,
    romSize: rom?.size,
    romSha256: rom?.sha256,
    currentMap: gameId === 'black2' ? 'Route 6' : 'Starter Town',
    encounterStatus: 'AVAILABLE',
    badges: gameId === 'black2' ? 4 : 0,
    deaths: gameId === 'black2' ? 2 : 0,
    levelCap: gameId === 'black2' ? 33 : 14,
    nextBoss: gameId === 'black2' ? 'Clay' : 'First Gym',
    playTimeSeconds: gameId === 'black2' ? 13338 : 0,
    party: gameId === 'black2' ? starterParty.map(member => ({ ...member })) : [],
  }
}
