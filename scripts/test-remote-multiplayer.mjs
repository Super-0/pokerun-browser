import { chromium } from 'playwright'

const baseUrl = process.env.POKERUN_REMOTE_URL ?? 'http://127.0.0.1:5173/multiplayer-dev.html'
const timeout = Number(process.env.POKERUN_REMOTE_TIMEOUT_MS ?? 10000)
const hostUrl = `${baseUrl}?transport=network&player=1`

function relayMessages(page) {
  const messages = []
  page.on('websocket', socket => {
    socket.on('framereceived', frame => {
      try {
        const outer = JSON.parse(frame.payload)
        if (outer.type !== 'custom' || outer.event !== 'pokerun:multiplayer') return
        messages.push({ receivedAt: Date.now(), message: outer.data })
      } catch {
        // Vite HMR frames unrelated to the multiplayer relay are ignored.
      }
    })
  })
  return messages
}

async function waitForRoomCode(page) {
  const roomPattern = /ROOM\s+([A-Z2-9]{6})\s+(?:Waiting|Both)/
  await page.waitForFunction(source => new RegExp(source).test(document.body.innerText), roomPattern.source, { timeout })
  return (await page.locator('body').innerText()).match(roomPattern)?.[1] ?? ''
}

const hostBrowser = await chromium.launch({ headless: true })
const guestBrowser = await chromium.launch({ headless: true })
const isolatedBrowser = await chromium.launch({ headless: true })
try {
  const host = await hostBrowser.newPage()
  const guest = await guestBrowser.newPage()
  const isolated = await isolatedBrowser.newPage()
  const hostMessages = relayMessages(host)
  const guestMessages = relayMessages(guest)

  await host.goto(hostUrl)
  const roomCode = await waitForRoomCode(host)
  if (!roomCode) throw new Error('Host did not expose a room code.')

  await guest.goto(`${baseUrl}?transport=network&player=2&room=${roomCode}`)
  try {
    await guest.waitForFunction(() => /2\/2 PLAYERS[\s\S]*GUEST/.test(document.body.innerText), null, { timeout })
  } catch (error) {
    throw new Error(`Guest did not join room ${roomCode}: ${(await guest.locator('body').innerText()).slice(0, 500)}`, { cause: error })
  }
  await host.waitForFunction(() => /2\/2 PLAYERS[\s\S]*HOST/.test(document.body.innerText), null, { timeout })

  const guestJoinIndex = hostMessages.findIndex(entry => entry.message.type === 'ROOM_JOIN')
  const hostStateIndex = guestMessages.findIndex(entry => entry.message.type === 'ROOM_STATE')
  if (guestJoinIndex < 0 || hostStateIndex < 0) throw new Error('Room pairing did not exchange ROOM_JOIN and ROOM_STATE.')
  if (hostMessages[guestJoinIndex].message.roomCode !== roomCode) throw new Error('Guest joined the wrong room.')
  if (guestMessages[hostStateIndex].message.room.code !== roomCode) throw new Error('Host acknowledged the wrong room.')

  await isolated.goto(hostUrl)
  await waitForRoomCode(isolated)
  if (!(await host.locator('body').innerText()).includes('2/2 PLAYERS • HOST')) {
    throw new Error('A separate room changed the paired room state.')
  }

  console.log(JSON.stringify({
    roomCode,
    hostRole: 'host',
    guestRole: 'guest',
    hostReceivedRoomJoin: true,
    guestReceivedRoomState: true,
    roomPairing: 'verified',
    hostJoinLatencyMs: typeof hostMessages[guestJoinIndex].message.sentAt === 'number'
      ? hostMessages[guestJoinIndex].receivedAt - hostMessages[guestJoinIndex].message.sentAt
      : null,
    guestStateLatencyMs: typeof guestMessages[hostStateIndex].message.sentAt === 'number'
      ? guestMessages[hostStateIndex].receivedAt - guestMessages[hostStateIndex].message.sentAt
      : null,
    roomIsolation: 'verified',
  }, null, 2))
} finally {
  await Promise.all([hostBrowser.close(), guestBrowser.close(), isolatedBrowser.close()])
}
