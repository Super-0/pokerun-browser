import { useEffect, useRef } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerRomIdentity } from '../core/protocol'
import { POKERUN_NATIVE_TEST_UID, White2NativeActorBridge, White2NativeActorUnsafeStateError } from './White2NativeActor'
import { White2ActorSystemProbe } from './White2ActorSystem'

const REMOTE_DOOR_DEPARTURE_TOTAL_MS = 430 + 260
const POLL_MS = 32

/**
 * Once P2 is truly off the local map, remove its old FieldActor instead of
 * leaving an invisible actor behind. Hidden actors still participate in the
 * field actor system and can leave a shadow/collision object parked in a door.
 */
export function White2OffMapRemoteCleanup({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const presenceRef = useRef<MultiplayerPresenceSnapshot>({ local: null, remote: null })

  useEffect(() => multiplayerPresence.subscribe(snapshot => {
    presenceRef.current = snapshot
  }), [])

  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return
    const runtimeBridge = bridge
    const nativeActors = new White2NativeActorBridge(runtimeBridge, rom)
    const probe = new White2ActorSystemProbe(runtimeBridge)
    let cancelled = false
    let cleaning = false
    let unsafe = false

    async function service() {
      if (cancelled || cleaning || unsafe || runtimeBridge.status !== 'running') return
      const { local, remote } = presenceRef.current
      if (!local || !remote || local.location.mapId === remote.location.mapId) return

      const transition = remote.transition
      if (
        transition
        && transition.fromMapId === local.location.mapId
        && transition.toMapId === remote.location.mapId
      ) {
        const age = Date.now() - transition.detectedAt
        if (age >= 0 && age < REMOTE_DOOR_DEPARTURE_TOTAL_MS) return
      }

      cleaning = true
      try {
        const scan = await probe.scanHeap()
        const remoteActor = scan.entries.find(entry =>
          entry.uid === POKERUN_NATIVE_TEST_UID
          && entry.state === 'active'
          && entry.actorSystemBackptr === scan.actorSystem
        )
        if (!remoteActor) return

        await nativeActors.deleteTestActor(remoteActor.address)
        console.info('[PokéRun lifecycle] REMOVED OFF-MAP REMOTE ACTOR', {
          actor: remoteActor.address,
          localMapId: local.location.mapId,
          remoteMapId: remote.location.mapId,
          transition: transition?.id ?? null,
        })
      } catch (reason) {
        if (reason instanceof White2NativeActorUnsafeStateError) {
          unsafe = true
          console.warn('White 2 off-map remote cleanup stopped native calls:', reason)
        }
      } finally {
        cleaning = false
      }
    }

    const unsubscribeFrame = runtimeBridge.subscribeEmulatedFrame(() => {
      void service()
    })
    const timer = window.setInterval(() => void service(), POLL_MS)

    return () => {
      cancelled = true
      unsubscribeFrame()
      window.clearInterval(timer)
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
