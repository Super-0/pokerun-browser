import fs from 'node:fs'

const path = 'src/multiplayer/games/White2DedicatedTrainerRuntime.tsx'
let source = fs.readFileSync(path, 'utf8')

const missingStateBefore = `      if (!local?.worldPosition || !remote?.worldPosition) {
        if (ownsActor && now - lastCompletePresenceAt > MISSING_STATE_GRACE_MS) {
          rangeLatched = false
          stableMapId = null
          stableMapSince = 0
          await releaseActor()
        }
        return
      }
`

const missingStateAfter = `      if (!local?.worldPosition) {
        if (ownsActor && now - lastCompletePresenceAt > MISSING_STATE_GRACE_MS) {
          // Local position disappearing is a field-transition signal. Native
          // DeleteActor is unsafe here because White 2 may already be tearing
          // down the old field task manager. Drop PokéRun's references and let
          // the field teardown own destruction of the old dedicated actor.
          rangeLatched = false
          stableMapId = null
          stableMapSince = 0
          resetPlayerBinding()
          abandonActorForLocalMapTransition()
          console.info('[PokéRun lifecycle] ABANDON REMOTE • LOCAL POSITION UNAVAILABLE')
        }
        return
      }

      if (!remote?.worldPosition) {
        if (ownsActor && now - lastCompletePresenceAt > MISSING_STATE_GRACE_MS) {
          rangeLatched = false
          stableMapId = null
          stableMapSince = 0
          await releaseActor()
        }
        return
      }
`

if (!source.includes(missingStateBefore)) {
  throw new Error('Expected combined local/remote missing-state block not found. Apply map-transition recovery v2 first.')
}
source = source.replace(missingStateBefore, missingStateAfter)

const catchBefore = `          rangeLatched = false
          stableMapId = null
          stableMapSince = 0
          resetPlayerBinding()
          try {
            await releaseActor()
          } catch (cleanupError) {
            if (cleanupError instanceof White2ActorSystemUnavailableError) {
              await delay(200)
              continue
            }
            nativeStateUnsafe = true
            console.warn('White 2 dedicated trainer runtime stopped after actor cleanup failed:', cleanupError)
            break
          }
          const message = reason instanceof Error ? reason.message : String(reason)
`

const catchAfter = `          const failedLocal = presenceRef.current.local
          const localMapChangedDuringFailure = Boolean(
            failedLocal
            && lastLocalMapId !== null
            && failedLocal.location.mapId !== lastLocalMapId
          )
          const localFieldTransitioning = !failedLocal?.worldPosition
            || Boolean(failedLocal?.transition)
            || localMapChangedDuringFailure

          rangeLatched = false
          resetPlayerBinding()

          if (localFieldTransitioning) {
            // A generic renderer/field read can fail before tick() reaches its
            // normal map-change branch. Never respond by scheduling DeleteActor
            // against a field that may already be unloading.
            if (failedLocal) {
              lastLocalMapId = failedLocal.location.mapId
              stableMapId = failedLocal.location.mapId
              stableMapSince = Date.now()
            } else {
              stableMapId = null
              stableMapSince = 0
            }
            abandonActorForLocalMapTransition()
            console.info('[PokéRun lifecycle] ABANDON REMOTE • LOCAL FIELD ERROR', {
              mapId: failedLocal?.location.mapId ?? null,
              transition: failedLocal?.transition?.id ?? null,
              reason,
            })
          } else {
            stableMapId = null
            stableMapSince = 0
            try {
              await releaseActor()
            } catch (cleanupError) {
              if (cleanupError instanceof White2ActorSystemUnavailableError) {
                await delay(200)
                continue
              }
              nativeStateUnsafe = true
              console.warn('White 2 dedicated trainer runtime stopped after actor cleanup failed:', cleanupError)
              break
            }
          }
          const message = reason instanceof Error ? reason.message : String(reason)
`

if (!source.includes(catchBefore)) {
  throw new Error('Expected generic error cleanup block not found. Branch may already be patched.')
}
source = source.replace(catchBefore, catchAfter)

fs.writeFileSync(path, source)
console.log('Applied transition-safe local field cleanup handling.')
