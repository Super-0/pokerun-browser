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
