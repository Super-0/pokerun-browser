import fs from 'node:fs'

const path = 'src/multiplayer/games/White2DedicatedTrainerRuntime.tsx'
let source = fs.readFileSync(path, 'utf8')

const before = `          const failedLocal = presenceRef.current.local
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

const after = `          const failedLocal = presenceRef.current.local

          // A generic renderer/read failure is not a safe place to schedule a
          // White 2 field task. During map transitions, JS presence can still
          // look completely healthy for a short window after the native field
          // task manager has begun teardown. Calling DeleteActor from this catch
          // can therefore deadlock until the 900-frame native safety timeout.
          //
          // Drop only PokéRun's references here. On the next healthy tick,
          // ensureActor() will either rebind the still-live dedicated UID or
          // spawn a fresh actor if White 2 destroyed it with the old field.
          rangeLatched = false
          stableMapId = failedLocal?.location.mapId ?? null
          stableMapSince = Date.now()
          resetPlayerBinding()
          abandonActorForLocalMapTransition()
          console.info('[PokéRun lifecycle] ABANDON REMOTE • GENERIC FIELD ERROR', {
            mapId: failedLocal?.location.mapId ?? null,
            transition: failedLocal?.transition?.id ?? null,
            reason,
          })

          const message = reason instanceof Error ? reason.message : String(reason)
`

if (!source.includes(before)) {
  throw new Error('Expected transition-safe generic cleanup block not found. Apply apply-local-transition-safe-cleanup.mjs first.')
}

source = source.replace(before, after)
fs.writeFileSync(path, source)
console.log('Applied abandon-only generic runtime error handling.')
