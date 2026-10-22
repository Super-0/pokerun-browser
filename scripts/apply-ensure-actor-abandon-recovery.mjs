import fs from 'node:fs'

const path = 'src/multiplayer/games/White2DedicatedTrainerRuntime.tsx'
let source = fs.readFileSync(path, 'utf8')

const before = `    async function ensureActor(remote: MultiplayerPlayerState) {\n      if (binding) {\n        if (await bindingStillValid(runtimeBridge, binding)) return binding\n        await releaseActor()\n        return null\n      }\n      if (ownsActor) {\n        await releaseActor()\n        return null\n      }\n      resetRemoteAnimation()\n`

const after = `    async function ensureActor(remote: MultiplayerPlayerState) {\n      if (binding) {\n        if (await bindingStillValid(runtimeBridge, binding)) return binding\n\n        // A binding becoming invalid is not proof that the native FieldActor\n        // needs deletion. During White 2 field/BlAct rebuilds the scene handle\n        // can disappear before the actor system is ready for scheduled tasks.\n        // Drop PokéRun's stale pointers and let the next healthy heap scan either\n        // rebind the live UID or observe that White 2 already destroyed it.\n        console.info('[PokéRun lifecycle] ABANDON REMOTE • INVALID BINDING')\n        abandonActorForLocalMapTransition()\n        return null\n      }\n      if (ownsActor) {\n        // Ownership without a usable binding is the same uncertain state: do not\n        // schedule DeleteActor from here. Reacquire from the current field on the\n        // next tick instead.\n        console.info('[PokéRun lifecycle] ABANDON REMOTE • OWNER WITHOUT BINDING')\n        abandonActorForLocalMapTransition()\n        return null\n      }\n      resetRemoteAnimation()\n`

if (!source.includes(before)) {
  throw new Error('Expected ensureActor recovery block not found. Runtime may already be patched or locally diverged.')
}

source = source.replace(before, after)
fs.writeFileSync(path, source)
console.log('Applied safe ensureActor abandon/reacquire recovery.')
