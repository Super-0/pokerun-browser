import { createEngine } from '@pkhex-everywhere/engine'

/** ROM-free test exercise for PKHeX across five generation families. */
export async function verifyPkhexBlankSaveExports() {
  const engine = createEngine({ lazy: true })
  const versions = await engine.game.blankVersions()

  const samples = [
    { generation: 1, matches: ['red', 'blue', 'yellow'] },
    { generation: 2, matches: ['crystal', 'gold', 'silver'] },
    { generation: 3, matches: ['emerald', 'firered', 'ruby'] },
    { generation: 4, matches: ['platinum', 'diamond', 'heartgold'] },
    { generation: 5, matches: ['black 2', 'white 2', 'black', 'white'] },
  ]
  const results: Array<{
    generation: number
    version: string
    exportedBytes: number
    exportError?: string
    boxes: number
    party: number
    reloaded: boolean
    reloadError?: string
  }> = []

  for (const sample of samples) {
    // Match the *beginning* of the game title: a substring match for
    // "Diamond" accidentally selects the Generation VIII Brilliant Diamond.
    const candidates = versions.filter(v => sample.matches.some(name => {
      const title = v.name.toLowerCase()
      return title === name || title.startsWith(name + ' ') || title.startsWith(name + '[')
    }))
    let version: typeof versions[number] | undefined
    let current: Awaited<ReturnType<typeof engine.game.get>> = null
    for (const candidate of candidates) {
      await engine.game.loadBlank(candidate.id)
      const loaded = await engine.game.get()
      if (loaded?.generation === sample.generation) {
        version = candidate
        current = loaded
        break
      }
    }
    if (!version || !current) {
      throw new Error('No matching Generation ' + sample.generation + ' blank save version found.')
    }

    const boxes = await engine.box.list()
    const party = await engine.party.get()
    // The SDK can load an empty template but cannot export every one (some
    // report Arg_ArgumentOutOfRangeException). Capture these SDK limitations
    // rather than treating blank, unplayed templates as verified save files.
    let exportedBytes = 0
    let exportError: string | undefined
    let reloaded = false
    let reloadError: string | undefined
    try {
      const initial = await engine.game.export()
      exportedBytes = initial.bytes.length
      if (exportedBytes > 0) {
        try {
          await engine.game.load(initial.bytes, initial.fileName || 'blank.sav')
          const restored = await engine.game.get()
          reloaded = restored?.generation === sample.generation
          if (!reloaded) reloadError = 'Generation mismatch after export'
        } catch (error) {
          reloadError = error instanceof Error ? error.message : String(error)
        }
      }
    } catch (error) {
      exportError = error instanceof Error ? error.message : String(error)
    }

    results.push({
      generation: sample.generation,
      version: current.version,
      exportedBytes,
      exportError,
      boxes: boxes.length,
      party: party.length,
      reloaded,
      reloadError,
    })
  }

  await engine.game.close()
  return results
}

export async function verifyBlackTrainerRoundTrip() {
  const engine = createEngine({ lazy: true })
  const versions = await engine.game.blankVersions()
  const version = versions.find(item => item.name === 'Black')
  if (!version) throw new Error('Black blank save unavailable')
  await engine.game.loadBlank(version.id)
  await engine.trainer.setMoney(87654)
  const exported = await engine.game.export()
  await engine.game.load(exported.bytes, exported.fileName || 'Black.sav')
  const money = (await engine.trainer.get()).money
  const generation = (await engine.game.get())?.generation
  await engine.game.close()
  return { money, generation, exportedBytes: exported.bytes.length }
}


/** Only for ROM-free browser UI tests; no user save or game ROM. */
export async function createBlankBlackSave(): Promise<Uint8Array> {
  const engine = createEngine({ lazy: true })
  const version = (await engine.game.blankVersions()).find(item => item.name === 'Black')
  if (!version) throw new Error('No Black save template found.')
  await engine.game.loadBlank(version.id)
  const output = await engine.game.export()
  await engine.game.close()
  return output.bytes
}

export async function verifyBlackItemRoundTrip() {
  const engine = createEngine({ lazy: true })
  const version = (await engine.game.blankVersions()).find(item => item.name === 'Black')
  if (!version) throw new Error('No Black save template found.')
  await engine.game.loadBlank(version.id)
  const bag = await engine.inventory.get()
  const pouch = bag.find(p => p.addable.some(item => item.maxCount >= 2))
  if (!pouch) throw new Error('No editable item pouch available.')
  const item = pouch.addable.find(candidate => candidate.maxCount >= 2)!
  await engine.inventory.setItem({ pouch: pouch.name, itemId: item.id }, 2)
  const after = await engine.inventory.get()
  const applied = after.find(p => p.name === pouch.name)?.items.find(entry => entry.id === item.id)?.count
  const exported = await engine.game.export()
  await engine.game.load(exported.bytes, 'Black.sav')
  const restored = (await engine.inventory.get())
    .find(p => p.name === pouch.name)?.items.find(entry => entry.id === item.id)?.count
  await engine.game.close()
  return { applied, restored, pouch: pouch.name, itemId: item.id }
}


/** Verifies PC creation, duplication and individual .pk export using no game ROM. */
export async function verifyBlackBoxToolsRoundTrip() {
  const engine = createEngine({ lazy: true })
  const version = (await engine.game.blankVersions()).find(item => item.name === 'Black')
  if (!version) throw new Error('Black blank-save template is missing.')
  await engine.game.loadBlank(version.id)
  const catalog = await engine.encounters.versions()
  let found: Awaited<ReturnType<typeof engine.encounters.search>> = []
  for (const id of [504, 519, 495, 506, 509, 25]) {
    found = await engine.encounters.search(catalog.default, id)
    if (found.length) break
  }
  if (!found.length) throw new Error('No Generation V encounter template was found.')
  const created = await engine.box.addEncounter(found[0].index)
  const original = await engine.pokemon.get(created.at)
  const individual = await engine.pokemon.export(created.at)
  if (!individual.bytes.length) throw new Error('Individual Pokémon export was empty.')
  await engine.pokemon.clone(created.at)
  const duplicated = await engine.pokemon.addToBox()
  const before = await engine.box.get()
  const output = await engine.game.export()
  await engine.game.load(output.bytes, output.fileName)
  const after = await engine.box.get()
  await engine.game.close()
  return {
    createdSpecies: original.species,
    individualBytes: individual.bytes.length,
    distinctSlots: JSON.stringify(created.at) !== JSON.stringify(duplicated.at),
    beforeCount: before.length,
    afterCount: after.length,
  }
}


/** Gen V advanced editing: shiny and OT change, followed by save round-trip. */
export async function verifyBlackAdvancedPokemonRoundTrip() {
  const engine = createEngine({ lazy: true })
  const version = (await engine.game.blankVersions()).find(item => item.name === 'Black')
  if (!version) throw new Error('Black template unavailable.')
  await engine.game.loadBlank(version.id)
  const catalog = await engine.encounters.versions()
  const encounters = await engine.encounters.search(catalog.default, 504)
  if (!encounters.length) throw new Error('Patrat encounter unavailable.')
  const created = await engine.box.addEncounter(encounters[0].index)
  const original = await engine.pokemon.details(created.at)
  await engine.pokemon.edit(created.at)
  await engine.pokemon.update({ source: 'draft', slot: 0 }, {
    isShiny: !original.isShiny,
    originalTrainerName: 'POKERUN',
  })
  await engine.pokemon.commit()
  const before = await engine.pokemon.details(created.at)
  const saved = await engine.game.export()
  await engine.game.load(saved.bytes, saved.fileName)
  const after = await engine.pokemon.details(created.at)
  await engine.game.close()
  return {
    originalShiny: original.isShiny,
    changedShiny: before.isShiny,
    reloadShiny: after.isShiny,
    reloadTrainer: after.originalTrainerName,
  }
}

/** Gen V Mystery Gift album: event insertion and save round-trip. */
export async function verifyBlackWonderCardRoundTrip() {
  const engine = createEngine({ lazy: true })
  const version = (await engine.game.blankVersions()).find(item => item.name === 'Black')
  if (!version) throw new Error('Black template unavailable.')
  await engine.game.loadBlank(version.id)
  const before = await engine.mysteryGift.status()
  const events = await engine.mysteryGift.events()
  const choice = events.find(event => !event.received)
  if (!choice) throw new Error('No Gen V Wonder Cards are available.')
  const empty = before.slots.find(slot => !slot.card)
  if (!empty) throw new Error('No empty Gen V Wonder Card slots.')
  await engine.mysteryGift.insertEvent(choice.id, empty.index)
  const inserted = await engine.mysteryGift.status()
  const saved = await engine.game.export()
  await engine.game.load(saved.bytes, saved.fileName)
  const after = await engine.mysteryGift.status()
  await engine.game.close()
  return {
    initial: before.slots.filter(slot => slot.card).length,
    inserted: inserted.slots.filter(slot => slot.card).length,
    reloaded: after.slots.filter(slot => slot.card).length,
  }
}
