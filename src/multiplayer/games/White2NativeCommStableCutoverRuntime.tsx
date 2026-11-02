import { useEffect, useRef, useState } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerPlayerState, MultiplayerRomIdentity } from '../core/protocol'
import { White2ActorSystemProbe } from './White2ActorSystem'
import { White2NativeCommCutoverRuntime } from './White2NativeCommCutoverRuntime'

// Probe 11 transition-aware gate.
//
// White 2's own CommPlayer system deletes/frees its field communication actors
// before the field closes and recreates them after the next field finishes loading.
// Mirror that lifecycle here instead of carrying FieldActor/FldCommActSys pointers
// across a map transition.
const OBJ_CODE_HERO = 231
const OBJ_CODE_HEROINE = 240
const MMSYS_TCB_MGR = 0x24
const GAME_DATA_GET_FIELD_STATUS = 0x020175b4
const FIELD_STATUS_GET_BUSY_FLAG = 0x02019378
const FLD_STATUS_BUSY_LOADING = 2
const NATIVE_STACK_RESERVE = 0x400
const POLL_MS = 50
const STABLE_MS = 900
const ARRIVAL_STABLE_MS = 0
const ARRIVAL_MAX_AGE_MS = 1600
const MAP_EDGE_MAX_AGE_MS = 1800
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000

function hex(value: number) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 3) === 0
}

function isNormalPlayerModel(modelId: number) {
  return modelId === OBJ_CODE_HERO || modelId === OBJ_CODE_HEROINE
}

function isFreshRemoteDoorArrival(localMapId: number | string, remote: MultiplayerPlayerState) {
  const transition = remote.transition
  if (!transition || transition.kind === 'map-edge') return false
  if (transition.fromMapId === transition.toMapId) return false
  if (transition.toMapId !== localMapId || remote.location.mapId !== localMapId) return false
  const age = Date.now() - transition.detectedAt
  return age >= 0 && age < ARRIVAL_MAX_AGE_MS
}

function isFreshMapEdgeArrival(localMapId: number | string, state: MultiplayerPlayerState) {
  const transition = state.transition
  if (!transition || transition.kind !== 'map-edge') return false
  if (transition.fromMapId === transition.toMapId) return false
  if (transition.toMapId !== localMapId || state.location.mapId !== localMapId) return false
  const age = Date.now() - transition.detectedAt
  return age >= 0 && age < MAP_EDGE_MAX_AGE_MS
}

function isFreshMapEdgeRendezvous(local: MultiplayerPlayerState, remote: MultiplayerPlayerState) {
  const localMapId = local.location.mapId
  return isFreshMapEdgeArrival(localMapId, local) || isFreshMapEdgeArrival(localMapId, remote)
}

function isFreshMapEdgeBridge(local: MultiplayerPlayerState, remote: MultiplayerPlayerState) {
  const localMapId = local.location.mapId
  const remoteMapId = remote.location.mapId
  if (localMapId === remoteMapId) return false

  return [local.transition, remote.transition].some(transition => {
    if (!transition || transition.kind !== 'map-edge') return false
    if (transition.fromMapId === transition.toMapId) return false
    const age = Date.now() - transition.detectedAt
    if (age < 0 || age >= MAP_EDGE_MAX_AGE_MS) return false
    return (transition.fromMapId === localMapId && transition.toMapId === remoteMapId)
      || (transition.fromMapId === remoteMapId && transition.toMapId === localMapId)
  })
}

async function readFieldBusyFlag(bridge: MelonDsBridge, gameData: number) {
  const status = await bridge.callArm9Thumb4(
    GAME_DATA_GET_FIELD_STATUS,
    gameData,
    0,
    0,
    0,
    NATIVE_STACK_RESERVE,
  )
  if (status.status !== 1 || !isMainRamPointer(status.result)) {
    throw new Error(`GameData_GetFieldStatus failed (status ${status.status}, result ${hex(status.result)}).`)
  }

  const busy = await bridge.callArm9Thumb4(
    FIELD_STATUS_GET_BUSY_FLAG,
    status.result,
    0,
    0,
    0,
    NATIVE_STACK_RESERVE,
  )
  if (busy.status !== 1) throw new Error(`FieldStatus_GetBusyFlag failed with status ${busy.status}.`)
  return busy.result >>> 0
}

export function White2NativeCommStableCutoverRuntime({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const presenceRef = useRef<MultiplayerPresenceSnapshot>({ local: null, remote: null })
  const [releaseKey, setReleaseKey] = useState<string | null>(null)

  useEffect(() => multiplayerPresence.subscribe(snapshot => {
    presenceRef.current = snapshot
  }), [])

  useEffect(() => {
    setReleaseKey(null)
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return

    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    let cancelled = false
    let busy = false
    let mountedSignature = ''
    let mountedFieldIdentity = ''
    let stableSignature = ''
    let stableSince = 0
    let lastState = ''

    function resetStableWindow() {
      stableSignature = ''
      stableSince = 0
    }

    function withdraw(reason: string, details: Record<string, unknown> = {}) {
      resetStableWindow()
      if (!mountedSignature) return
      const previous = mountedSignature
      mountedSignature = ''
      mountedFieldIdentity = ''
      setReleaseKey(null)
      console.info('[PokéRun lifecycle] PROBE 11 NATIVE COMM WITHDRAW', {
        reason,
        previousSignature: previous,
        ...details,
        note: 'Native P2 is being deleted/freed before the field lifecycle continues.',
      })
    }

    async function poll() {
      if (cancelled || busy || runtimeBridge.status !== 'running') return
      busy = true
      try {
        const { local, remote } = presenceRef.current
        if (!local || !remote?.worldPosition) {
          withdraw('presence-unavailable')
          lastState = 'presence-unavailable'
          return
        }

        const differentMaps = local.location.mapId !== remote.location.mapId
        const mapEdgeBridge = differentMaps && Boolean(mountedFieldIdentity) && isFreshMapEdgeBridge(local, remote)

        // A verified same-matrix map edge does not tear down the White 2 field.
        // Keep the already-mounted native communication actor alive while one
        // peer's map ID has flipped and the other peer is still finishing the
        // same continuous world-space step. All other map mismatches still
        // remove P2 from this field immediately.
        if (differentMaps && !mapEdgeBridge) {
          withdraw('players-on-different-maps', {
            localMapId: local.location.mapId,
            remoteMapId: remote.location.mapId,
          })
          lastState = 'different-maps'
          return
        }

        const scan = await probe.scanHeap()
        const fieldBusy = await readFieldBusyFlag(runtimeBridge, scan.gameData)

        // This is the same White 2 signal CommPlayer_GetMyStatus uses while a map
        // load is in progress. Native CommPlayer_HideActors is called while the
        // old field still exists; withdrawing here gives our child runtime the
        // same safe window to delete/free its communication actor system.
        if (fieldBusy === FLD_STATUS_BUSY_LOADING) {
          withdraw('field-busy-loading', {
            mapId: local.location.mapId,
            actorSystem: hex(scan.actorSystem),
            busyFlag: fieldBusy,
          })
          lastState = 'loading'
          return
        }

        const player = scan.entries.find(entry => entry.state === 'player')
        const tcbManager = await runtimeBridge.read32(scan.actorSystem + MMSYS_TCB_MGR)
        const modelId = player?.modelId ?? -1
        const healthy = Boolean(
          player
          && isNormalPlayerModel(modelId)
          && isMainRamPointer(player.tcb)
          && player.actorSystemBackptr === scan.actorSystem
          && isMainRamPointer(player.sceneNodeVTable)
          && isMainRamPointer(tcbManager)
        )

        if (!healthy) {
          // Stop exposing the child as soon as the current field stops looking
          // like a stable overworld field. The child itself has additional safety
          // checks and will not write through stale field pointers.
          withdraw('field-not-stable', {
            mapId: local.location.mapId,
            actorSystem: hex(scan.actorSystem),
            modelId,
          })
          lastState = 'unstable'
          return
        }

        const signature = `${String(local.location.mapId)}:${hex(scan.actorSystem)}:${hex(player!.address)}:${modelId}`
        const fieldIdentity = `${hex(scan.actorSystem)}:${hex(player!.address)}:${modelId}`

        // Same-matrix edges only change the logical map ID. If the actual field,
        // player actor, model and scheduler remain the same, preserve the child
        // key so React never unmounts/recreates the native P2 actor.
        if (mountedFieldIdentity && mountedFieldIdentity === fieldIdentity) {
          mountedSignature = signature
          if (mapEdgeBridge && lastState !== 'map-edge-preserved') {
            console.info('[PokéRun lifecycle] PROBE 16 NATIVE COMM MAP EDGE PRESERVED', {
              signature,
              fieldIdentity,
              localMapId: local.location.mapId,
              remoteMapId: remote.location.mapId,
              localTransitionId: local.transition?.id ?? null,
              remoteTransitionId: remote.transition?.id ?? null,
              actorSystem: hex(scan.actorSystem),
              playerActor: hex(player!.address),
              tcbManager: hex(tcbManager),
              busyFlag: fieldBusy,
              note: 'Verified same-matrix edge kept the existing native P2 actor, comm system, shadow and TCB alive across the temporary map-ID mismatch.',
            })
          }
          lastState = mapEdgeBridge ? 'map-edge-preserved' : 'mounted'
          return
        }

        if (mountedSignature === signature) {
          lastState = 'mounted'
          return
        }

        const remoteDoorArrival = isFreshRemoteDoorArrival(local.location.mapId, remote)
        const mapEdgeRendezvous = isFreshMapEdgeRendezvous(local, remote)
        const fastRestore = remoteDoorArrival || mapEdgeRendezvous
        const requiredStableMs = fastRestore ? ARRIVAL_STABLE_MS : STABLE_MS
        const now = performance.now()
        if (stableSignature !== signature) {
          stableSignature = signature
          stableSince = now
          lastState = remoteDoorArrival
            ? 'arrival-stabilizing'
            : mapEdgeRendezvous
              ? 'map-edge-stabilizing'
              : 'stabilizing'
          return
        }
        if (now - stableSince < requiredStableMs) return

        mountedSignature = signature
        mountedFieldIdentity = fieldIdentity
        setReleaseKey(signature)
        lastState = 'mounted'
        const logLabel = remoteDoorArrival
          ? '[PokéRun lifecycle] PROBE 14 NATIVE COMM ARRIVAL RESTORE READY'
          : mapEdgeRendezvous
            ? '[PokéRun lifecycle] PROBE 16 NATIVE COMM MAP EDGE RESTORE READY'
            : '[PokéRun lifecycle] PROBE 11 NATIVE COMM RESTORE READY'
        console.info(logLabel, {
          signature,
          mapId: local.location.mapId,
          modelId,
          stableMs: Math.round(now - stableSince),
          actorSystem: hex(scan.actorSystem),
          tcbManager: hex(tcbManager),
          busyFlag: fieldBusy,
          remoteDoorArrival,
          mapEdgeRendezvous,
          localTransitionId: local.transition?.id ?? null,
          remoteTransitionId: remote.transition?.id ?? null,
          note: remoteDoorArrival
            ? 'Fresh remote door arrival detected; create native P2 immediately while the destination door is still open.'
            : mapEdgeRendezvous
              ? 'Confirmed same-matrix map-edge rendezvous detected; recreate native P2 immediately at the authoritative edge position with no doorway staging.'
              : 'Stable same-map field detected; a fresh native P2 may now be created.',
        })
      } catch (reason) {
        resetStableWindow()
        const message = reason instanceof Error ? reason.message : String(reason)
        // During the middle of White 2's field swap these pointers are expected
        // to disappear. Do not spam logs unless a mounted actor was still exposed.
        if (mountedSignature) withdraw('field-unavailable', { reason: message })
        if (lastState !== 'field-unavailable') {
          lastState = 'field-unavailable'
          console.info('[PokéRun lifecycle] PROBE 11 FIELD UNAVAILABLE', {
            reason: message,
            note: 'Waiting for the next stable field before recreating native P2.',
          })
        }
      } finally {
        busy = false
      }
    }

    void poll()
    const timer = window.setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      mountedSignature = ''
      mountedFieldIdentity = ''
      setReleaseKey(null)
    }
  }, [bridge, rom.gameId, rom.sha256])

  return releaseKey
    ? <White2NativeCommCutoverRuntime key={releaseKey} bridge={bridge} rom={rom}/>
    : null
}
