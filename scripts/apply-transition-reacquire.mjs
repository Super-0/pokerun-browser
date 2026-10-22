import fs from 'node:fs'

const path = 'src/multiplayer/games/White2DedicatedTrainerRuntime.tsx'
let source = fs.readFileSync(path, 'utf8')

const helperAnchor = `    async function ensureActor(remote: MultiplayerPlayerState) {
`
const helper = `    async function detachDedicatedBillboardAnimation(current: DedicatedBinding) {
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

${helperAnchor}`

if (!source.includes(helperAnchor)) throw new Error('ensureActor anchor not found')
source = source.replace(helperAnchor, helper)

const spawnAnchor = `      const spawned = await nativeActors.spawnTestActor()
      ownsActor = true
`
const reacquireBlock = `      // A map transition can leave the PokéRun-owned FieldActor alive even after
      // the runtime loses its binding. Reuse that actor instead of treating the
      // surviving UID as a fatal duplicate-spawn condition.
      const liveScan = await new White2ActorSystemProbe(runtimeBridge).scanHeap()
      const existing = liveScan.entries.find(entry =>
        entry.uid === POKERUN_NATIVE_TEST_UID
        && entry.state === 'active'
        && entry.actorSystemBackptr === liveScan.actorSystem
      )
      if (existing) {
        console.debug('[PokéRun] Reacquiring existing dedicated remote actor after field transition.', {
          actor: existing.address,
          actorSystem: liveScan.actorSystem,
        })
        return bindDedicatedActor(existing.address, remote)
      }

${spawnAnchor}`

if (!source.includes(spawnAnchor)) throw new Error('spawn anchor not found')
source = source.replace(spawnAnchor, reacquireBlock)

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
        return next
`

if (!source.includes(oldSpawnBind)) throw new Error('spawn binding block not found')
source = source.replace(oldSpawnBind, newSpawnBind)

fs.writeFileSync(path, source)
console.log('Applied transition actor reacquire experiment.')
