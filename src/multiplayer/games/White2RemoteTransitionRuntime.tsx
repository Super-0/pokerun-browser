import { useEffect, useRef } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerMapTransition, MultiplayerPlayerState, MultiplayerRomIdentity, MultiplayerWorldPosition } from '../core/protocol'
import { White2DedicatedTrainerRuntime } from './White2DedicatedTrainerRuntime'
import { White2DoorTransitionPlayer } from './White2DoorTransition'
import { White2ActorSystemProbe } from './White2ActorSystem'

const UPDATE_MS = 20
const HANDLE_TIMEOUT_MS = 1400

type ActiveDoor = {
  handle: number
  mapId: number | string
  startedAt: number
}

function delay(ms: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms))
}

function sameMap(a: number | string | undefined, b: number | string | undefined) {
  return a !== undefined && b !== undefined && a === b
}

function inferredTransition(previous: MultiplayerPlayerState, current: MultiplayerPlayerState, now: number): MultiplayerMapTransition | null {
  if (previous.location.mapId === current.location.mapId) return null
  return {
    id: `inferred:${previous.location.mapId}->${current.location.mapId}:${now}`,
    detectedAt: now,
    fromMapId: previous.location.mapId,
    toMapId: current.location.mapId,
    fromX: previous.x,
    fromY: previous.y,
    fromDirection: previous.direction,
    fromWorldPosition: previous.worldPosition ? { ...previous.worldPosition } : undefined,
    toX: current.x,
    toY: current.y,
    toDirection: current.direction,
    toWorldPosition: current.worldPosition ? { ...current.worldPosition } : undefined,
  }
}

/**
 * Adds local-world transition effects around the dedicated remote trainer.
 *
 * The games intentionally keep independent story/map state, so we do not run the
 * remote player's warp on this client. We only replay the visible door prop near
 * the remote player's last/first position. Non-door warps simply produce no prop
 * match and fall back to the existing disappear/reappear lifecycle.
 */
function White2RemoteDoorRuntime({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const presenceRef = useRef<MultiplayerPresenceSnapshot>({ local: null, remote: null })

  useEffect(() => multiplayerPresence.subscribe(snapshot => {
    presenceRef.current = snapshot
  }), [])

  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return
    const runtimeBridge = bridge
    const doors = new White2DoorTransitionPlayer(runtimeBridge, rom)
    let cancelled = false
    let previousRemote: MultiplayerPlayerState | null = null
    let lastHandledTransitionId = ''
    let activeDoor: ActiveDoor | null = null
    let lastWarning = ''

    async function dropActiveDoor(localMapId: number | string | undefined, force = false) {
      const current = activeDoor
      if (!current) return
      activeDoor = null
      // A map unload destroys the old prop system/handle. Never call through a
      // pointer from a different map after the local player transitions.
      if (!force && !sameMap(current.mapId, localMapId)) return
      try {
        await doors.freeHandle(current.handle)
      } catch {
        // Visual effect cleanup is best-effort and must never stop multiplayer.
      }
    }

    async function serviceActiveDoor(localMapId: number | string | undefined, now: number) {
      const current = activeDoor
      if (!current) return
      if (!sameMap(current.mapId, localMapId)) {
        activeDoor = null
        return
      }
      let finished = now - current.startedAt >= HANDLE_TIMEOUT_MS
      if (!finished) {
        try {
          finished = await doors.isAnimationFinished(current.handle)
        } catch {
          finished = true
        }
      }
      if (finished) await dropActiveDoor(localMapId, true)
    }

    async function playDoor(world: MultiplayerWorldPosition | undefined, localMapId: number | string, now: number) {
      if (!world) return
      await dropActiveDoor(localMapId, true)
      try {
        const animation = await doors.playNearestDoor(world)
        if (animation.handle) activeDoor = { handle: animation.handle, mapId: localMapId, startedAt: now }
        lastWarning = ''
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason)
        if (message !== lastWarning) {
          lastWarning = message
          console.warn('White 2 remote door transition skipped:', reason)
        }
      }
    }

    async function handleTransition(transition: MultiplayerMapTransition, local: MultiplayerPlayerState, now: number) {
      if (transition.id === lastHandledTransitionId) return
      lastHandledTransitionId = transition.id

      // Departure: open the door in the map this client is still displaying as
      // the dedicated actor reaches it and disappears into the other map.
      if (sameMap(local.location.mapId, transition.fromMapId)) {
        await playDoor(transition.fromWorldPosition, local.location.mapId, now)
        return
      }

      // Arrival: open the corresponding local door first. The dedicated actor's
      // existing 280 ms stable-map gate naturally makes the trainer appear just
      // after this starts instead of popping in front of a closed door.
      if (sameMap(local.location.mapId, transition.toMapId)) {
        await playDoor(transition.toWorldPosition, local.location.mapId, now)
      }
    }

    async function tick() {
      const now = Date.now()
      const { local, remote } = presenceRef.current
      await serviceActiveDoor(local?.location.mapId, now)
      if (!local || !remote) {
        previousRemote = remote
        return
      }

      // Prefer explicit transition metadata when available. The inferred path
      // keeps this compatible with peers that only publish ordinary state.
      const transition = remote.transition
        ?? (previousRemote ? inferredTransition(previousRemote, remote, now) : null)
      previousRemote = remote
      if (transition) await handleTransition(transition, local, now)
    }

    async function run() {
      while (!cancelled) {
        if (runtimeBridge.status === 'running') {
          try {
            await tick()
          } catch (reason) {
            const message = reason instanceof Error ? reason.message : String(reason)
            if (message !== lastWarning) {
              lastWarning = message
              console.warn('White 2 remote transition runtime paused for one tick:', reason)
            }
          }
        }
        await delay(UPDATE_MS)
      }
    }

    void run()
    return () => {
      cancelled = true
      const localMapId = presenceRef.current.local?.location.mapId
      void dropActiveDoor(localMapId, true)
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}

/** Production White 2 remote-player stack: real FieldActor + local transition visuals. */
export function White2RemoteTransitionRuntime({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  return <>
    <White2DedicatedTrainerRuntime bridge={bridge} rom={rom}/>
    <White2RemoteDoorRuntime bridge={bridge} rom={rom}/>
  </>
}
