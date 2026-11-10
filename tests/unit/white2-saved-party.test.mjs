import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'
import { crc16Ccitt } from '../../src/multiplayer/games/White2ProgressedTestSave.ts'

test('White 2 reads the saved party referenced by the latest valid checksum table', async () => {
  const vite = await createServer({ configFile: false, server: { middlewareMode: true, watch: null } })
  try {
    const { readWhite2SavedParty } = await vite.ssrLoadModule('/src/multiplayer/games/White2PartyStructureProbe.ts')
    const bytes = new Uint8Array(0x80000)
    const view = new DataView(bytes.buffer)
    const party = 0x18e00
    const backup = 0x26000
    function makeParty(region, species, level) {
      const start = region + party
      view.setUint32(start, 6, true)
      view.setUint32(start + 4, 1, true)
      const member = start + 8
      view.setUint16(member + 4, 3, true)
      view.setUint16(member + 6, species, true)
      view.setUint16(member + 8, species, true)
      view.setUint8(member + 0x8c, level)
      const crc = crc16Ccitt(bytes.subarray(start, start + 0x534))
      view.setUint16(region + 0x19336, crc, true)
      return crc
    }
    function makeFooter(region, generation, crc) {
      view.setUint16(region + 0x25f34, crc, true)
      view.setUint32(region + 0x25f94, generation, true)
      view.setUint32(region + 0x25f98, 0x25fa4, true)
      view.setUint32(region + 0x25f9c, 0x31053527, true)
      view.setUint16(region + 0x25fa2, crc16Ccitt(bytes.subarray(region + 0x25f00, region + 0x25f94)), true)
    }
    const oldCrc = makeParty(0, 1, 10)
    const newCrc = makeParty(backup, 2, 20)
    makeFooter(0, 0, newCrc)
    makeFooter(backup, 0xffffffff, oldCrc)
    assert.deepEqual(readWhite2SavedParty(bytes), ['2:20'])
    bytes[backup + party + 16] ^= 1
    assert.deepEqual(readWhite2SavedParty(bytes), ['1:10'])
    bytes[party + 16] ^= 1
    assert.throws(() => readWhite2SavedParty(bytes), /No White 2 party block/)
  } finally {
    await vite.close()
  }
})
