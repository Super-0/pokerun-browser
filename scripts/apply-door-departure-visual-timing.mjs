import fs from 'node:fs'

const path = 'src/multiplayer/games/White2DedicatedTrainerRuntime.tsx'
let source = fs.readFileSync(path, 'utf8')

if (!source.includes('const ACTOR_SHADOW_GROUP = 0x81')) {
  const anchor = 'const ACTOR_TCB = 0x84\n'
  if (!source.includes(anchor)) throw new Error('ACTOR_TCB anchor not found; apply exclusive remote actor ownership first.')
  source = source.replace(anchor, 'const ACTOR_SHADOW_GROUP = 0x81\n' + anchor)
}

if (!source.includes('const REMOTE_DOOR_DEPARTURE_HOLD_MS = 260')) {
  const anchor = 'const REMOTE_TELEPORT_SNAP_FX32 = 2 * 0x10000\n'
  if (!source.includes(anchor)) throw new Error('Remote teleport constant anchor not found.')
  source = source.replace(
    anchor,
    anchor
      + 'const REMOTE_DOOR_DEPARTURE_HOLD_MS = 260\n'
      + 'const REMOTE_DOOR_DEPARTURE_TRAVEL_FX32 = 0x9000\n',
  )
}

// ShadowGroup is a byte in FieldActor. The native force-off-shadow calls are kept,
// but hard-zero the backing byte too so an already-created actor cannot carry a
// stale shadow group after its native TCB is detached.
const shadowCallAnchor = `      if (shadowGroup.status !== 1) {\n        throw new Error(\`FldAct_SetShadowGroup failed with status \${shadowGroup.status} at PC \${hex(shadowGroup.pc)}.\`)\n      }\n\n      const tcb = await runtimeBridge.read32(current.actorAddress + ACTOR_TCB)\n`
const shadowCallReplacement = `      if (shadowGroup.status !== 1) {\n        throw new Error(\`FldAct_SetShadowGroup failed with status \${shadowGroup.status} at PC \${hex(shadowGroup.pc)}.\`)\n      }\n      await runtimeBridge.write8(current.actorAddress + ACTOR_SHADOW_GROUP, 0)\n\n      const tcb = await runtimeBridge.read32(current.actorAddress + ACTOR_TCB)\n`
if (source.includes(shadowCallAnchor)) {
  source = source.replace(shadowCallAnchor, shadowCallReplacement)
} else if (!source.includes('write8(current.actorAddress + ACTOR_SHADOW_GROUP, 0)')) {
  throw new Error('Exclusive ownership shadow anchor not found.')
}

const frameGuardBefore = `      if (!current || !local || !remote) return\n      if (local.location.mapId !== remote.location.mapId) {\n        // The native FieldActor update still runs while P2 is elsewhere and can\n        // restore the test actor's NPC renderer/visibility. Our callback runs\n        // after the DS update and before presentation, so own visibility here.\n        void forceRemoteBillboardHidden(current)\n        return\n      }\n      if (!world || remoteActorHidden) return\n`
const frameGuardAfter = `      if (!current || !local || !remote) return\n      if (local.location.mapId !== remote.location.mapId) {\n        const transition = remote.transition\n        const age = transition ? Date.now() - transition.detectedAt : Number.POSITIVE_INFINITY\n        const holdingDoorDeparture = Boolean(\n          transition\n          && transition.fromMapId === local.location.mapId\n          && transition.toMapId === remote.location.mapId\n          && age >= 0\n          && age < REMOTE_DOOR_DEPARTURE_HOLD_MS\n        )\n        // During the short entrance hold the main tick intentionally keeps the\n        // protagonist visible and walks its PokéRun-owned billboard into the door.\n        // After that window, visibility belongs to the off-map hide path.\n        if (!holdingDoorDeparture) void forceRemoteBillboardHidden(current)\n        return\n      }\n      if (!world || remoteActorHidden) return\n`
if (source.includes(frameGuardBefore)) {
  source = source.replace(frameGuardBefore, frameGuardAfter)
} else if (!source.includes('holdingDoorDeparture')) {
  throw new Error('Off-map frame-hide guard did not match the expected ownership patch.')
}

// IMPORTANT: there is also a same-looking map-mismatch check in the emulated-frame
// callback. Scope this replacement to tick() so we never splice async tick code into
// a synchronous callback again.
const tickAnchor = '    async function tick() {'
const tickIndex = source.indexOf(tickAnchor)
if (tickIndex < 0) throw new Error('tick() anchor not found.')
const mismatchStart = '      if (local.location.mapId !== remote.location.mapId) {'
const mismatchEndMarker = '      const currentMapId = local.location.mapId\n'
const mismatchIndex = source.indexOf(mismatchStart, tickIndex)
const mismatchEnd = source.indexOf(mismatchEndMarker, mismatchIndex)
if (mismatchIndex < 0 || mismatchEnd < 0) throw new Error('tick() remote-map mismatch branch not found.')

const mismatchReplacement = `      if (local.location.mapId !== remote.location.mapId) {\n        stableMapId = local.location.mapId\n        stableMapSince = now\n        if (binding) {\n          const transition = remote.transition\n          const age = transition ? now - transition.detectedAt : Number.POSITIVE_INFINITY\n          const fromWorld = transition?.fromWorldPosition ?? renderedWorld\n          const holdingDoorDeparture = Boolean(\n            transition\n            && transition.fromMapId === local.location.mapId\n            && transition.toMapId === remote.location.mapId\n            && fromWorld\n            && age >= 0\n            && age < REMOTE_DOOR_DEPARTURE_HOLD_MS\n          )\n\n          if (holdingDoorDeparture && transition && fromWorld) {\n            if (remoteActorHidden) await setRemoteActorHidden(binding, false)\n            const progress = Math.min(1, Math.max(0, age / REMOTE_DOOR_DEPARTURE_HOLD_MS))\n            const distance = Math.round(REMOTE_DOOR_DEPARTURE_TRAVEL_FX32 * progress)\n            let nextX = signed32(fromWorld.x)\n            let nextZ = signed32(fromWorld.z)\n            if (transition.fromDirection === 'north') nextZ -= distance\n            else if (transition.fromDirection === 'south') nextZ += distance\n            else if (transition.fromDirection === 'west') nextX -= distance\n            else nextX += distance\n\n            const visualWorld: MultiplayerWorldPosition = {\n              x: nextX >>> 0,\n              y: fromWorld.y >>> 0,\n              z: nextZ >>> 0,\n            }\n            const visualRemote: MultiplayerPlayerState = {\n              ...remote,\n              location: { ...local.location },\n              x: transition.fromX,\n              y: transition.fromY,\n              direction: transition.fromDirection,\n              movementState: 'moving',\n              worldPosition: visualWorld,\n            }\n            const profile = remoteProfile(now, visualRemote)\n            latestRemoteProfile = profile\n            renderedWorld = visualWorld\n            lastRenderAdvanceAt = now\n            await runtimeBridge.write8(binding.actorAddress + ACTOR_SHADOW_GROUP, 0)\n            await applyRemoteFrame(binding, visualRemote, visualWorld, profile)\n            rangeLatched = true\n            return\n          }\n\n          if (!remoteActorHidden) {\n            await setRemoteActorHidden(binding, true)\n            console.info('[PokéRun lifecycle] HIDE REMOTE • DOOR DEPARTURE COMPLETE', {\n              actor: binding.actorAddress,\n              transition: transition?.id ?? null,\n            })\n          }\n          rangeLatched = true\n          resetRemoteAnimation()\n        } else {\n          rangeLatched = false\n          remoteActorHidden = false\n        }\n        return\n      }\n\n`

source = source.slice(0, mismatchIndex) + mismatchReplacement + source.slice(mismatchEnd)

fs.writeFileSync(path, source)
console.log('Polished remote door departure: suppress shadow, walk ~0.56 tile into doorway for 260 ms, then hide while the native door animation finishes.')
