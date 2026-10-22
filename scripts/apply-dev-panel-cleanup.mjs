import fs from 'node:fs'

const devPath = 'src/multiplayer-dev.tsx'
let dev = fs.readFileSync(devPath, 'utf8')

const traceImports = `import { installMultiplayerMovementTraceInstrumentation } from './multiplayer/debug/MultiplayerMovementTrace'\nimport { MultiplayerMovementTracePanel } from './multiplayer/debug/MultiplayerMovementTracePanel'\n`
if (!dev.includes(traceImports)) throw new Error('Multiplayer trace imports not found; panel may already be removed.')
dev = dev.replace(traceImports, '')

const traceInstall = `\ninstallMultiplayerMovementTraceInstrumentation()\n`
if (!dev.includes(traceInstall)) throw new Error('Multiplayer trace instrumentation call not found.')
dev = dev.replace(traceInstall, '\n')

const tracePanel = `    <MultiplayerMovementTracePanel player={player}/>\n`
if (!dev.includes(tracePanel)) throw new Error('Multiplayer trace panel mount not found.')
dev = dev.replace(tracePanel, '')

fs.writeFileSync(devPath, dev)

const screenPath = 'src/screens/MultiplayerScreen.tsx'
let screen = fs.readFileSync(screenPath, 'utf8')

const actorImport = `import { White2ActorLifecycleTrace } from '../components/White2ActorLifecycleTrace'\n`
if (!screen.includes(actorImport)) throw new Error('White2ActorLifecycleTrace import not found; native actor panel may already be removed.')
screen = screen.replace(actorImport, '')

const actorMount = `<White2ActorLifecycleTrace bridge={bridge} rom={localRomIdentity}/>`
if (!screen.includes(actorMount)) throw new Error('White2ActorLifecycleTrace mount not found.')
screen = screen.replace(actorMount, '')

fs.writeFileSync(screenPath, screen)
console.log('Removed default multiplayer trace instrumentation/panel and native actor test panel. Diagnostic source files remain available in the repo.')
