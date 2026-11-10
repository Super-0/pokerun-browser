import assert from 'node:assert/strict'
import test from 'node:test'
import { assertReciprocalPartyExchange } from '../../scripts/white2-party-exchange.mjs'

test('the trade verifier matches reciprocal party changes and preserves duplicates', () => {
  const before = [['1:20', '1:20', '2:15'], ['3:10', '4:25']]
  assert.doesNotThrow(() => assertReciprocalPartyExchange(before, [['2:15', '3:10', '1:20'], ['4:25', '1:20']]))
  assert.throws(() => assertReciprocalPartyExchange(before, before), /one distinct changed/)
  assert.throws(() => assertReciprocalPartyExchange(before, [['1:20', '2:15', '3:10'], ['4:25', '5:20']]), /not reciprocal/)
  assert.throws(() => assertReciprocalPartyExchange(before, [['1:20', '2:15'], ['4:25', '1:20', '3:10']]), /party size/)
})
