import { createServer } from 'vite'

const server = await createServer({
  server: {
    host: '0.0.0.0',
    open: '/multiplayer-dev.html',
  },
})

await server.listen()
server.printUrls()
console.log('\nPokéRun multiplayer harness: /multiplayer-dev.html\n')
