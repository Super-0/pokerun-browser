import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acceptsWhite2RadioSequence,
  BroadcastWhite2RadioTransport,
  deserializeWhite2RadioMessage,
  deserializeLocalWhite2RadioMessage,
  serializeWhite2RadioMessage,
} from '../../src/multiplayer/transports/White2RadioTransport.ts'

function frame(sequence) {
  return {
    kind: 'frame',
    sequence,
    bytes: new Uint8Array([0x24, sequence]),
    timestamp: sequence,
  }
}

test('radio relay serialization preserves frame bytes and rejects malformed payloads', () => {
  const decoded = deserializeWhite2RadioMessage(serializeWhite2RadioMessage(frame(7)))
  assert.deepEqual([...decoded.bytes], [0x24, 7])
  assert.equal(decoded.sequence, 7)
  assert.equal(deserializeWhite2RadioMessage({ kind: 'frame', bytes: 'not-base64' }), null)
  assert.equal(deserializeLocalWhite2RadioMessage({ kind: 'frame', bytes: 'not-base64' }), null)
  assert.equal(deserializeWhite2RadioMessage({ kind: 'unknown' }), null)
  assert.equal(acceptsWhite2RadioSequence(4, 5), true)
  assert.equal(acceptsWhite2RadioSequence(5, 5), false)
  assert.equal(acceptsWhite2RadioSequence(5, 4), false)
})

test('local BroadcastChannel transport preserves structured-cloned Uint8Array frames', () => {
  const channel = {
    onmessage: null,
    postMessage(message) {
      const cloned = structuredClone(message)
      this.onmessage?.({ data: cloned })
    },
    close() {},
  }
  const transport = new BroadcastWhite2RadioTransport(channel)
  const received = []
  transport.onMessage(message => received.push(message))
  const message = frame(9)
  transport.send(message)
  assert.equal(received.length, 1)
  assert.equal(received[0].kind, 'frame')
  assert.ok(received[0].bytes instanceof Uint8Array)
  assert.deepEqual([...received[0].bytes], [...message.bytes])
  assert.notEqual(received[0].bytes, message.bytes)
  channel.onmessage({ data: { ...message, bytes: 'bad' } })
  assert.equal(received.length, 1)
  transport.close()
})

test('isolated relay preserves ordered delivery under bounded latency and disconnect', async () => {
  const received = []
  let connected = true
  const deliver = (message, delay) => new Promise(resolve => setTimeout(() => {
    if (connected) received.push(deserializeWhite2RadioMessage(serializeWhite2RadioMessage(message)))
    resolve()
  }, delay))

  const first = deliver(frame(1), 12)
  const second = deliver(frame(2), 4)
  await Promise.all([first, second])
  assert.deepEqual(received.map(message => message.sequence), [2, 1])

  connected = false
  await deliver(frame(3), 1)
  assert.deepEqual(received.map(message => message.sequence), [2, 1])
})
