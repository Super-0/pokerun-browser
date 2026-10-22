import fs from 'node:fs'

const path = 'src/multiplayer/games/White2DedicatedTrainerRuntime.tsx'
let source = fs.readFileSync(path, 'utf8')

const before = `      if (existing) {\n        console.info('[PokéRun lifecycle] REBIND EXISTING REMOTE', {\n          actor: existing.address,\n          actorSystem: liveScan.actorSystem,\n        })\n        return bindDedicatedActor(existing.address, remote)\n      }\n\n      const spawned = await nativeActors.spawnTestActor()\n`

const after = `      if (existing) {\n        // Transition experiment: a surviving FieldActor can be attached to a stale\n        // BlAct/scene from the previous field. The current field is stable here, so\n        // deleting this known PokéRun UID is safe. Force White 2 to create a brand\n        // new FieldActor + scene node + billboard instead of reusing stale render state.\n        console.info('[PokéRun lifecycle] DISCARD EXISTING REMOTE BEFORE FRESH SPAWN', {\n          actor: existing.address,\n          actorSystem: liveScan.actorSystem,\n        })\n        await nativeActors.deleteTestActor(existing.address)\n        resetRemoteAnimation()\n        binding = null\n        ownsActor = false\n      }\n\n      const spawned = await nativeActors.spawnTestActor()\n`

if (!source.includes(before)) {
  throw new Error('Expected REBIND EXISTING REMOTE block not found. Apply map-transition recovery v2 first.')
}

source = source.replace(before, after)
fs.writeFileSync(path, source)
console.log('Applied forced fresh post-transition actor experiment.')
