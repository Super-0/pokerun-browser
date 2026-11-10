import assert from 'node:assert/strict'
import test from 'node:test'
import { readWhite2UnionNegotiation } from '../../src/multiplayer/games/White2UnionNegotiationProbe.ts'

test('Union probe distinguishes connected peers from negotiated game handles', async () => {
  const gfl = 0x02201000
  const state = 0x02202000
  const system = 0x02203000
  const server = gfl + 0x70 + 8 * 0x50
  const negotiation = 0x02204000
  const words = new Map([
    [0x021418F0, gfl], [0x021418E4, state], [0x021418D8, system],
    [state + 8, 0x02041689], [gfl + 0x70 + 0x4A, 5], [gfl + 0x70 + 0x50 + 0x4A, 2],
    [system + 0x1E4, 3], [server + 0x40, 1], [server + 12, negotiation], [negotiation + 0xD, 1],
  ])
  const read = async address => words.get(address) ?? 0
  const reader = { read8: read, read16: read, read32: read }
  assert.deepEqual(await readWhite2UnionNegotiation(reader), {
    stateFunction: 0x02041688, states: [5, 2, 0, 0, 0, 0, 0, 0],
    negotiatedCount: 1, receivedNegotiationMask: 2, sentMask: 1, connectedMask: 3,
    stopped: false, error: false,
  })
  words.set(0x021418F0, 0x02400000)
  assert.equal(await readWhite2UnionNegotiation(reader), null)
})
