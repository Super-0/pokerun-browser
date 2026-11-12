import { chromium } from 'playwright'

const baseUrl = process.env.POKERUN_REMOTE_URL ?? 'http://127.0.0.1:5173'
const count = 20
const browserA = await chromium.launch({ headless: true })
const browserB = await chromium.launch({ headless: true })

try {
  const [pageA, pageB] = await Promise.all([browserA.newPage(), browserB.newPage()])
  await Promise.all([
    pageA.goto(`${baseUrl}/multiplayer-dev.html?transport=network&player=1`),
    pageB.goto(`${baseUrl}/multiplayer-dev.html?transport=network&player=2`),
  ])

  const receiver = pageB.evaluate(async ({ count }) => {
    const { ViteRelayWhite2RadioTransport } = await import('/src/multiplayer/transports/White2RadioTransport.ts')
    const transport = new ViteRelayWhite2RadioTransport()
    const received = []
    const done = new Promise(resolve => {
      transport.onMessage(message => {
        if (message.kind !== 'frame' || message.fromId !== 'radio-probe-a') return
        received.push({
          sequence: message.sequence,
          bytes: Array.from(message.bytes),
          receivedAt: performance.timeOrigin + performance.now(),
        })
        if (received.length === count) resolve(received)
      })
    })
    return await Promise.race([
      done,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for relayed radio frames.')), 5000)),
    ])
  }, { count })

  const sent = await pageA.evaluate(async count => {
    const { ViteRelayWhite2RadioTransport } = await import('/src/multiplayer/transports/White2RadioTransport.ts')
    const transport = new ViteRelayWhite2RadioTransport()
    await new Promise(resolve => setTimeout(resolve, 250))
    const records = []
    for (let sequence = 1; sequence <= count; sequence++) {
      const sentAt = performance.timeOrigin + performance.now()
      const bytes = new Uint8Array([0x80, sequence, 0x2a, 0x00, 0xff])
      transport.send({
        protocol: 1,
        kind: 'frame',
        startId: 'radio-probe-start',
        romSha256: 'radio-probe-rom',
        saveProfileId: 'radio-probe-save-a',
        firmwareRole: 1,
        fromId: 'radio-probe-a',
        toId: 'radio-probe-b',
        sessionNonce: 'radio-probe-nonce',
        sequence,
        bytes,
        timestamp: sentAt,
        replyAid: 42,
        sentAt,
      })
      records.push({ sequence, sentAt })
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return records
  }, count)
  const received = await receiver
  const bySequence = new Map(received.map(record => [record.sequence, record]))
  const latencies = sent.map(record => bySequence.get(record.sequence).receivedAt - record.sentAt)
  const ordered = received.every((record, index) => record.sequence === index + 1)
  const payloadsPreserved = received.every(record =>
    record.bytes.join(',') === '128,' + record.sequence + ',42,0,255')
  if (!ordered || !payloadsPreserved) throw new Error('Relayed radio frames were reordered or mutated.')

  console.log(JSON.stringify({
    transport: 'Vite HMR WebSocket relay',
    isolatedProcesses: true,
    framesSent: sent.length,
    framesReceived: received.length,
    ordered,
    payloadsPreserved,
    latencyMs: {
      min: Math.min(...latencies),
      max: Math.max(...latencies),
      average: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
    },
    nativeAssociation: 'not attempted',
    genuineTrade: 'not attempted',
  }, null, 2))
} finally {
  await Promise.all([browserA.close(), browserB.close()])
}
