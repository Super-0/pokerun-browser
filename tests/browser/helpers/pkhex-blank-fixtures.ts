import { createEngine } from '@pkhex-everywhere/engine'

/** ROM-free test exercise for PKHeX across five generation families. */
export async function verifyPkhexBlankSaveRoundTrips() {
  const engine = createEngine({ lazy: true })
  await engine.ready
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
    roundTrip: boolean
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

    await engine.game.load(initial.bytes, version.name + '.sav')
    const restored = await engine.game.get()
    if (!restored || restored.generation !== sample.generation) {
      throw new Error('Could not reload Generation ' + sample.generation + ' export.')
    }
    results.push({
      generation: sample.generation,
      version: restored.version,
      exportedBytes: initial.bytes.length,
      boxes: boxes.length,
      party: party.length,
      roundTrip: true,
    })
  }

  await engine.game.close()
  return results
}
