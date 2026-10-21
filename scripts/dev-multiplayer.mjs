import { spawn } from 'node:child_process'
import { createServer } from 'vite'

const MULTIPLAYER_PORT = Number(process.env.POKERUN_MULTIPLAYER_PORT ?? 5173)
const NETWORK_RELAY_EVENT = 'pokerun:multiplayer'

function openBrowser(url) {
  let command
  let args

  if (process.platform === 'darwin') {
    command = 'open'
    args = [url]
  } else if (process.platform === 'win32') {
    command = 'cmd'
    args = ['/c', 'start', '', url]
  } else {
    command = 'xdg-open'
    args = [url]
  }

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {
      console.log(`\nOpen this URL manually:\n${url}\n`)
    })
    child.unref()
  } catch {
    console.log(`\nOpen this URL manually:\n${url}\n`)
  }
}

const server = await createServer({
  server: {
    host: '0.0.0.0',
    port: MULTIPLAYER_PORT,
    strictPort: true,
    open: false,
  },
})

// Dev-only cross-device relay. Clients opt in with ?transport=network and send
// the normal multiplayer protocol through Vite's existing HMR WebSocket.
server.ws.on(NETWORK_RELAY_EVENT, data => {
  server.ws.send(NETWORK_RELAY_EVENT, data)
})

await server.listen()
server.printUrls()

const harnessUrl = `http://localhost:${MULTIPLAYER_PORT}/multiplayer-dev.html`
console.log(`\nPokéRun multiplayer harness:\n${harnessUrl}\n`)
console.log(`Cross-device mode: append ?transport=network to a player URL served by this dev server.\n`)
openBrowser(harnessUrl)
