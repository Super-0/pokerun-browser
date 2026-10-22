import fs from 'node:fs'

const path = 'src/multiplayer/games/White2DedicatedTrainerRuntime.tsx'
let source = fs.readFileSync(path, 'utf8')

const anchor = `      const current = await ensureActor(remote)\n      if (!current) return\n`
const replacement = `      // Dev trace: if map-transition recovery is stuck, show every heap slot that\n      // still carries PokéRun's dedicated UID before ensureActor tries to recover.\n      if (!binding && !ownsActor) {\n        const recoveryScan = await new White2ActorSystemProbe(runtimeBridge).scanHeap()\n        const pokerunSlots = recoveryScan.entries\n          .filter(entry => entry.uid === POKERUN_NATIVE_TEST_UID)\n          .map(entry => ({\n            index: entry.index,\n            address: hex(entry.address),\n            state: entry.state,\n            actorSystemBackptr: hex(entry.actorSystemBackptr),\n            currentActorSystem: hex(recoveryScan.actorSystem),\n            tcb: hex(entry.tcb),\n            moveCodeVTable: hex(entry.moveCodeVTable),\n            sceneNodeVTable: hex(entry.sceneNodeVTable),\n          }))\n        console.info('[PokéRun lifecycle] PRE-ENSURE RECOVERY SCAN', {\n          mapId: local.location.mapId,\n          remoteMapId: remote.location.mapId,\n          pokerunSlots,\n          suspiciousSlots: recoveryScan.suspiciousSlots,\n          detachedSlots: recoveryScan.detachedSlots,\n          zeroedSlots: recoveryScan.zeroedSlots,\n        })\n      }\n\n${anchor}`

if (!source.includes(anchor)) throw new Error('ensureActor call anchor not found')
source = source.replace(anchor, replacement)
fs.writeFileSync(path, source)
console.log('Applied stale remote actor transition trace.')
