import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { assertReciprocalPartyExchange } from './white2-party-exchange.mjs'

export async function captureAfter(page) {
  const [message] = await Promise.all([
    page.waitForEvent('console', {
      predicate: event => event.text().startsWith('[PokéRun wireless] PRK80 INTERACTION TIMING DELTA'),
    }),
    page.getByRole('button', { name: '2. CAPTURE AFTER' }).click(),
  ])
  return message.args()[1].jsonValue()
}

export async function readCheckpointSave(page, player) {
  return page.evaluate(async player => {
    const { multiplayerSaveStore } = await import('/src/core/storage/MultiplayerSaveStore.ts')
    const { readWhite2SavedParty } = await import('/src/multiplayer/games/White2PartyStructureProbe.ts')
    const profile = localStorage.getItem(`pokerun-multiplayer-dev-save-player-${player}-v1`)
    if (!profile) throw new Error('Missing disposable White 2 save selection.')
    const bytes = await multiplayerSaveStore.loadBatterySave(profile)
    if (!bytes) throw new Error('Missing disposable White 2 battery.')
    const party = readWhite2SavedParty(bytes)
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    return { digest: Array.from(new Uint8Array(hash)).join(','), party }
  }, player)
}

export async function verifyTradeIntegrity(pages, savesBefore) {
  let lastFailure
  const deadline = Date.now() + 90_000
  do {
    try {
      const savesAfter = await Promise.all(pages.map((page, index) => readCheckpointSave(page, index + 1)))
      assertReciprocalPartyExchange(savesBefore.map(save => save.party), savesAfter.map(save => save.party))
      const persistedBatteryChanged = savesAfter.map((save, index) => save.digest !== savesBefore[index].digest)
      assert(persistedBatteryChanged.every(Boolean), 'The two disposable batteries did not both change after the trade.')
      return {
        reciprocalPartyExchange: true,
        bothSavedBatteriesPassFooterValidation: true,
        persistedBatteryChanged,
      }
    } catch (error) {
      lastFailure = error
      await delay(2_000)
    }
  } while (Date.now() < deadline)
  throw lastFailure
}

export async function within(ms, description, action) {
  let timer
  try {
    return await Promise.race([
      action(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(description)), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
