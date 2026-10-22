import fs from 'node:fs'

const path = 'src/multiplayer/games/White2DedicatedTrainerRuntime.tsx'
let source = fs.readFileSync(path, 'utf8')

const matFlagsAnchor = 'const BLACT_MAT_FLAGS = 0x18\n'
if (!source.includes('const BLACT_VISIBLE_MASK = 0x0200')) {
  if (!source.includes(matFlagsAnchor)) throw new Error('BLACT_MAT_FLAGS anchor not found.')
  source = source.replace(matFlagsAnchor, matFlagsAnchor + 'const BLACT_VISIBLE_MASK = 0x0200\n')
}

// The previous experiment called FieldActor-level SetActorHidden. That can let
// White 2 rebuild/rebind the billboard and briefly expose the actor's original
// NPC renderer. Remove the symbol because this experiment works only at BlAct.
source = source.replace('const FLDACT_SET_ACTOR_HIDDEN = 0x02167574\n', '')

const helperStart = '    async function setRemoteActorHidden(current: DedicatedBinding, hidden: boolean) {'
const helperEnd = '    async function releaseActor('
const helperStartIndex = source.indexOf(helperStart)
const helperEndIndex = source.indexOf(helperEnd, helperStartIndex)
if (helperStartIndex < 0 || helperEndIndex < 0) {
  throw new Error('Expected setRemoteActorHidden helper from the native-hide experiment was not found.')
}

const helper = `    async function setRemoteActorHidden(current: DedicatedBinding, hidden: boolean) {\n      // BlAct::visible is bit 9 of the 16-bit flags word at +0x18. Toggle only\n      // that render bit: do not mutate FieldActor flags, position, UID, binding,\n      // material, or animation state.\n      const address = current.blActAddress + BLACT_MAT_FLAGS\n      const flags = await runtimeBridge.read16(address)\n      const nextFlags = hidden\n        ? (flags & ~BLACT_VISIBLE_MASK)\n        : (flags | BLACT_VISIBLE_MASK)\n      await runtimeBridge.write16(address, nextFlags)\n      remoteActorHidden = hidden\n    }\n\n`
source = source.slice(0, helperStartIndex) + helper + source.slice(helperEndIndex)

// While the remote is intentionally hidden, the per-emulated-frame callback
// must not replay a normal visible matFlags profile behind the main tick.
const frameGuardBefore = '      if (!current || !local || !remote || !world || local.location.mapId !== remote.location.mapId) return\n'
const frameGuardAfter = '      if (!current || !local || !remote || !world || remoteActorHidden || local.location.mapId !== remote.location.mapId) return\n'
if (source.includes(frameGuardBefore)) {
  source = source.replace(frameGuardBefore, frameGuardAfter)
} else if (!source.includes(frameGuardAfter)) {
  throw new Error('Emulated-frame remote render guard anchor not found.')
}

// On return to the same map, update position/material/face while the BlAct is
// still invisible. Only after the complete protagonist frame is installed do we
// set visible=1. This prevents a single-frame native NPC atlas flash.
const finalApplyBefore = `      latestRemoteProfile = profile\n      await applyRemoteFrame(current, remote, world, profile)\n      if (remoteActorHidden) {\n        // The target position and protagonist render are now correct while the\n        // actor is still invisible. Reveal only after that complete frame lands.\n        await setRemoteActorHidden(current, false)\n        console.info('[PokéRun lifecycle] SHOW REMOTE • SAME MAP', { actor: current.actorAddress })\n      }\n`
const finalApplyAfter = `      latestRemoteProfile = profile\n      const frameProfile = remoteActorHidden\n        ? { ...profile, matFlags: profile.matFlags & ~BLACT_VISIBLE_MASK }\n        : profile\n      await applyRemoteFrame(current, remote, world, frameProfile)\n      if (remoteActorHidden) {\n        await setRemoteActorHidden(current, false)\n        console.info('[PokéRun lifecycle] SHOW REMOTE • SAME MAP', { actor: current.actorAddress })\n      }\n`
if (source.includes(finalApplyBefore)) {
  source = source.replace(finalApplyBefore, finalApplyAfter)
} else if (!source.includes('const frameProfile = remoteActorHidden')) {
  throw new Error('Final remote apply/reveal anchor not found.')
}

fs.writeFileSync(path, source)
console.log('Remote map transitions now hide the BlAct visible bit directly and reveal only after a complete protagonist frame is installed.')
