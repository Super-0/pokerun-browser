import type { GameId, RunState } from '../types'

const KEY = 'pokerun:runs:v1'

export const starterParty = [
  { id: '1', species: 'Samurott', nickname: 'Samurott', level: 31, hp: 83, maxHp: 91, status: 'OK' as const },
  { id: '2', species: 'Crobat', nickname: 'Crobat', level: 30, hp: 74, maxHp: 74, status: 'OK' as const },
  { id: '3', species: 'Magneton', nickname: 'Magneton', level: 29, hp: 46, maxHp: 61, status: 'OK' as const },
  { id: '4', species: 'Krokorok', nickname: 'Krokorok', level: 30, hp: 72, maxHp: 72, status: 'OK' as const },
]

export function loadRuns(): RunState[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function saveRuns(runs: RunState[]) {
  localStorage.setItem(KEY, JSON.stringify(runs))
}

export function createRun(gameId: GameId, runType: RunState['runType'], ruleset: RunState['ruleset'], seed: string): RunState {
  const now = new Date().toISOString()
  const prior = loadRuns().filter(r => r.gameId === gameId)
  return {
    id: crypto.randomUUID(),
    gameId,
    createdAt: now,
    updatedAt: now,
    runNumber: prior.length + 1,
    runType,
    ruleset,
    seed,
    romLoaded: false,
    currentMap: gameId === 'black2' ? 'Route 6' : 'Starter Town',
    encounterStatus: 'AVAILABLE',
    badges: gameId === 'black2' ? 4 : 0,
    deaths: gameId === 'black2' ? 2 : 0,
    levelCap: gameId === 'black2' ? 33 : 14,
    nextBoss: gameId === 'black2' ? 'Clay' : 'First Gym',
    playTimeSeconds: gameId === 'black2' ? 13338 : 0,
    party: gameId === 'black2' ? starterParty : [],
  }
}
