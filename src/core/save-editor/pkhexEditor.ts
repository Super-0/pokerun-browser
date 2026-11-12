/**
 * PKHeX.Everywhere integration, isolated from the emulator and run stores.
 * The runtime loads only when the Save Editor is opened and a file is chosen.
 *
 * Dependency: @pkhex-everywhere/engine, GPL-3.0-or-later. See docs/SAVE_EDITOR.md.
 */
import { createEngine, draftHandle } from '@pkhex-everywhere/engine'
import type { AddedPokemon, Badge, BoxEntry, Choice, EditablePokemon, EncounterRow, EncounterVersions, ExportedPokemon, FilePreview, GiftAlbum, GiftEvent, WonderCardPreview, GameProgress, PokemonHandle, PokemonOptions, PokemonPatch, PokemonSummary, Pouch, SaveSummary, SpeciesEntry, TrainerCard } from '@pkhex-everywhere/engine'

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


export interface PokemonEditorDetails {
  details: EditablePokemon
  options: PokemonOptions
  natures: Choice[]
  balls: Choice[]
}

export async function readPokemonEditorDetails(handle: PokemonHandle, generation: number): Promise<PokemonEditorDetails> {
  const current = client()
  const [details, options, natures, balls] = await Promise.all([
    current.pokemon.details(handle),
    current.pokemon.options(handle),
    generation >= 3 ? current.game.natures() : Promise.resolve([] as Choice[]),
    current.game.balls(),
  ])
  return { details, options, natures, balls }
}

/**
 * Limit writable fields to the ones this UI exposes. PKHeX checks the
 * per-game allowed values; this additional gate catches malformed UI input
 * before opening the draft.
 */
export async function applyPokemonPatch(handle: PokemonHandle, patch: PokemonPatch): Promise<EditorSnapshot> {
  const current = client()
  const editable = await current.pokemon.details(handle)
  const options = await current.pokemon.options(handle)
  if (!editable.editable || editable.isUnknown) throw new Error('This Pokémon cannot be edited.')
  const locked = new Set<string>(options.locked)
  const keys = Object.keys(patch)
  const permitted = new Set(['nickname', 'level', 'nature', 'ability', 'heldItem', 'moves', 'ivs', 'evs', 'friendship', 'species', 'form', 'gender', 'isShiny', 'isEgg', 'ball', 'originalTrainerName', 'trainerId', 'secretId', 'metLevel', 'metLocation', 'metDate', 'fatefulEncounter'])
  if (!keys.length || keys.some(key => !permitted.has(key) || locked.has(key))) {
    throw new Error('This game does not permit one of the requested Pokémon changes.')
  }
  if (patch.level != null && (!Number.isSafeInteger(patch.level) || patch.level < 1 || patch.level > 100)) {
    throw new Error('Level must be from 1 to 100.')
  }
  if (patch.friendship != null && (!Number.isSafeInteger(patch.friendship) || patch.friendship < 0 || patch.friendship > 255)) {
    throw new Error('Friendship must be from 0 to 255.')
  }
  if (patch.nickname !== undefined && patch.nickname !== null && patch.nickname.length > 10) {
    throw new Error('Nickname cannot exceed 10 characters.')
  }
  if (patch.species != null && !options.species.some(choice => choice.id === patch.species)) {
    throw new Error('Species changes are limited to this Pokémon’s evolution family.')
  }
  if (patch.form != null && !options.forms.some(choice => choice.id === patch.form)) {
    throw new Error('Form is not valid for this Pokémon.')
  }
  if (patch.gender !== undefined && !['male', 'female', 'genderless'].includes(patch.gender ?? '')) {
    throw new Error('Invalid Pokémon gender.')
  }
  if (patch.isShiny !== undefined && typeof patch.isShiny !== 'boolean') {
    throw new Error('Shiny status must be enabled or disabled.')
  }
  if (patch.isEgg !== undefined && typeof patch.isEgg !== 'boolean') {
    throw new Error('Egg status must be enabled or disabled.')
  }
  for (const key of ['trainerId', 'secretId'] as const) {
    const value = patch[key]
    if (value !== undefined && value !== null &&
      (!Number.isSafeInteger(value) || value < 0 || value > 65535)) {
      throw new Error('Trainer IDs must be whole numbers between 0 and 65535.')
    }
  }
  if (patch.originalTrainerName != null && patch.originalTrainerName.length > 12) {
    throw new Error('Original trainer name is too long.')
  }
  if (patch.metLevel != null &&
    (!Number.isSafeInteger(patch.metLevel) || patch.metLevel < 0 || patch.metLevel > 100)) {
    throw new Error('Met level must be from 0 to 100.')
  }
  if (patch.metDate && !/^20\d{2}-\d{2}-\d{2}$/.test(patch.metDate)) {
    throw new Error('Met date must use YYYY-MM-DD between 2000 and 2099.')
  }
  const allowedChoices: Array<[string, number | null | undefined, number[]]> = [
    ['ability', patch.ability, options.abilities.map(choice => choice.id)],
    ['heldItem', patch.heldItem, options.heldItems.map(choice => choice.id)],
    ['ball', patch.ball, (await current.game.balls()).map(choice => choice.id)],
    ['metLocation', patch.metLocation, options.metLocations.map(choice => choice.id)],
  ]
  // Gen I–II have no natures; don't query that catalog unless it is edited.
  if (patch.nature !== undefined && patch.nature !== null) {
    allowedChoices.push(['nature', patch.nature, (await current.game.natures()).map(choice => choice.id)])
  }
  for (const [field, value, ids] of allowedChoices) {
    if (value !== undefined && value !== null && !ids.includes(value)) {
      throw new Error('Invalid ' + field + ' for this game.')
    }
  }
  if (patch.moves && (patch.moves.length !== 4 || patch.moves.some(id =>
    !Number.isSafeInteger(id) || (id !== 0 && !options.moves.some(move => move.id === id))
  ))) throw new Error('Selected moves are not available for this Pokémon.')
  const validateStats = (stats: PokemonPatch['ivs'] | PokemonPatch['evs'], max: number, label: string) => {
    if (!stats) return
    for (const value of Object.values(stats)) {
      if (value == null) continue
      if (!Number.isSafeInteger(value) || value < 0 || value > max) {
        throw new Error(label + ' must be whole numbers from 0 to ' + max + '.')
      }
    }
  }
  const generation = (await current.game.get())?.generation ?? 3
  validateStats(patch.ivs, generation <= 2 ? 15 : 31, 'IVs')
  validateStats(patch.evs, generation <= 2 ? 65535 : 255, 'EVs')
  await current.pokemon.edit(handle)
  await current.pokemon.update(draftHandle, patch)
  await current.pokemon.commit()
  return readEditorSnapshot()
}

export async function readSaveProgress(): Promise<GameProgress> {
  return client().game.progress()
}

export async function readTrainerBadges(): Promise<Badge[] | null> {
  return client().trainer.badges()
}

export async function setTrainerBadges(earned: boolean[]): Promise<Badge[]> {
  const current = client()
  const existing = await current.trainer.badges()
  if (!existing || existing.length !== earned.length) {
    throw new Error('Badge editing is not available for this save.')
  }
  if (!earned.every(value => typeof value === 'boolean')) {
    throw new Error('Invalid badge selection.')
  }
  await current.trainer.setBadges(earned)
  const after = await current.trainer.badges()
  if (!after || after.length !== earned.length || after.some((badge, i) => badge.earned !== earned[i])) {
    throw new Error('Badge changes could not be verified.')
  }
  return after
}

export async function readSaveBag(): Promise<Pouch[]> {
  return client().inventory.get()
}

export async function setSaveBagItem(pouchName: string, itemId: number, count: number): Promise<Pouch[]> {
  const current = client()
  const bag = await current.inventory.get()
  const pouch = bag.find(item => item.name === pouchName)
  const entry = pouch?.items.find(item => item.id === itemId) ??
    pouch?.addable.find(item => item.id === itemId)
  if (!entry) throw new Error('This item is not available in the selected pouch.')
  if (!Number.isSafeInteger(count) || count < 0 || count > entry.maxCount) {
    throw new Error('Quantity must be between 0 and ' + entry.maxCount + '.')
  }
  await current.inventory.setItem({ pouch: pouchName, itemId }, count)
  return current.inventory.get()
}

export async function setTrainerBattlePoints(points: number): Promise<EditorSnapshot> {
  const current = client()
  const before = await current.trainer.get()
  if (before.battlePoints === null) throw new Error('This game does not store Battle Points.')
  if (!Number.isSafeInteger(points) || points < 0 || points > 65535) {
    throw new Error('Battle Points must be between 0 and 65535.')
  }
  await current.trainer.setBattlePoints(points)
  return readEditorSnapshot()
}

export async function exportEditorSave() {
  return client().game.export()
}

/** Pokémon storage operations. Original save stays untouched until export. */
export async function clonePokemonIntoBox(handle: PokemonHandle): Promise<{ added: AddedPokemon, snapshot: EditorSnapshot }> {
  const current = client()
  const original = await current.pokemon.get(handle)
  if (!original.editable || original.isUnknown) throw new Error('Unknown Pokémon cannot be cloned.')
  await current.pokemon.clone(handle)
  const added = await current.pokemon.addToBox()
  return { added, snapshot: await readEditorSnapshot() }
}

export async function exportSinglePokemon(handle: PokemonHandle): Promise<ExportedPokemon> {
  return client().pokemon.export(handle)
}

export interface EncounterCatalog {
  species: SpeciesEntry[]
  versions: EncounterVersions
}

export async function getEncounterCatalog(): Promise<EncounterCatalog> {
  const current = client()
  const [species, versions] = await Promise.all([
    current.species.list(),
    current.encounters.versions(),
  ])
  return { species, versions }
}

export async function findBoxEncounters(version: number, speciesId: number): Promise<EncounterRow[]> {
  if (!Number.isSafeInteger(version) || !Number.isSafeInteger(speciesId)) {
    throw new Error('Select a valid game and species.')
  }
  return client().encounters.search(version, speciesId)
}

/** Encounter indexes are valid only for the most recent encounter search. */
export async function addEncounterToBox(index: number): Promise<{ added: AddedPokemon, snapshot: EditorSnapshot }> {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('Select a valid encounter.')
  const added = await client().box.addEncounter(index)
  return { added, snapshot: await readEditorSnapshot() }
}

export async function inspectPokemonFile(bytes: Uint8Array): Promise<FilePreview> {
  if (!bytes.length || bytes.length > 1024 * 1024) throw new Error('Choose a Pokémon file smaller than 1 MiB.')
  return client().box.previewFile(bytes)
}

export async function addPokemonFileToBox(bytes: Uint8Array, allowUnofficial: boolean): Promise<{ added: AddedPokemon, snapshot: EditorSnapshot }> {
  if (!bytes.length || bytes.length > 1024 * 1024) throw new Error('Choose a Pokémon file smaller than 1 MiB.')
  // Verify again at commit time so the user cannot bypass preview restrictions.
  const preview = await client().box.previewFile(bytes)
  if (preview.unofficial && !allowUnofficial) throw new Error('This conversion requires explicit permission.')
  const added = await client().box.addFromFile(bytes, { allowUnofficial: preview.unofficial && allowUnofficial })
  return { added, snapshot: await readEditorSnapshot() }
}


/** Generation IV/V Wonder Cards (where this save reports support). */
export async function readGiftAlbum(): Promise<GiftAlbum> {
  return client().mysteryGift.status()
}
export async function listKnownGifts(): Promise<GiftEvent[]> {
  return client().mysteryGift.events()
}
export async function previewKnownGift(id: string): Promise<WonderCardPreview> {
  if (!id) throw new Error('Choose a Mystery Gift event.')
  return client().mysteryGift.previewEvent(id)
}
export async function insertKnownGift(id: string, slot: number): Promise<GiftAlbum> {
  const current = client()
  const album = await current.mysteryGift.status()
  if (!album.slots.some(entry => entry.index === slot && !entry.card)) {
    throw new Error('Choose an empty Mystery Gift album slot.')
  }
  await current.mysteryGift.insertEvent(id, slot)
  return current.mysteryGift.status()
}
export async function previewGiftFile(bytes: Uint8Array): Promise<WonderCardPreview> {
  if (!bytes.length || bytes.length > 1024 * 1024) throw new Error('Wonder Card file must be smaller than 1 MiB.')
  return client().mysteryGift.previewFile(bytes)
}
export async function insertGiftFile(bytes: Uint8Array, slot: number): Promise<GiftAlbum> {
  if (!bytes.length || bytes.length > 1024 * 1024) throw new Error('Wonder Card file must be smaller than 1 MiB.')
  const current = client()
  const album = await current.mysteryGift.status()
  if (!album.slots.some(entry => entry.index === slot && !entry.card)) {
    throw new Error('Choose an empty Mystery Gift album slot.')
  }
  await current.mysteryGift.insertFile(bytes, slot)
  return current.mysteryGift.status()
}
export async function removeGift(slot: number): Promise<GiftAlbum> {
  const current = client()
  const album = await current.mysteryGift.status()
  if (!album.slots.some(entry => entry.index === slot && entry.card)) {
    throw new Error('No Wonder Card is stored in this album slot.')
  }
  await current.mysteryGift.remove(slot)
  return current.mysteryGift.status()
}
export async function unlockMysteryGift(unlocked: boolean): Promise<GiftAlbum> {
  const current = client()
  const album = await current.mysteryGift.status()
  if (album.unlocked === null) throw new Error('This game does not use a Mystery Gift unlock flag.')
  await current.mysteryGift.setUnlocked(unlocked)
  return current.mysteryGift.status()
}
