import fs from 'node:fs'

const path = 'src/multiplayer/games/White2DedicatedTrainerRuntime.tsx'
let source = fs.readFileSync(path, 'utf8')

const FldActAnchor = 'const FLDACT_GET_BLACT_IDX = 0x02167240\n'
if (!source.includes('const FLDACT_SET_ACTOR_HIDDEN = 0x02167574')) {
  if (!source.includes(FldActAnchor)) throw new Error('FldAct symbol anchor not found.')
  source = source.replace(
    FldActAnchor,
    FldActAnchor + 'const FLDACT_SET_ACTOR_HIDDEN = 0x02167574\n',
  )
}

source = source.replace('const REMOTE_PARK_OFFSET_FX32 = 32 * 0x10000\n', '')

const hiddenStateAnchor = '    let rangeLatched = false\n'
if (!source.includes('    let remoteActorHidden = false\n')) {
  if (!source.includes(hiddenStateAnchor)) throw new Error('rangeLatched state anchor not found.')
  source = source.replace(
    hiddenStateAnchor,
    hiddenStateAnchor + '    let remoteActorHidden = false\n',
  )
}

const parkStart = '    async function parkRemoteActorOffscreen(current: DedicatedBinding) {'
const parkEnd = '    async function releaseActor('
const parkStartIndex = source.indexOf(parkStart)
const parkEndIndex = source.indexOf(parkEnd, parkStartIndex)
if (parkStartIndex < 0 || parkEndIndex < 0) {
  throw new Error('Expected parkRemoteActorOffscreen helper from the previous map-transition patch was not found.')
}

const hideHelper = `    async function setRemoteActorHidden(current: DedicatedBinding, hidden: boolean) {\n      const result = await runtimeBridge.callArm9Thumb4(\n        FLDACT_SET_ACTOR_HIDDEN,\n        current.actorAddress,\n        hidden ? 1 : 0,\n        0,\n        0,\n        NATIVE_STACK_RESERVE,\n      )\n      if (result.status !== 1) {\n        throw new Error(\`SetActorHidden native call failed with status \${result.status} at PC \${hex(result.pc)}.\`)\n      }\n      remoteActorHidden = hidden\n    }\n\n`

source = source.slice(0, parkStartIndex) + hideHelper + source.slice(parkEndIndex)

const mismatchStart = '      if (local.location.mapId !== remote.location.mapId) {'
const mismatchEndMarker = '      const currentMapId = local.location.mapId\n'
const mismatchIndex = source.indexOf(mismatchStart)
const mismatchEnd = source.indexOf(mismatchEndMarker, mismatchIndex)
if (mismatchIndex < 0 || mismatchEnd < 0) throw new Error('Remote-map mismatch branch not found.')

const mismatchReplacement = `      if (local.location.mapId !== remote.location.mapId) {\n        // Remote-only map changes must not delete or teleport the dedicated actor.\n        // White 2 can rebuild a FieldActor's native billboard during a large\n        // position jump, briefly exposing the underlying NPC model. Hide the\n        // existing actor in place instead, then update/reveal it on return.\n        stableMapId = local.location.mapId\n        stableMapSince = now\n        if (binding) {\n          if (!remoteActorHidden) {\n            await setRemoteActorHidden(binding, true)\n            console.info('[PokéRun lifecycle] HIDE REMOTE • DIFFERENT MAP', { actor: binding.actorAddress })\n          }\n          rangeLatched = true\n          resetRemoteAnimation()\n        } else {\n          rangeLatched = false\n          remoteActorHidden = false\n        }\n        return\n      }\n\n`

source = source.slice(0, mismatchIndex) + mismatchReplacement + source.slice(mismatchEnd)

const applyAnchor = '      await applyRemoteFrame(current, remote, world, profile)\n'
const applyReplacement = `      await applyRemoteFrame(current, remote, world, profile)\n      if (remoteActorHidden) {\n        // The target position and protagonist render are now correct while the\n        // actor is still invisible. Reveal only after that complete frame lands.\n        await setRemoteActorHidden(current, false)\n        console.info('[PokéRun lifecycle] SHOW REMOTE • SAME MAP', { actor: current.actorAddress })\n      }\n`

const applyIndex = source.lastIndexOf(applyAnchor)
if (applyIndex < 0) throw new Error('Final applyRemoteFrame anchor not found.')
source = source.slice(0, applyIndex) + applyReplacement + source.slice(applyIndex + applyAnchor.length)

const abandonResetAnchor = '      binding = null\n      ownsActor = false\n      resetRemoteAnimation()\n      reacquireAfter = 0\n'
if (source.includes(abandonResetAnchor)) {
  source = source.replace(
    abandonResetAnchor,
    '      binding = null\n      ownsActor = false\n      remoteActorHidden = false\n      resetRemoteAnimation()\n      reacquireAfter = 0\n',
  )
}

const releaseResetAnchor = '      binding = null\n      ownsActor = false\n      resetRemoteAnimation()\n      if (cooldown) reacquireAfter = Math.max(reacquireAfter, Date.now() + REACQUIRE_COOLDOWN_MS)\n'
if (source.includes(releaseResetAnchor)) {
  source = source.replace(
    releaseResetAnchor,
    '      binding = null\n      ownsActor = false\n      remoteActorHidden = false\n      resetRemoteAnimation()\n      if (cooldown) reacquireAfter = Math.max(reacquireAfter, Date.now() + REACQUIRE_COOLDOWN_MS)\n',
  )
}

fs.writeFileSync(path, source)
console.log('Replaced remote-map parking with White 2 SetActorHidden hide/update/show lifecycle.')
