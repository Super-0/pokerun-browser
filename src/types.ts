export type Platform = 'GB' | 'GBC' | 'GBA' | 'NDS'
export type Generation = 1 | 2 | 3 | 4 | 5

export type GameId =
  | 'red' | 'blue' | 'yellow'
  | 'gold' | 'silver' | 'crystal'
  | 'ruby' | 'sapphire' | 'emerald' | 'firered' | 'leafgreen'
  | 'diamond' | 'pearl' | 'platinum' | 'heartgold' | 'soulsilver'
  | 'black' | 'white' | 'black2' | 'white2'

export interface GameDefinition {
  id: GameId
  title: string
  shortTitle: string
  generation: Generation
  platform: Platform
  region: string
  theme: {
    sky: string
    skySoft: string
    accent: string
    accentDark: string
    ground: string
    water: string
    motif: 'field' | 'ocean' | 'mountain' | 'city' | 'forest' | 'sunset'
  }
}

export interface PartyMember {
  id: string
  species: string
  speciesId?: number
  nickname: string
  level: number
  hp: number
  maxHp: number
  status?: 'OK' | 'PSN' | 'PAR' | 'BRN' | 'SLP' | 'FRZ' | 'FAINTED'
}

export interface RunSettings {
  faintAsDeath: boolean
  encounterTracking: boolean
  levelCaps: boolean
  runLog: boolean
  deathHandling: 'Automatic' | 'Confirm'
  encounterMode: 'AllCatches' | 'FirstPerArea'
  levelCapMode: 'Gyms' | 'MajorBosses'
  runLogDetail: 'Major' | 'Detailed'
}

export interface RunState {
  id: string
  gameId: GameId
  createdAt: string
  updatedAt: string
  runNumber: number
  runType: 'Vanilla' | 'Randomized'
  settings: RunSettings
  seed: string
  romLoaded: boolean
  romFileName?: string
  romSize?: number
  currentMap: string
  encounterStatus: 'AVAILABLE' | 'IN_PROGRESS' | 'CAUGHT' | 'MISSED'
  encounterSpecies?: string
  badges: number
  deaths: number
  levelCap: number
  nextBoss: string
  playTimeSeconds: number
  party: PartyMember[]
}
