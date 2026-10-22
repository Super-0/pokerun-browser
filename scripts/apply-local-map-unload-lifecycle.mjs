import fs from 'node:fs'

const path = 'src/multiplayer/games/White2DedicatedTrainerRuntime.tsx'
let source = fs.readFileSync(path, 'utf8')

const varsBefore = `    let stableMapId: MultiplayerPlayerState['location']['mapId'] | null = null
    let stableMapSince = 0
    let lastCompletePresenceAt = 0
`
const varsAfter = `    let stableMapId: MultiplayerPlayerState['location']['mapId'] | null = null
    let stableMapSince = 0
    let lastLocalMapId: MultiplayerPlayerState['location']['mapId'] | null = null
    let lastCompletePresenceAt = 0
`

const resetBefore = `    function resetRemoteAnimation() {
      lastRemoteWorld = null
      lastRemoteWorldAt = 0
      renderedWorld = null
      lastRenderAdvanceAt = 0
      remoteMovingUntil = 0
      remoteMotionKind = 'walk'
      activeRemoteDirection = null
      activeRemoteMotionKind = null
      remoteSequenceIndex = 0
      remoteStepStartedAt = 0
      remoteWasMoving = false
      remoteTurn = null
      latestRemoteProfile = null
    }
`
const resetAfter = `${resetBefore}
    function abandonActorForLocalMapTransition() {
      // The local field owns every FieldActor allocation. When that field is
      // unloading, do not enqueue DeleteActor on its task manager: the manager
      // can disappear before the callback runs and leave PokéRun permanently in
      // an unsafe native-call state. Drop our references and let White 2 destroy
      // the old field/actor naturally as part of the map transition.
      binding = null
      ownsActor = false
      resetRemoteAnimation()
      reacquireAfter = 0
    }
`

const tickBefore = `      const presence = presenceRef.current
      const local = presence.local
      const remote = presence.remote

      if (!local?.worldPosition || !remote?.worldPosition) {
`
const tickAfter = `      const presence = presenceRef.current
      const local = presence.local
      const remote = presence.remote

      // A local map change means White 2 is unloading the Field/ActorSystem that
      // owns our dedicated remote actor. Never schedule native deletion against
      // that dying system. Abandon the old binding and reacquire only after the
      // new local field has remained stable for MAP_STABLE_MS.
      if (local) {
        const currentLocalMapId = local.location.mapId
        const localMapChanged = lastLocalMapId !== null && lastLocalMapId !== currentLocalMapId
        lastLocalMapId = currentLocalMapId
        if (localMapChanged) {
          rangeLatched = false
          stableMapId = currentLocalMapId
          stableMapSince = now
          resetPlayerBinding()
          abandonActorForLocalMapTransition()
          return
        }
      }

      if (!local?.worldPosition || !remote?.worldPosition) {
`

for (const [before, after, label] of [
  [varsBefore, varsAfter, 'local-map lifecycle vars'],
  [resetBefore, resetAfter, 'local-map abandon helper'],
  [tickBefore, tickAfter, 'local-map transition gate'],
]) {
  if (!source.includes(before)) throw new Error(`Expected ${label} block was not found; branch may have changed.`)
  source = source.replace(before, after)
}

fs.writeFileSync(path, source)
console.log('Applied local-map unload lifecycle experiment.')
