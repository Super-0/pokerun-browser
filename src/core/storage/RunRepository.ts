import type { RunState } from '../../types'

export interface RunRepository {
  list(): RunState[]
  get(id: string): RunState | null
  save(run: RunState): void
  saveAll(runs: RunState[]): void
  remove(id: string): void
}

const DEFAULT_KEY = 'pokerun:runs:v1'

/**
 * Browser-only implementation for the prototype. Keeping it behind an interface
 * lets us move to IndexedDB/cloud sync without changing screen code.
 */
export class LocalStorageRunRepository implements RunRepository {
  constructor(private readonly key = DEFAULT_KEY) {}

  list(): RunState[] {
    try {
      const raw = localStorage.getItem(this.key)
      return raw ? JSON.parse(raw) as RunState[] : []
    } catch {
      return []
    }
  }

  get(id: string) {
    return this.list().find(run => run.id === id) ?? null
  }

  save(run: RunState) {
    const runs = this.list()
    const index = runs.findIndex(candidate => candidate.id === run.id)
    if (index >= 0) runs[index] = run
    else runs.push(run)
    this.saveAll(runs)
  }

  saveAll(runs: RunState[]) {
    localStorage.setItem(this.key, JSON.stringify(runs))
  }

  remove(id: string) {
    this.saveAll(this.list().filter(run => run.id !== id))
  }
}

export const runRepository = new LocalStorageRunRepository()
