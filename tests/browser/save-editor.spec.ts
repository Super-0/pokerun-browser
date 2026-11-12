import { expect, test } from '@playwright/test'

type Variant = 'ruby-sapphire' | 'emerald' | 'firered-leafgreen'

function makeGen3Fixture(variant: Variant): Uint8Array {
  const bytes = new Uint8Array(0x20000)
  const view = new DataView(bytes.buffer)
  const sectionLengths = [3884,3968,3968,3968,3848,3968,3968,3968,3968,3968,3968,3968,3968,2000]
  const key = variant === 'emerald' ? 0x1234abcd : variant === 'firered-leafgreen' ? 0xabcddcba : 0
  for (let slot = 0; slot < 2; slot++) {
    const positions = Array<number>(14)
    for (let sector = 0; sector < 14; sector++) {
      const id = (sector + (slot === 1 ? 3 : 0)) % 14
      positions[id] = slot * 0xe000 + sector * 0x1000
    }
    const trainer = positions[0]
    const items = positions[1]
    view.setUint16(trainer + 0x0e, 12, true)
    view.setUint8(trainer + 0x10, 34)
    if (variant === 'emerald') {
      view.setUint32(trainer + 0xac, key, true)
      view.setUint32(trainer + 0x1f4, key, true)
      view.setUint8(trainer + 0x900, 5)
    } else if (variant === 'firered-leafgreen') {
      view.setUint32(trainer + 0xac, 1, true)
      view.setUint32(trainer + 0xaf8, key, true)
    }
    const moneyOffset = variant === 'firered-leafgreen' ? 0x290 : 0x490
    const partyOffset = variant === 'firered-leafgreen' ? 0x34 : 0x234
    view.setUint32(items + moneyOffset, ((slot === 0 ? 500 : 2000) ^ key) >>> 0, true)
    if (variant === 'firered-leafgreen') view.setUint8(items + partyOffset, 2)
    else view.setUint32(items + partyOffset, 2, true)

    for (let id = 0; id < 14; id++) {
      const offset = positions[id]
      let sum = 0
      for (let n = 0; n < sectionLengths[id]; n += 4) sum = (sum + view.getUint32(offset + n, true)) >>> 0
      view.setUint16(offset + 0xff4, id, true)
      view.setUint16(offset + 0xff6, ((sum & 0xffff) + (sum >>> 16)) & 0xffff, true)
      view.setUint32(offset + 0xff8, 0x08012025, true)
      view.setUint32(offset + 0xffc, slot + 1, true)
    }
  }
  return bytes
}

test('save editor appears immediately left of Multiplayer and preserves home navigation', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'SAVE EDITOR' })).toBeVisible()
  const actions = await page.locator('.app-header .text-action').allTextContents()
  expect(actions.slice(0, 2)).toEqual(['SAVE EDITOR', 'MULTIPLAYER'])
  await page.getByRole('button', { name: 'SAVE EDITOR' }).click()
  await expect(page.getByRole('heading', { name: 'SAVE EDITOR' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'READY WHEN YOU ARE' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'IMPORT SAVE' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'EXPORT EDITED SAVE' })).toBeDisabled()
  await page.getByRole('button', { name: 'BACK TO HOME' }).click()
  await expect(page.getByRole('heading', { name: 'YOUR RUNS' })).toBeVisible()
})

test('all supported Gen III variants auto-detect from bytes and edit the newest slot only', async ({ page }) => {
  await page.goto('/')
  const results = await page.evaluate(async examples => {
    const { inspectSave } = await import('/src/core/save-editor/detectSave.ts')
    const { changeGen3Money } = await import('/src/core/save-editor/gen3Save.ts')
    const output = []
    for (const example of examples) {
      const input = Uint8Array.from(example.bytes)
      const detection = inspectSave(input)
      if (detection.mode !== 'editable') throw Error('Expected editable Gen III save')
      const original = input.slice()
      const edited = changeGen3Money(input, 999999)
      const changedOutsideNewSlot = edited.slice(0, 0xe000).some((value, i) => value !== original[i])
      const after = inspectSave(edited)
      output.push({
        variant: detection.info.variant,
        originalMoney: detection.info.money,
        editedMoney: after.mode === 'editable' ? after.info.money : null,
        corruptedOriginal: original.some((value, i) => value !== input[i]),
        changedOutsideNewSlot,
      })
    }
    return output
  }, (['emerald', 'ruby-sapphire', 'firered-leafgreen'] as const).map(variant => ({
    variant,
    bytes: Array.from(makeGen3Fixture(variant)),
  })))
  expect(results).toEqual([
    { variant: 'emerald', originalMoney: 2000, editedMoney: 999999, corruptedOriginal: false, changedOutsideNewSlot: false },
    { variant: 'ruby-sapphire', originalMoney: 2000, editedMoney: 999999, corruptedOriginal: false, changedOutsideNewSlot: false },
    { variant: 'firered-leafgreen', originalMoney: 2000, editedMoney: 999999, corruptedOriginal: false, changedOutsideNewSlot: false },
  ])
})


test('corrupt or unidentified DS save never enables export', async ({ page }) => {
  test.setTimeout(100_000)
  await page.goto('/')
  await page.getByRole('button', { name: 'SAVE EDITOR' }).click()
  await page.locator('input[type=file]').setInputFiles({
    name: 'white2.sav',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(512 * 1024),
  })
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('button', { name: 'DOWNLOAD BACKUP' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'EXPORT EDITED SAVE' })).toBeDisabled()
})

test('PKHeX engine inspects five generation families and reports blank template export compatibility @integration', async ({ page }) => {
  test.setTimeout(150_000)
  await page.goto('/')
  const generations = await page.evaluate(async () => {
    const fixtures = await import('/tests/browser/helpers/pkhex-blank-fixtures.ts')
    return fixtures.verifyPkhexBlankSaveExports()
  })
  expect(generations.map(item => item.generation)).toEqual([1, 2, 3, 4, 5])
  expect(generations.every(item => item.boxes > 0)).toBe(true)
  expect(generations.some(item => item.exportedBytes > 0)).toBe(true)
  // Blank Gen I templates are not guaranteed to re-import as played saves.
  // Record this separately; real battery-save round trips need actual fixtures.
  console.info('PKHeX blank template reload diagnostics:', generations.map(item => ({
    generation: item.generation, version: item.version, reloaded: item.reloaded,
    reloadError: item.reloadError,
    exportError: item.exportError, exportedBytes: item.exportedBytes,
  })))
})

test('Gen V Black trainer edit survives SDK export and reload @integration', async ({ page }) => {
  test.setTimeout(100_000)
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { createEngine } = await import('@pkhex-everywhere/engine')
    const engine = createEngine({ lazy: true })
    const versions = await engine.game.blankVersions()
    const version = versions.find(item => item.name === 'Black')
    if (!version) throw new Error('Black blank save unavailable')
    await engine.game.loadBlank(version.id)
    await engine.trainer.setMoney(87654)
    const exported = await engine.game.export()
    await engine.game.load(exported.bytes, exported.fileName || 'Black.sav')
    const money = (await engine.trainer.get()).money
    const generation = (await engine.game.get())?.generation
    await engine.game.close()
    return { money, generation, exportedBytes: exported.bytes.length }
  })
  expect(result).toEqual({ money: 87654, generation: 5, exportedBytes: 524288 })
})
