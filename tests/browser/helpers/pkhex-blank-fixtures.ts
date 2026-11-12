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
    boxes: number
    party: number
    reloaded: boolean
    reloadError?: string
  }> = []

  for (const sample of samples) {
    const version = versions.find(v => sample.matches.some(name => v.name.toLowerCase().includes(name)))
    if (!version) throw new Error('No blank save available for Generation ' + sample.generation)
    await engine.game.loadBlank(version.id)
    const current = await engine.game.get()
    if (!current || current.generation !== sample.generation) {
      throw new Error('Generation mismatch when creating ' + version.name)
    }

    const boxes = await engine.box.list()
    const party = await engine.party.get()
    const initial = await engine.game.export()
    if (!initial.bytes.length) throw new Error('Blank save export was empty.')

    // Blank templates are useful for verifying the engine's data model,
    // but some (notably Gen I Blue/Green) are intentionally not valid played
    // battery saves and cannot always pass normal game.load() detection.
    // Report reload failures independently instead of misreporting coverage.
    let reloaded = false
    let reloadError: string | undefined
    try {
      await engine.game.load(initial.bytes, initial.fileName || 'blank.sav')
      const restored = await engine.game.get()
      reloaded = restored?.generation === sample.generation
      if (!reloaded) reloadError = 'Generation mismatch after export'
    } catch (error) {
      reloadError = error instanceof Error ? error.message : String(error)
    }

    results.push({
      generation: sample.generation,
      version: current.version,
      exportedBytes: initial.bytes.length,
      boxes: boxes.length,
      party: party.length,
      reloaded,
      reloadError,
    })
  }

  await engine.game.close()
  return results
}
