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
if (!source.includes(varsBefore)) throw new Error('transition vars anchor not found')
source = source.replace(varsBefore, varsAfter)

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
      // The local field owns the dedicated remote FieldActor. If the local map
      // changes, that field/ActorSystem is unloading, so never enqueue DeleteActor
      // against it. Drop PokéRun's references and let White 2 own teardown.
      binding = null
      ownsActor = false
      resetRemoteAnimation()
      reacquireAfter = 0
    }
`
if (!source.includes(resetBefore)) throw new Error('resetRemoteAnimation anchor not found')
source = source.replace(resetBefore, resetAfter)

const ensureAnchor = `    async function ensureActor(remote: MultiplayerPlayerState) {
`
const helperBlock = `    async function detachDedicatedBillboardAnimation(current: DedicatedBinding) {
      await Promise.all([
        runtimeBridge.write32(current.handleAddress + HANDLE_ANIMS, 0),
        runtimeBridge.write16(current.handleAddress + HANDLE_ANIM_COUNT, 0),
        runtimeBridge.write16(current.handleAddress + HANDLE_ANIM, 0),
        runtimeBridge.write16(current.handleAddress + HANDLE_STEP, 0),
        runtimeBridge.write16(current.handleAddress + HANDLE_WAIT, 0),
        runtimeBridge.write16(current.handleAddress + HANDLE_LOOPS, 0),
        runtimeBridge.write32(current.handleAddress + HANDLE_ANIMATE, 0),
      ])
    }

    async function bindDedicatedActor(actorAddress: number, remote: MultiplayerPlayerState) {
      const rawBinding = await resolveActorBinding(runtimeBridge, actorAddress, POKERUN_NATIVE_TEST_UID)
      const next: DedicatedBinding = { ...rawBinding, nativeRender: await readRenderProfile(runtimeBridge, rawBinding) }
      await detachDedicatedBillboardAnimation(next)
      const world = remote.worldPosition
      if (!world) return null
      const initialProfile = remoteProfile(Date.now(), remote)
      latestRemoteProfile = initialProfile
      await applyRemoteFrame(next, remote, world, initialProfile)
      renderedWorld = { ...world }
      lastRenderAdvanceAt = Date.now()
      binding = next
      ownsActor = true
      return next
    }

${ensureAnchor}`
if (!source.includes(ensureAnchor)) throw new Error('ensureActor anchor not found')
source = source.replace(ensureAnchor, helperBlock)

const spawnAnchor = `      const spawned = await nativeActors.spawnTestActor()
      ownsActor = true
`
const spawnAfter = `      // A local field reload can preserve or recreate the PokéRun UID before
      // this runtime has a binding. Reuse a live actor instead of failing the
      // duplicate-UID safety check or creating a second remote trainer.
      const liveScan = await new White2ActorSystemProbe(runtimeBridge).scanHeap()
      const existing = liveScan.entries.find(entry =>
        entry.uid === POKERUN_NATIVE_TEST_UID
        && entry.state === 'active'
        && entry.actorSystemBackptr === liveScan.actorSystem
      )
      if (existing) {
        console.info('[PokéRun lifecycle] REBIND EXISTING REMOTE', {
          actor: existing.address,
          actorSystem: liveScan.actorSystem,
        })
        return bindDedicatedActor(existing.address, remote)
      }

${spawnAnchor}`
if (!source.includes(spawnAnchor)) throw new Error('spawn anchor not found')
source = source.replace(spawnAnchor, spawnAfter)

const oldSpawnBind = `        const rawBinding = await resolveActorBinding(runtimeBridge, spawned.actorAddress, POKERUN_NATIVE_TEST_UID)
        const next: DedicatedBinding = { ...rawBinding, nativeRender: await readRenderProfile(runtimeBridge, rawBinding) }

        // The BlAct billboard owns its own face animation independently of the
        // FieldActor movement system. White 2's scene-node update repeatedly
        // enables that animation, which can overwrite PokéRun's faceIndex for
        // one rendered frame. Detach the native animation set entirely; the
        // dedicated remote's frames are driven exclusively by PokéRun.
        await Promise.all([
          runtimeBridge.write32(next.handleAddress + HANDLE_ANIMS, 0),
          runtimeBridge.write16(next.handleAddress + HANDLE_ANIM_COUNT, 0),
          runtimeBridge.write16(next.handleAddress + HANDLE_ANIM, 0),
          runtimeBridge.write16(next.handleAddress + HANDLE_STEP, 0),
          runtimeBridge.write16(next.handleAddress + HANDLE_WAIT, 0),
          runtimeBridge.write16(next.handleAddress + HANDLE_LOOPS, 0),
          runtimeBridge.write32(next.handleAddress + HANDLE_ANIMATE, 0),
        ])

        const world = remote.worldPosition
        if (!world) {
          await releaseActor()
          return null
        }
        const initialProfile = remoteProfile(Date.now(), remote)
        latestRemoteProfile = initialProfile
        await applyRemoteFrame(next, remote, world, initialProfile)
        renderedWorld = { ...world }
        lastRenderAdvanceAt = Date.now()
        binding = next
        return next
`
const newSpawnBind = `        const next = await bindDedicatedActor(spawned.actorAddress, remote)
        if (!next) {
          await releaseActor()
          return null
        }
        console.info('[PokéRun lifecycle] SPAWNED REMOTE', { actor: spawned.actorAddress })
        return next
`
if (!source.includes(oldSpawnBind)) throw new Error('spawn binding block not found')
source = source.replace(oldSpawnBind, newSpawnBind)

const tickBefore = `    async function tick() {
      const now = Date.now()
      if (now - lastLearnAt >= LEARN_SAMPLE_MS) {
        lastLearnAt = now
        await learnLocalRender(now)
      }

      const presence = presenceRef.current
      const local = presence.local
      const remote = presence.remote

      if (!local?.worldPosition || !remote?.worldPosition) {
`
const tickAfter = `    async function tick() {
      const now = Date.now()
      const presence = presenceRef.current
      const local = presence.local
      const remote = presence.remote

      // Detect the local map change before touching the old FieldActorSystem.
      // This avoids racing render learning or DeleteActor against an unloading field.
      if (local) {
        const currentLocalMapId = local.location.mapId
        const localMapChanged = lastLocalMapId !== null && lastLocalMapId !== currentLocalMapId
        lastLocalMapId = currentLocalMapId
        if (localMapChanged) {
          console.info('[PokéRun lifecycle] LOCAL MAP CHANGED', {
            mapId: currentLocalMapId,
            remoteMapId: remote?.location.mapId ?? null,
          })
          rangeLatched = false
          stableMapId = currentLocalMapId
          stableMapSince = now
          resetPlayerBinding()
          abandonActorForLocalMapTransition()
          return
        }
      }

      if (now - lastLearnAt >= LEARN_SAMPLE_MS) {
        lastLearnAt = now
        await learnLocalRender(now)
      }

      if (!local?.worldPosition || !remote?.worldPosition) {
`
if (!source.includes(tickBefore)) throw new Error('tick start anchor not found')
source = source.replace(tickBefore, tickAfter)

fs.writeFileSync(path, source)
console.log('Applied combined map-transition recovery experiment.')
