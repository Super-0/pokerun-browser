/**
 * PKHeX.Everywhere integration, isolated from the emulator and run stores.
 * The runtime loads only when the Save Editor is opened and a file is chosen.
 *
 * Dependency: @pkhex-everywhere/engine, GPL-3.0-or-later. See docs/SAVE_EDITOR.md.
 */
import { createEngine, draftHandle } from '@pkhex-everywhere/engine'
import type { BoxEntry, PokemonHandle, PokemonSummary, SaveSummary, TrainerCard } from '@pkhex-everywhere/engine'

let engine: ReturnType<typeof createEngine> | null = null

function client() {
  engine ??= createEngine({ lazy: true })
  return engine
}

export interface EditorSnapshot {
  save: SaveSummary
  trainer: TrainerCard
  party: PokemonSummary[]
  boxes: BoxEntry[]
  boxed: PokemonSummary[]
}

export async function closeEditorSave() {
  if (engine) await engine.game.close()
}

export async function readEditorSnapshot(): Promise<EditorSnapshot> {
  const current = client()
  const save = await current.game.get()
  if (!save || save.generation < 1 || save.generation > 5) {
    throw new Error('Only Generation I–V Pokémon saves are supported by PokéRun.')
  }
  const [trainer, party, boxes, boxed] = await Promise.all([
    current.trainer.get(),
    current.party.get(),
    current.box.list(),
    current.box.get(),
  ])
  return { save, trainer, party, boxes, boxed }
}

/** PKHeX verifies game-specific formats and checksum handling. */
export async function loadEditorSave(file: File): Promise<EditorSnapshot> {
  if (!file.size || file.size > 8 * 1024 * 1024) {
    throw new Error('Choose a non-empty battery save up to 8 MiB.')
  }
  const current = client()
  await current.game.close()
  await current.game.load(file)
  try {
    return await readEditorSnapshot()
  } catch (error) {
    await current.game.close()
    throw error
  }
}

export async function editTrainer(fields: { name?: string, money?: number }) {
  const current = client()
  const before = await current.trainer.get()
  if (fields.name !== undefined) {
    const name = fields.name.trim()
    if (!name || name.length > before.maxNameLength) {
      throw new Error('Trainer name must be between 1 and ' + before.maxNameLength + ' characters.')
    }
    if (before.name !== name) await current.trainer.setName(name)
  }
  if (fields.money !== undefined) {
    if (before.money === null) throw new Error('This game has no editable money field.')
    if (!Number.isSafeInteger(fields.money) || fields.money < 0 || fields.money > 999999) {
      throw new Error('Money must be a whole number from 0 to 999,999.')
    }
    if (before.money !== fields.money) await current.trainer.setMoney(fields.money)
  }
  return readEditorSnapshot()
}

export async function editPokemon(
  handle: PokemonHandle,
  changes: { nickname: string, level: number },
): Promise<EditorSnapshot> {
  if (!Number.isSafeInteger(changes.level) || changes.level < 1 || changes.level > 100) {
    throw new Error('Pokémon level must be between 1 and 100.')
  }
  if (changes.nickname.length > 10) {
    throw new Error('Nickname must be 10 characters or fewer for Generation I–V compatibility.')
  }
  const current = client()
  const summary = await current.pokemon.get(handle)
  if (!summary.editable || summary.isUnknown) {
    throw new Error('This Pokémon cannot safely be edited.')
  }
  await current.pokemon.edit(handle)
  await current.pokemon.update(draftHandle, {
    nickname: changes.nickname.trim(),
    level: changes.level,
  })
  await current.pokemon.commit()
  return readEditorSnapshot()
}

export async function exportEditorSave() {
  return client().game.export()
}
