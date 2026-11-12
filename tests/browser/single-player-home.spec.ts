import { expect, test } from '@playwright/test'

test('New Run opens the existing game library and Change Game returns there', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'YOUR RUNS' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'NO RUNS YET' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'CHOOSE YOUR GAME' })).toHaveCount(0)

  await page.getByRole('button', { name: '+ NEW RUN' }).click()
  await expect(page.getByRole('heading', { name: 'CHOOSE YOUR GAME' })).toBeVisible()
  await expect(page.locator('.generation-row')).toHaveCount(5)

  await page.locator('.game-tile').filter({ hasText: 'EMERALD' }).click()
  await expect(page.getByRole('heading', { name: 'POKÉMON EMERALD' })).toBeVisible()

  await page.getByRole('button', { name: 'CHANGE GAME' }).click()
  await expect(page.getByRole('heading', { name: 'CHOOSE YOUR GAME' })).toBeVisible()
  await page.getByRole('button', { name: 'BACK TO HOME' }).click()
  await expect(page.getByRole('heading', { name: 'YOUR RUNS' })).toBeVisible()
  expect(errors).toEqual([])
})

test('Home features the most recently updated run and keeps older runs accessible', async ({ page }) => {
  await page.addInitScript(() => {
    const base = {
      id: 'emerald-save',
      gameId: 'emerald',
      runNumber: 1,
      runType: 'Vanilla',
      seed: 'AAAAAAA',
      romLoaded: false,
      currentMap: 'Oldale Town',
      encounterStatus: 'AVAILABLE',
      badges: 1,
      deaths: 0,
      levelCap: 14,
      nextBoss: 'Brawly',
      playTimeSeconds: 3600,
      party: [],
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T11:00:00.000Z',
    }
    const newer = {
      ...base,
      id: 'white2-save',
      gameId: 'white2',
      runNumber: 2,
      badges: 3,
      currentMap: 'Castelia City',
      playTimeSeconds: 7200,
      updatedAt: '2026-11-10T11:00:00.000Z',
    }
    localStorage.setItem('pokerun:runs:v1', JSON.stringify([base, newer]))
  })

  await page.goto('/')
  await expect(page.locator('.featured-run-details')).toContainText('POKÉMON WHITE 2')
  await expect(page.locator('.featured-run-details')).toContainText('RUN 002')
  await expect(page.locator('.home-run-row')).toContainText('POKÉMON EMERALD')
  await expect(page.getByRole('button', { name: 'MY RUNS', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'VIEW ALL RUNS' }).click()
  await expect(page.getByRole('heading', { name: 'MY RUNS' })).toBeVisible()
  await page.getByRole('button', { name: 'HOME', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'YOUR RUNS' })).toBeVisible()
})
