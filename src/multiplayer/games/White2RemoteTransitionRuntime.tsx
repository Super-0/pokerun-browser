import { useEffect, useRef, useState } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerMapTransition, MultiplayerPlayerState, MultiplayerRomIdentity, MultiplayerWorldPosition } from '../core/protocol'
import { White2DedicatedTrainerRuntime } from './White2DedicatedTrainerRuntime'
import { White2DoorTransitionPlayer } from './White2DoorTransition'
import { White2ActorSystemProbe } from './White2ActorSystem'

const UPDATE_MS = 20
const HANDLE_TIMEOUT_MS = 1400
const LEGACY_RENDER_CACHE_VERSION = 4
const MAP_RENDER_CACHE_VERSION = 1

type MapId = MultiplayerPlayerState['location']['mapId']

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

function globalRenderCachePrefix(rom: MultiplayerRomIdentity) {
  return `pokerun-white2-trainer-render-v${LEGACY_RENDER_CACHE_VERSION}:${rom.sha256 ?? 'unknown'}:`
}

function scopedRenderCachePrefix(rom: MultiplayerRomIdentity, mapId: MapId) {
  return `pokerun-white2-trainer-render-map-v${MAP_RENDER_CACHE_VERSION}:${rom.sha256 ?? 'unknown'}:${encodeURIComponent(String(mapId))}:`
}

function storageKeys() {
  const keys: string[] = []
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key) keys.push(key)
    }
  } catch {
    // Renderer caching is optional; live learning still works without storage.
  }
  return keys
}

/** Preserve the current runtime cache before its map-scoped instance unmounts. */
function snapshotRenderCacheForMap(rom: MultiplayerRomIdentity, mapId: MapId) {
  try {
    const globalPrefix = globalRenderCachePrefix(rom)
    const scopedPrefix = scopedRenderCachePrefix(rom, mapId)
    for (const key of storageKeys()) {
      if (!key.startsWith(globalPrefix)) continue
      const modelId = key.slice(globalPrefix.length)
      if (!modelId) continue
      const value = localStorage.getItem(key)
      if (value !== null) localStorage.setItem(`${scopedPrefix}${modelId}`, value)
    }
  } catch {
    // Multiplayer continues if localStorage is unavailable.
  }
}

/**
 * Activate only the render knowledge learned on this map.
 *
 * White 2 legitimately uses different billboard material/geometry families in
 * different fields (for example map 427 uses 13/13 while map 428 uses 0/0).
 * White2DedicatedTrainerRuntime historically cached only by protagonist model,
 * so entering a building could teach the indoor renderer and replay it onto the
 * outdoor remote actor later. Keep the existing runtime untouched and swap its
 * legacy cache slot as the local field changes.
 */
function restoreRenderCacheForMap(rom: MultiplayerRomIdentity, mapId: MapId) {
  try {
    const globalPrefix = globalRenderCachePrefix(rom)
    const scopedPrefix = scopedRenderCachePrefix(rom, mapId)

    // Remove the legacy/unscoped cache first. On the first run after this fix,
    // that deliberately discards any already-contaminated v4 data.
    for (const key of storageKeys()) {
      if (key.startsWith(globalPrefix)) localStorage.removeItem(key)
    }

    // Rehydrate only cache entries previously learned on this exact map.
    for (const key of storageKeys()) {
      if (!key.startsWith(scopedPrefix)) continue
      const modelId = key.slice(scopedPrefix.length)
      if (!modelId) continue
      const value = localStorage.getItem(key)
      if (value !== null) localStorage.setItem(`${globalPrefix}${modelId}`, value)
    }
  } catch {
    // Multiplayer continues if localStorage is unavailable.
  }
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
 * Owns one dedicated-trainer runtime per local field/render family.
 *
 * The previous map is removed for one React commit before the next map mounts.
 * That guarantees the old runtime has finished cleanup before its legacy cache
 * slot is replaced with the next map's scoped copy.
 */
function White2MapScopedTrainerRuntime({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const [desiredMapId, setDesiredMapId] = useState<MapId | null>(null)
  const [activeMapId, setActiveMapId] = useState<MapId | null>(null)
  const activeMapRef = useRef<MapId | null>(null)

  useEffect(() => multiplayerPresence.subscribe(snapshot => {
    const nextMapId = snapshot.local?.location.mapId ?? null
    const currentMapId = activeMapRef.current
    if (currentMapId !== null && nextMapId !== currentMapId) {
      // Snapshot synchronously, before React unmounts the old runtime and its
      // cleanup can save a transition frame into the legacy cache slot.
      snapshotRenderCacheForMap(rom, currentMapId)
    }
    setDesiredMapId(previous => previous === nextMapId ? previous : nextMapId)
  }), [rom.gameId, rom.sha256])

  useEffect(() => {
    if (desiredMapId === activeMapId) return
    if (desiredMapId === null) {
      activeMapRef.current = null
      setActiveMapId(null)
      return
    }

    // This effect runs after the old keyed runtime has unmounted. Its cleanup may
    // have rewritten the legacy cache slot, so replace that slot now with only
    // the cache belonging to the field we're about to mount.
    restoreRenderCacheForMap(rom, desiredMapId)
    activeMapRef.current = desiredMapId
    setActiveMapId(desiredMapId)
    console.info('[PokéRun rendercache] MAP SCOPE ACTIVE', { mapId: desiredMapId })
  }, [activeMapId, desiredMapId, rom.gameId, rom.sha256])

  if (desiredMapId === null || activeMapId === null || desiredMapId !== activeMapId) return null
  return <White2DedicatedTrainerRuntime key={String(activeMapId)} bridge={bridge} rom={rom}/>
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
        console.info('[PokéRun door] PLAY NEAREST DOOR', { mapId: localMapId, world })
        const animation = await doors.playNearestDoor(world)
        console.info('[PokéRun door] DOOR RESULT', {
          mapId: localMapId,
          matched: animation.matched,
          handle: animation.handle,
          world,
        })
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
        console.info('[PokéRun door] REMOTE DEPARTURE', {
          id: transition.id,
          fromMapId: transition.fromMapId,
          toMapId: transition.toMapId,
          fromWorldPosition: transition.fromWorldPosition ?? null,
        })
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
    <White2MapScopedTrainerRuntime bridge={bridge} rom={rom}/>
    <White2RemoteDoorRuntime bridge={bridge} rom={rom}/>
  </>
}
