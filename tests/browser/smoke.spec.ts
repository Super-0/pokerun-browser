import { expect, test } from '@playwright/test'

test('launcher requires a save and defaults to native radio isolation', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/multiplayer-dev.html')
  await expect(page.getByRole('checkbox', { name: /PRK75 RADIO ISOLATION/ })).toBeChecked()
  await expect(page.getByRole('button', { name: /launch player 1/i })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'REATTACH PLAYER 2 ROM' })).toBeDisabled()
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
  expect(errors).toEqual([])
})

test('two launcher pages auto-pair in one browser context and block start without a ROM', async ({ page: host, context, browser }) => {
  const guest = await context.newPage()
  const isolated = await browser.newContext()
  try {
    const outsider = await isolated.newPage()
    const errors: string[] = []
    for (const page of [host, guest, outsider]) {
      page.on('pageerror', error => errors.push(error.message))
    }
    await Promise.all([
      host.goto('/multiplayer-dev.html?player=1'),
      guest.goto('/multiplayer-dev.html?player=2'),
      outsider.goto('/multiplayer-dev.html?player=2'),
    ])
    await expect(host.getByText('2/2 PLAYERS • HOST')).toBeVisible()
    await expect(guest.getByText('2/2 PLAYERS • GUEST')).toBeVisible()
    await expect(guest.locator('.lobby-room-code strong')).toHaveText(await host.locator('.lobby-room-code strong').innerText())
    await expect(guest.getByRole('button', { name: 'READY', exact: true })).toBeDisabled()
    await expect(host.getByRole('button', { name: 'START GAME' })).toBeDisabled()
    await expect(outsider.getByText(/WAITING FOR HOST ROOM CODE/)).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    await isolated.close()
  }
})

test('normal multiplayer room pairs two tabs and blocks start until they supply saves', async ({ page: host, context }) => {
  const guest = await context.newPage()
  await Promise.all([host, guest].map(async page => {
    await page.goto('/')
    await page.getByRole('button', { name: 'MULTIPLAYER', exact: true }).click()
    await page.getByRole('button', { name: /white 2/i }).click()
  }))
  await host.getByRole('button', { name: 'CREATE ROOM', exact: true }).click()
  const roomCode = await host.locator('.lobby-room-code strong').innerText()
  expect(roomCode).toMatch(/^[A-Z2-9]{6}$/)
  await guest.getByRole('textbox', { name: 'Room code' }).fill(roomCode)
  await guest.getByRole('button', { name: 'JOIN', exact: true }).click()
  await expect(host.getByText('2/2 PLAYERS • HOST')).toBeVisible()
  await expect(guest.getByText('2/2 PLAYERS • GUEST')).toBeVisible()
  await expect(guest.locator('.lobby-room-code strong')).toHaveText(roomCode)
  for (const page of [host, guest]) await expect(page.getByRole('button', { name: 'READY', exact: true })).toBeDisabled()
  await expect(host.getByRole('button', { name: 'START GAME', exact: true })).toBeDisabled()
})
