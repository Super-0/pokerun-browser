import { spawn } from 'node:child_process'
import { createServer } from 'vite'

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
    open: false,
  },
})

await server.listen()
server.printUrls()

const address = server.httpServer?.address()
const port = address && typeof address === 'object' ? address.port : null
if (!port) throw new Error('Could not determine the multiplayer dev server port.')

const harnessUrl = `http://localhost:${port}/multiplayer-dev.html`
console.log(`\nPokéRun multiplayer harness:\n${harnessUrl}\n`)
openBrowser(harnessUrl)
