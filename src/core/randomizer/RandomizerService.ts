import type { GameId } from '../../types'

export interface RandomizerSettings {
  wildEncounters: boolean
  trainerPokemon: boolean
  starters: boolean
  abilities: boolean
}

export interface RandomizeRequest {
  gameId: GameId
  rom: ArrayBuffer
  seed: string
  settings: RandomizerSettings
}

export interface RandomizeResult {
  rom: ArrayBuffer
  seed: string
  settings: RandomizerSettings
}

/**
 * Randomization is deliberately isolated from emulation. A run gets a deterministic
 * ROM output first; the emulator only ever sees the resulting bytes.
 */
export interface RandomizerService {
  randomize(request: RandomizeRequest): Promise<RandomizeResult>
}

/** Placeholder used until the real Gen-specific randomizer pipeline is wired in. */
export class PassthroughRandomizerService implements RandomizerService {
  async randomize(request: RandomizeRequest): Promise<RandomizeResult> {
    return {
      rom: request.rom.slice(0),
      seed: request.seed,
      settings: { ...request.settings },
    }
  }
}
