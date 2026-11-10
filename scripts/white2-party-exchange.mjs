import assert from 'node:assert/strict'

function difference(first, second) {
  const remaining = [...second]
  return first.filter(member => {
    const index = remaining.indexOf(member)
    if (index === -1) return true
    remaining.splice(index, 1)
    return false
  })
}

export function assertReciprocalPartyExchange(before, after) {
  assert(before.every((party, index) => party.length === after[index].length), 'Trade changed a party size.')
  const outgoing = before.map((party, index) => difference(party, after[index]))
  const incoming = after.map((party, index) => difference(party, before[index]))
  assert(outgoing.every(party => party.length === 1) && incoming.every(party => party.length === 1),
    'Expected exactly one distinct changed party member on each console.')
  assert.equal(outgoing[0][0] === incoming[1][0] && outgoing[1][0] === incoming[0][0], true,
    'The two party changes were not reciprocal.')
}
