import { useEffect, useRef } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerRomIdentity } from '../core/protocol'
import { POKERUN_NATIVE_TEST_UID } from './White2NativeActor'
import { White2ActorSystemProbe } from './White2ActorSystem'

const PLAYER_UID = 0x00ff
const ACTOR_UID = 0x08
const ACTOR_MODEL_ID = 0x0c
const ACTOR_GPOS = 0x3c
const ACTOR_WPOS = 0x44
const ACTOR_MODEL_POS_OFFSET = 0x7e
const ACTOR_SHADOW_GROUP = 0x81
const ACTOR_SYSTEM_BACKPTR = 0x88
const ACTOR_SYSTEM_FIELD_BLACT = 0x28

const FIELD_BLACT_SYSTEM = 0x04
const BLACT_SYSTEM_SCENE = 0x04
const BLACT_SYSTEM_ACTOR_HANDLES = 0x18
const BLACT_SYSTEM_ACTOR_COUNT = 0x1c
const BLACT_SCENE_ACTORS = 0x08
const BLACT_SCENE_CONFIG_ACTOR_COUNT = 0x0e
const BLACT_SIZE = 0x1c
const BLACT_GEOM_FLAGS = 0x00
const BLACT_POSITION = 0x04
const BLACT_FACE_INDEX = 0x10
const BLACT_MAT_FLAGS = 0x18
const HANDLE_SIZE = 0x28
const HANDLE_BLACT_INDEX = 0x00
const HANDLE_MAT_ENTRY = 0x04

const FLDACT_GET_BLACT_IDX = 0x02167240
const NATIVE_STACK_RESERVE = 0x400
const BLACT_NONE = 0xffff
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000
const SAMPLE_MS = 1000

type BillboardBinding = {
  index: number
  blActAddress: number
  handleAddress: number
}

type ActorAlignmentSnapshot = {
  actorAddress: number
  modelId: number
  grid: { x: number; height: number; y: number }
  world: { x: number; y: number; z: number }
  modelOffset: { x: number; y: number; z: number }
  shadowGroup: number
  billboard: {
    index: number
    x: number
    y: number
    z: number
    minusWorldY: number
    faceIndex: number
    geomFlags: number
    matFlags: number
    matEntry: number
  } | null
}

type AlignmentDiagnosticSnapshot = {
  capturedAt: number
  presence: {
    localMapId: number | string | undefined
    remoteMapId: number | string | undefined
    localMovementState: string | undefined
    remoteMovementState: string | undefined
    localPublishedWorldY: number | undefined
    remotePublishedWorldY: number | undefined
  }
  local: ActorAlignmentSnapshot
  remote: ActorAlignmentSnapshot
  delta: {
    worldYRemoteMinusLocal: number
    billboardYRemoteMinusLocal: number | null
    billboardMinusWorldYLocal: number | null
    billboardMinusWorldYRemote: number | null
  }
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 0x3) === 0
}

function signed8(value: number) {
  return value & 0x80 ? value - 0x100 : value
}

function signed16(value: number) {
  return value & 0x8000 ? value - 0x10000 : value
}

function signed32(value: number) {
  return value | 0
}

async function resolveBillboard(bridge: MelonDsBridge, actorAddress: number): Promise<BillboardBinding | null> {
  const actorSystem = await bridge.read32(actorAddress + ACTOR_SYSTEM_BACKPTR)
  if (!isMainRamPointer(actorSystem)) return null

  const call = await bridge.callArm9Thumb4(FLDACT_GET_BLACT_IDX, actorAddress, 0, 0, 0, NATIVE_STACK_RESERVE)
  if (call.status !== 1) return null
  const index = call.result & 0xffff
  if (index === BLACT_NONE) return null

  const fieldBlAct = await bridge.read32(actorSystem + ACTOR_SYSTEM_FIELD_BLACT)
  if (!isMainRamPointer(fieldBlAct)) return null
  const blActSystem = await bridge.read32(fieldBlAct + FIELD_BLACT_SYSTEM)
  if (!isMainRamPointer(blActSystem)) return null

  const [scene, handles, handleCount] = await Promise.all([
    bridge.read32(blActSystem + BLACT_SYSTEM_SCENE),
    bridge.read32(blActSystem + BLACT_SYSTEM_ACTOR_HANDLES),
    bridge.read16(blActSystem + BLACT_SYSTEM_ACTOR_COUNT),
  ])
  if (!isMainRamPointer(scene) || !isMainRamPointer(handles)) return null

  const [sceneActors, sceneActorCount] = await Promise.all([
    bridge.read32(scene + BLACT_SCENE_ACTORS),
    bridge.read16(scene + BLACT_SCENE_CONFIG_ACTOR_COUNT),
  ])
  if (!isMainRamPointer(sceneActors) || index >= sceneActorCount) return null

  let handleAddress = 0
  for (let handleIndex = 0; handleIndex < handleCount; handleIndex += 1) {
    const candidate = handles + handleIndex * HANDLE_SIZE
    if (await bridge.read32(candidate + HANDLE_BLACT_INDEX) !== index) continue
    if (handleAddress !== 0) return null
    handleAddress = candidate
  }
  if (!handleAddress) return null

  return {
    index,
    blActAddress: sceneActors + index * BLACT_SIZE,
    handleAddress,
  }
}

async function readActorSnapshot(bridge: MelonDsBridge, actorAddress: number): Promise<ActorAlignmentSnapshot> {
  const billboard = await resolveBillboard(bridge, actorAddress)
  const [modelId, gridX, rawHeight, gridY, worldX, worldY, worldZ, offsetX, offsetY, offsetZ, shadowGroup] = await Promise.all([
    bridge.read16(actorAddress + ACTOR_MODEL_ID),
    bridge.read16(actorAddress + ACTOR_GPOS + 0x00),
    bridge.read16(actorAddress + ACTOR_GPOS + 0x02),
    bridge.read16(actorAddress + ACTOR_GPOS + 0x04),
    bridge.read32(actorAddress + ACTOR_WPOS + 0x00),
    bridge.read32(actorAddress + ACTOR_WPOS + 0x04),
    bridge.read32(actorAddress + ACTOR_WPOS + 0x08),
    bridge.read8(actorAddress + ACTOR_MODEL_POS_OFFSET + 0x00),
    bridge.read8(actorAddress + ACTOR_MODEL_POS_OFFSET + 0x01),
    bridge.read8(actorAddress + ACTOR_MODEL_POS_OFFSET + 0x02),
    bridge.read8(actorAddress + ACTOR_SHADOW_GROUP),
  ])

  let billboardSnapshot: ActorAlignmentSnapshot['billboard'] = null
  if (billboard) {
    const [x, y, z, faceIndex, geomFlags, matFlags, matEntry] = await Promise.all([
      bridge.read32(billboard.blActAddress + BLACT_POSITION + 0x00),
      bridge.read32(billboard.blActAddress + BLACT_POSITION + 0x04),
      bridge.read32(billboard.blActAddress + BLACT_POSITION + 0x08),
      bridge.read16(billboard.blActAddress + BLACT_FACE_INDEX),
      bridge.read16(billboard.blActAddress + BLACT_GEOM_FLAGS),
      bridge.read16(billboard.blActAddress + BLACT_MAT_FLAGS),
      bridge.read16(billboard.handleAddress + HANDLE_MAT_ENTRY),
    ])
    billboardSnapshot = {
      index: billboard.index,
      x: signed32(x),
      y: signed32(y),
      z: signed32(z),
      minusWorldY: signed32(y) - signed32(worldY),
      faceIndex,
      geomFlags,
      matFlags,
      matEntry,
    }
  }

  return {
    actorAddress,
    modelId,
    grid: { x: gridX, height: signed16(rawHeight), y: gridY },
    world: { x: signed32(worldX), y: signed32(worldY), z: signed32(worldZ) },
    modelOffset: { x: signed8(offsetX), y: signed8(offsetY), z: signed8(offsetZ) },
    shadowGroup,
    billboard: billboardSnapshot,
  }
}

function exposeSnapshot(snapshot: AlignmentDiagnosticSnapshot) {
  ;(window as unknown as { __POKERUN_WHITE2_ALIGNMENT?: AlignmentDiagnosticSnapshot }).__POKERUN_WHITE2_ALIGNMENT = snapshot
}

/** Read-only instrumentation for local-vs-remote vertical/render alignment. */
export function White2AlignmentDiagnostics({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const presenceRef = useRef<MultiplayerPresenceSnapshot>({ local: null, remote: null })

  useEffect(() => multiplayerPresence.subscribe(snapshot => {
    presenceRef.current = snapshot
  }), [])

  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return
    const runtimeBridge = bridge
    let cancelled = false
    let lastSignature = ''
    let localActorAddress = 0
    let remoteActorAddress = 0

    async function ensureActorAddresses() {
      if (localActorAddress && remoteActorAddress) {
        const [localUid, remoteUid] = await Promise.all([
          runtimeBridge.read16(localActorAddress + ACTOR_UID),
          runtimeBridge.read16(remoteActorAddress + ACTOR_UID),
        ])
        if (localUid === PLAYER_UID && remoteUid === POKERUN_NATIVE_TEST_UID) {
          return { localActorAddress, remoteActorAddress }
        }
        localActorAddress = 0
        remoteActorAddress = 0
      }

      const scan = await new White2ActorSystemProbe(runtimeBridge).scanHeap()
      const localActor = scan.entries.find(entry => entry.uid === PLAYER_UID && entry.state === 'player')
      const remoteActor = scan.entries.find(entry => entry.uid === POKERUN_NATIVE_TEST_UID && entry.state === 'active')
      if (!localActor || !remoteActor) return null
      localActorAddress = localActor.address
      remoteActorAddress = remoteActor.address
      return { localActorAddress, remoteActorAddress }
    }

    async function sample() {
      if (cancelled || runtimeBridge.status !== 'running') return
      const presence = presenceRef.current
      if (!presence.local || !presence.remote || presence.local.location.mapId !== presence.remote.location.mapId) return

      const addresses = await ensureActorAddresses()
      if (!addresses) return

      const [local, remote] = await Promise.all([
        readActorSnapshot(runtimeBridge, addresses.localActorAddress),
        readActorSnapshot(runtimeBridge, addresses.remoteActorAddress),
      ])

      const snapshot: AlignmentDiagnosticSnapshot = {
        capturedAt: Date.now(),
        presence: {
          localMapId: presence.local.location.mapId,
          remoteMapId: presence.remote.location.mapId,
          localMovementState: presence.local.movementState,
          remoteMovementState: presence.remote.movementState,
          localPublishedWorldY: presence.local.worldPosition?.y,
          remotePublishedWorldY: presence.remote.worldPosition?.y,
        },
        local,
        remote,
        delta: {
          worldYRemoteMinusLocal: remote.world.y - local.world.y,
          billboardYRemoteMinusLocal: local.billboard && remote.billboard ? remote.billboard.y - local.billboard.y : null,
          billboardMinusWorldYLocal: local.billboard?.minusWorldY ?? null,
          billboardMinusWorldYRemote: remote.billboard?.minusWorldY ?? null,
        },
      }
      exposeSnapshot(snapshot)

      const signature = JSON.stringify({
        localWorldY: local.world.y,
        remoteWorldY: remote.world.y,
        localBlActDelta: local.billboard?.minusWorldY,
        remoteBlActDelta: remote.billboard?.minusWorldY,
        localOffset: local.modelOffset,
        remoteOffset: remote.modelOffset,
        localShadow: local.shadowGroup,
        remoteShadow: remote.shadowGroup,
      })
      if (signature !== lastSignature) {
        lastSignature = signature
        console.info('[PokéRun] White 2 alignment diagnostic', snapshot)
      }
    }

    const timer = window.setInterval(() => {
      void sample().catch(reason => console.debug('[PokéRun] White 2 alignment diagnostic skipped:', reason))
    }, SAMPLE_MS)
    void sample().catch(() => undefined)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
