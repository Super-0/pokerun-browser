import assert from 'node:assert/strict'
import test from 'node:test'
import { isProtocolMessage, MULTIPLAYER_PROTOCOL_VERSION } from '../../src/multiplayer/core/protocol.ts'

test('protocol admits current envelopes and rejects malformed or incompatible versions', () => {
  const message = { version: MULTIPLAYER_PROTOCOL_VERSION, type: 'ROOM_JOIN', senderId: 'guest', sentAt: 1 }
  assert.equal(isProtocolMessage(message), true)
  for (const invalid of [null, [], { ...message, version: 1 }, { ...message, senderId: null }, { ...message, type: null }]) {
    assert.equal(isProtocolMessage(invalid), false)
  }
})
