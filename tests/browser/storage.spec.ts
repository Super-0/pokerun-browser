import { expect, test } from '@playwright/test'

test('two save slots share a cartridge, keep independent batteries, and survive a reload @integration', async ({ page: p1, context, browser }) => {
  const p2 = await context.newPage()
  await p1.goto('/multiplayer-dev.html')
  await p2.goto('/multiplayer-dev.html')
  const slots = await p1.evaluate(async () => {
    const { multiplayerSaveStore: saves } = await import('/src/core/storage/MultiplayerSaveStore.ts')
    const rom = { fileName: 'synthetic.nds', size: 3, extension: '.nds', platform: 'NDS', sha256: 'a'.repeat(64), bytes: Uint8Array.of(10, 20, 30) } as const
    const identity = { gameId: 'white2', status: 'verified', sha256: rom.sha256 } as const
    const source = saves.create('white2', rom, identity)
    await saves.attachRomToProfile(source.id, rom, identity)
    const derived = saves.createDerived(source.id, rom, identity)
    await saves.saveBatterySave(source.id, Uint8Array.of(1, 2))
    await saves.saveBatterySave(derived.id, Uint8Array.of(3, 4))
    return [source.id, derived.id]
  })
  expect(slots[0]).not.toBe(slots[1])
  await p1.reload()
  for (const page of [p1, p2]) {
    expect(await page.evaluate(async ids => {
      const { multiplayerSaveStore: saves } = await import('/src/core/storage/MultiplayerSaveStore.ts')
      return Promise.all(ids.map(async id => ({
        cartridge: Array.from((await saves.restoreRom(id))?.bytes ?? []),
        battery: Array.from(await saves.loadBatterySave(id) ?? []),
      })))
    }, slots)).toEqual([
      { cartridge: [10, 20, 30], battery: [1, 2] },
      { cartridge: [10, 20, 30], battery: [3, 4] },
    ])
  }
  const fresh = await browser.newContext()
  try {
    const page = await fresh.newPage()
    await page.goto(p1.url())
    await expect(page.getByRole('button', { name: /launch player 1/i })).toBeDisabled()
    expect(await page.evaluate(async id => {
      const { multiplayerSaveStore: saves } = await import('/src/core/storage/MultiplayerSaveStore.ts')
      return [saves.list(), await saves.restoreRom(id), await saves.loadBatterySave(id)]
    }, slots[0])).toEqual([[], null, null])
  } finally {
    await fresh.close()
  }
})

test('old IndexedDB cartridge records remain readable @integration', async ({ page }) => {
  await page.goto('/multiplayer-dev.html')
  const restored = await page.evaluate(async () => {
    const { romSessionStore: roms } = await import('/src/core/rom/RomSessionStore.ts')
    // Let the production code create the schema, then simulate a previous writer.
    await roms.restore('legacy')
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('pokerun-local')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('roms', 'readwrite')
        const store = transaction.objectStore('roms')
        for (const [runId, bytes] of [
          ['legacy-array', Uint8Array.of(1, 2)],
          ['legacy-buffer', Uint8Array.of(3, 4).buffer],
        ] as const) store.put({ runId, bytes, fileName: 'synthetic.nds', size: 2, platform: 'NDS', extension: '.nds', sha256: 'synthetic' })
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error)
      })
    } finally {
      db.close()
    }
    return Promise.all(['legacy-array', 'legacy-buffer'].map(async id => Array.from((await roms.restore(id))?.bytes ?? [])))
  })
  expect(restored).toEqual([[1, 2], [3, 4]])
})
