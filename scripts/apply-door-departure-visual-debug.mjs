import fs from 'node:fs'

const trainerPath = 'src/multiplayer/games/White2DedicatedTrainerRuntime.tsx'
let trainer = fs.readFileSync(trainerPath, 'utf8')

const releaseSignatureBefore = `    async function releaseActor(cooldown = true) {\n`
const releaseSignatureAfter = `    async function releaseActor(cooldown = true, restoreNativeRender = true) {\n`
if (!trainer.includes(releaseSignatureBefore)) {
  throw new Error('releaseActor signature anchor not found; this patch may already be applied.')
}
trainer = trainer.replace(releaseSignatureBefore, releaseSignatureAfter)

const restoreBefore = `      if (current && await bindingStillValid(runtimeBridge, current)) {\n        await writeRenderProfile(runtimeBridge, current, current.nativeRender)\n      }\n`
const restoreAfter = `      if (restoreNativeRender && current && await bindingStillValid(runtimeBridge, current)) {\n        await writeRenderProfile(runtimeBridge, current, current.nativeRender)\n      }\n`
if (!trainer.includes(restoreBefore)) {
  throw new Error('native render restore anchor not found.')
}
trainer = trainer.replace(restoreBefore, restoreAfter)

const mismatchBefore = `      if (local.location.mapId !== remote.location.mapId) {\n        rangeLatched = false\n        stableMapId = null\n        stableMapSince = 0\n        await releaseActor()\n        return\n      }\n`
const mismatchAfter = `      if (local.location.mapId !== remote.location.mapId) {\n        rangeLatched = false\n        stableMapId = null\n        stableMapSince = 0\n        // The remote is intentionally leaving this map. Do not restore the\n        // dedicated actor's original NPC render profile for a frame before\n        // deletion; that produces the visible wrong-model flash at the door.\n        await releaseActor(true, false)\n        return\n      }\n`
if (!trainer.includes(mismatchBefore)) {
  throw new Error('remote map mismatch anchor not found.')
}
trainer = trainer.replace(mismatchBefore, mismatchAfter)
fs.writeFileSync(trainerPath, trainer)

const transitionPath = 'src/multiplayer/games/White2RemoteTransitionRuntime.tsx'
let transition = fs.readFileSync(transitionPath, 'utf8')

const playBefore = `        const animation = await doors.playNearestDoor(world)\n        if (animation.handle) activeDoor = { handle: animation.handle, mapId: localMapId, startedAt: now }\n        lastWarning = ''\n`
const playAfter = `        console.info('[PokéRun door] PLAY NEAREST DOOR', { mapId: localMapId, world })\n        const animation = await doors.playNearestDoor(world)\n        console.info('[PokéRun door] DOOR RESULT', {\n          mapId: localMapId,\n          matched: animation.matched,\n          handle: animation.handle,\n          world,\n        })\n        if (animation.handle) activeDoor = { handle: animation.handle, mapId: localMapId, startedAt: now }\n        lastWarning = ''\n`
if (!transition.includes(playBefore)) {
  if (!transition.includes("[PokéRun door] DOOR RESULT")) {
    throw new Error('door play anchor not found.')
  }
} else {
  transition = transition.replace(playBefore, playAfter)
}

const departureBefore = `      if (sameMap(local.location.mapId, transition.fromMapId)) {\n        await playDoor(transition.fromWorldPosition, local.location.mapId, now)\n        return\n      }\n`
const departureAfter = `      if (sameMap(local.location.mapId, transition.fromMapId)) {\n        console.info('[PokéRun door] REMOTE DEPARTURE', {\n          id: transition.id,\n          fromMapId: transition.fromMapId,\n          toMapId: transition.toMapId,\n          fromWorldPosition: transition.fromWorldPosition ?? null,\n        })\n        await playDoor(transition.fromWorldPosition, local.location.mapId, now)\n        return\n      }\n`
if (transition.includes(departureBefore)) {
  transition = transition.replace(departureBefore, departureAfter)
}
fs.writeFileSync(transitionPath, transition)

const doorPath = 'src/multiplayer/games/White2DoorTransition.ts'
let door = fs.readFileSync(doorPath, 'utf8')
door = door.replace("console.debug('[PokéRun] White 2 door lookup found no nearby type-2 prop.'", "console.info('[PokéRun door] LOOKUP NO MATCH'")
door = door.replace("console.debug('[PokéRun] White 2 door lookup selected loaded type-2 prop.'", "console.info('[PokéRun door] LOOKUP MATCH'")
fs.writeFileSync(doorPath, door)

console.log('Applied remote departure no-flash cleanup and visible door matcher diagnostics.')
