import fs from 'node:fs'

const path = 'src/multiplayer/games/White2DedicatedTrainerRuntime.tsx'
let source = fs.readFileSync(path, 'utf8')

if (!source.includes('async function forceRemoteBillboardHidden')) {
  const helperAnchor = '    async function setRemoteActorHidden(current: DedicatedBinding, hidden: boolean) {'
  const helperIndex = source.indexOf(helperAnchor)
  if (helperIndex < 0) throw new Error('setRemoteActorHidden helper anchor not found; apply the billboard-visibility patch first.')

  const helper = `    async function forceRemoteBillboardHidden(current: DedicatedBinding) {\n      // White 2's native FieldActor update can rewrite BlAct::visible after a\n      // one-time hide. Reassert only the visible bit after every emulated frame\n      // while the authoritative remote is on another map. Do not touch actor\n      // position, material, UID, animation, or lifecycle.\n      const address = current.blActAddress + BLACT_MAT_FLAGS\n      const flags = await runtimeBridge.read16(address)\n      if ((flags & BLACT_VISIBLE_MASK) !== 0) {\n        await runtimeBridge.write16(address, flags & ~BLACT_VISIBLE_MASK)\n      }\n    }\n\n`
  source = source.slice(0, helperIndex) + helper + source.slice(helperIndex)
}

const oldGuard = `      if (!current || !local || !remote || !world || remoteActorHidden || local.location.mapId !== remote.location.mapId) return\n      void applyRemoteFrame(current, remote, world, latestRemoteProfile)\n`
const newGuard = `      if (!current || !local || !remote) return\n      if (local.location.mapId !== remote.location.mapId) {\n        // The native FieldActor update still runs while P2 is elsewhere and can\n        // restore the test actor's NPC renderer/visibility. Our callback runs\n        // after the DS update and before presentation, so own visibility here.\n        void forceRemoteBillboardHidden(current)\n        return\n      }\n      if (!world || remoteActorHidden) return\n      void applyRemoteFrame(current, remote, world, latestRemoteProfile)\n`

if (source.includes(oldGuard)) {
  source = source.replace(oldGuard, newGuard)
} else if (!source.includes('void forceRemoteBillboardHidden(current)')) {
  throw new Error('Emulated-frame callback guard did not match the expected billboard-visibility patch.')
}

fs.writeFileSync(path, source)
console.log('Off-map remote visibility is now reasserted after every emulated DS frame.')
