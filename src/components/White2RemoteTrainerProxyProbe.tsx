import { useEffect, useRef, useState } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../multiplayer/core/MultiplayerPresence'
import type { MultiplayerPlayerState, MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2ActorSystemProbe, type White2ActorHeapEntry } from '../multiplayer/games/White2ActorSystem'
import { PixelButton } from './PixelButton'

const ACTOR_SYSTEM_FIELD_BLACT = 0x28
const ACTOR_UID = 0x08
const ACTOR_MODEL_ID = 0x0c
const ACTOR_FACE_DIR = 0x18
const ACTOR_WPOS = 0x44
const ACTOR_TCB = 0x84

const FIELD_BLACT_SYSTEM = 0x04
const BLACT_SYSTEM_SCENE = 0x04
const BLACT_SYSTEM_ACTOR_HANDLES = 0x18
const BLACT_SYSTEM_ACTOR_COUNT = 0x1c
const BLACT_SCENE_ACTORS = 0x08
const BLACT_SCENE_CONFIG_ACTOR_COUNT = 0x0e

const BLACT_SIZE = 0x1c
const BLACT_POSITION = 0x04
const BLACT_FACE_INDEX = 0x10
const BLACT_HANDLE_SIZE = 0x28
const BLACT_HANDLE_ACTOR_INDEX = 0x00
const BLACT_HANDLE_MAT_ENTRY_INDEX = 0x04

const STANDARD_NPC_SCENE_VTABLE = 0x021cf92c
const SPECIAL_PLAYER_COMPANION_UID = 0x00fe
const PLAYER_UID = 0x00ff
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000
const TILE_FX32 = 16 * 4096
const TEST_MS = 10_000
const UPDATE_MS = 50
const MOVING_HOLD_MS = 350
const MAX_REMOTE_DX = 7
const MAX_REMOTE_DY = 5
const WALK_CYCLE = [0, 1, 2, 1] as const

const FIELD_FACE_BY_DIRECTION = { north: 0, south: 1, west: 2, east: 3 } as const
const TRAINER_FACE_BASE = { north: 0, south: 3, west: 6, east: 9 } as const

type OriginalProxyState = {
  slot: number
  address: number
  uid: number
  modelId: number
  tcb: number
  faceDir: number
  wposX: number
  wposY: number
  wposZ: number
  blActIndex: number
  blActAddress: number
  blActFace: number
  handleIndex: number
  handleAddress: number
  matEntry: number
}

function hex(value: number) {
  return value.toString(16).toUpperCase().padStart(8, '0')
}

function signed32(value: number) {
  return value | 0
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 0x3) === 0
}

function delay(ms: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms))
}

function chooseStandardNpc(entries: White2ActorHeapEntry[], player: White2ActorHeapEntry) {
  return entries
    .filter(entry => entry.state === 'active' && entry.uid !== SPECIAL_PLAYER_COMPANION_UID && entry.sceneNodeVTable === STANDARD_NPC_SCENE_VTABLE)
    .sort((a, b) => (Math.abs(a.x - player.x) + Math.abs(a.y - player.y)) - (Math.abs(b.x - player.x) + Math.abs(b.y - player.y)))[0]
}

function trainerFace(direction: MultiplayerPlayerState['direction'], moving: boolean, walkTick: number) {
  const base = TRAINER_FACE_BASE[direction]
  return moving ? base + WALK_CYCLE[walkTick % WALK_CYCLE.length] : base + 1
}

export function White2RemoteTrainerProxyProbe({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [presence, setPresence] = useState<MultiplayerPresenceSnapshot>({ local: null, remote: null })
  const presenceRef = useRef<MultiplayerPresenceSnapshot>(presence)
  const supported = White2ActorSystemProbe.supportsRom(rom)

  useEffect(() => multiplayerPresence.subscribe(snapshot => {
    presenceRef.current = snapshot
    setPresence(snapshot)
  }), [])

  async function findBillboard(sceneActors: number, actorCount: number, entry: White2ActorHeapEntry) {
    if (!bridge) throw new Error('melonDS bridge is unavailable.')
    const [wposX, wposY, wposZ] = await Promise.all([
      bridge.read32(entry.address + ACTOR_WPOS + 0x00),
      bridge.read32(entry.address + ACTOR_WPOS + 0x04),
      bridge.read32(entry.address + ACTOR_WPOS + 0x08),
    ])

    let bestIndex = -1
    let bestAddress = 0
    let bestDistance = Number.POSITIVE_INFINITY
    for (let index = 0; index < actorCount; index += 1) {
      const address = sceneActors + index * BLACT_SIZE
      const [x, y, z] = await Promise.all([
        bridge.read32(address + BLACT_POSITION + 0x00),
        bridge.read32(address + BLACT_POSITION + 0x04),
        bridge.read32(address + BLACT_POSITION + 0x08),
      ])
      const distance = Math.abs(signed32(x) - signed32(wposX)) + Math.abs(signed32(y) - signed32(wposY)) + Math.abs(signed32(z) - signed32(wposZ))
      if (distance < bestDistance) {
        bestIndex = index
        bestAddress = address
        bestDistance = distance
      }
    }
    if (bestIndex < 0) throw new Error(`Could not resolve billboard actor for slot ${entry.index}.`)
    return { index: bestIndex, address: bestAddress, distance: bestDistance }
  }

  async function findHandle(actorHandles: number, handleCount: number, blActIndex: number) {
    if (!bridge) throw new Error('melonDS bridge is unavailable.')
    const matches: Array<{ index: number; address: number; matEntry: number }> = []
    for (let index = 0; index < handleCount; index += 1) {
      const address = actorHandles + index * BLACT_HANDLE_SIZE
      const [owner, matEntry] = await Promise.all([
        bridge.read32(address + BLACT_HANDLE_ACTOR_INDEX),
        bridge.read16(address + BLACT_HANDLE_MAT_ENTRY_INDEX),
      ])
      if (owner === blActIndex) matches.push({ index, address, matEntry })
    }
    if (matches.length !== 1) throw new Error(`Expected exactly one billboard handle for BlAct ${blActIndex}, found ${matches.length}.`)
    return matches[0]
  }

  async function actorIdentityMatches(entry: White2ActorHeapEntry) {
    if (!bridge) return false
    const [uid, modelId, tcb] = await Promise.all([
      bridge.read16(entry.address + ACTOR_UID),
      bridge.read16(entry.address + ACTOR_MODEL_ID),
      bridge.read32(entry.address + ACTOR_TCB),
    ])
    return uid === entry.uid && modelId === entry.modelId && tcb === entry.tcb
  }

  async function restore(original: OriginalProxyState) {
    if (!bridge) return false
    const [uid, modelId, tcb, handleOwner] = await Promise.all([
      bridge.read16(original.address + ACTOR_UID),
      bridge.read16(original.address + ACTOR_MODEL_ID),
      bridge.read32(original.address + ACTOR_TCB),
      bridge.read32(original.handleAddress + BLACT_HANDLE_ACTOR_INDEX),
    ])
    if (uid !== original.uid || modelId !== original.modelId || tcb !== original.tcb || handleOwner !== original.blActIndex) return false

    await Promise.all([
      bridge.write16(original.address + ACTOR_FACE_DIR, original.faceDir),
      bridge.write32(original.address + ACTOR_WPOS + 0x00, original.wposX),
      bridge.write32(original.address + ACTOR_WPOS + 0x04, original.wposY),
      bridge.write32(original.address + ACTOR_WPOS + 0x08, original.wposZ),
      bridge.write16(original.blActAddress + BLACT_FACE_INDEX, original.blActFace),
      bridge.write16(original.handleAddress + BLACT_HANDLE_MAT_ENTRY_INDEX, original.matEntry),
    ])

    const [faceDir, wposX, wposY, wposZ, blActFace, matEntry] = await Promise.all([
      bridge.read16(original.address + ACTOR_FACE_DIR),
      bridge.read32(original.address + ACTOR_WPOS + 0x00),
      bridge.read32(original.address + ACTOR_WPOS + 0x04),
      bridge.read32(original.address + ACTOR_WPOS + 0x08),
      bridge.read16(original.blActAddress + BLACT_FACE_INDEX),
      bridge.read16(original.handleAddress + BLACT_HANDLE_MAT_ENTRY_INDEX),
    ])
    return faceDir === original.faceDir && wposX === original.wposX && wposY === original.wposY && wposZ === original.wposZ && blActFace === original.blActFace && matEntry === original.matEntry
  }

  async function runProxy() {
    if (!bridge || !supported) return
    setBusy(true)
    setResult(null)
    const wasRunning = bridge.status === 'running'
    let original: OriginalProxyState | null = null

    try {
      if (!wasRunning) throw new Error('Native remote trainer proxy requires melonDS to be running.')
      const startPresence = presenceRef.current
      if (!startPresence.local || !startPresence.remote) throw new Error('Two live multiplayer player states are required.')
      if (startPresence.local.location.mapId !== startPresence.remote.location.mapId) throw new Error('Both players must be on the same map.')
      const startMap = startPresence.local.location.mapId

      await bridge.pause()
      const scan = await new White2ActorSystemProbe(bridge).scanHeap()
      if (scan.suspiciousSlots.length) throw new Error('Proxy test blocked because suspicious actor slots are present.')
      const player = scan.entries.find(entry => entry.state === 'player')
      if (!player || player.uid !== PLAYER_UID) throw new Error('Live player actor was not found.')
      const npc = chooseStandardNpc(scan.entries, player)
      if (!npc) throw new Error('No standard live NPC is available to borrow as the remote trainer proxy.')

      const fieldBlAct = await bridge.read32(scan.actorSystem + ACTOR_SYSTEM_FIELD_BLACT)
      if (!isMainRamPointer(fieldBlAct)) throw new Error(`FieldBlAct pointer is invalid (0x${hex(fieldBlAct)}).`)
      const blActSystem = await bridge.read32(fieldBlAct + FIELD_BLACT_SYSTEM)
      if (!isMainRamPointer(blActSystem)) throw new Error(`BlActSystem pointer is invalid (0x${hex(blActSystem)}).`)
      const [scene, actorHandles, handleCount] = await Promise.all([
        bridge.read32(blActSystem + BLACT_SYSTEM_SCENE),
        bridge.read32(blActSystem + BLACT_SYSTEM_ACTOR_HANDLES),
        bridge.read16(blActSystem + BLACT_SYSTEM_ACTOR_COUNT),
      ])
      if (!isMainRamPointer(scene) || !isMainRamPointer(actorHandles)) throw new Error('Billboard scene/handle pointers are invalid.')
      const [sceneActors, sceneActorCount] = await Promise.all([
        bridge.read32(scene + BLACT_SCENE_ACTORS),
        bridge.read16(scene + BLACT_SCENE_CONFIG_ACTOR_COUNT),
      ])
      if (!isMainRamPointer(sceneActors)) throw new Error('Billboard actor array pointer is invalid.')
      if (sceneActorCount < 1 || sceneActorCount > 256 || handleCount < 1 || handleCount > 256) throw new Error('Billboard actor/handle counts are unexpected.')

      const [playerBlAct, npcBlAct] = await Promise.all([
        findBillboard(sceneActors, sceneActorCount, player),
        findBillboard(sceneActors, sceneActorCount, npc),
      ])
      const [playerHandle, npcHandle] = await Promise.all([
        findHandle(actorHandles, handleCount, playerBlAct.index),
        findHandle(actorHandles, handleCount, npcBlAct.index),
      ])

      const [npcFaceDir, npcWPosX, npcWPosY, npcWPosZ, npcBlActFace, playerMatEntry, npcMatEntry] = await Promise.all([
        bridge.read16(npc.address + ACTOR_FACE_DIR),
        bridge.read32(npc.address + ACTOR_WPOS + 0x00),
        bridge.read32(npc.address + ACTOR_WPOS + 0x04),
        bridge.read32(npc.address + ACTOR_WPOS + 0x08),
        bridge.read16(npcBlAct.address + BLACT_FACE_INDEX),
        bridge.read16(playerHandle.address + BLACT_HANDLE_MAT_ENTRY_INDEX),
        bridge.read16(npcHandle.address + BLACT_HANDLE_MAT_ENTRY_INDEX),
      ])

      original = {
        slot: npc.index,
        address: npc.address,
        uid: npc.uid,
        modelId: npc.modelId,
        tcb: npc.tcb,
        faceDir: npcFaceDir,
        wposX: npcWPosX,
        wposY: npcWPosY,
        wposZ: npcWPosZ,
        blActIndex: npcBlAct.index,
        blActAddress: npcBlAct.address,
        blActFace: npcBlActFace,
        handleIndex: npcHandle.index,
        handleAddress: npcHandle.address,
        matEntry: npcMatEntry,
      }

      const [playerOwner, npcOwner] = await Promise.all([
        bridge.read32(playerHandle.address + BLACT_HANDLE_ACTOR_INDEX),
        bridge.read32(npcHandle.address + BLACT_HANDLE_ACTOR_INDEX),
      ])
      if (playerOwner !== playerBlAct.index || npcOwner !== npcBlAct.index) throw new Error('Billboard handle ownership changed before the proxy started.')
      if (playerMatEntry === npcMatEntry) throw new Error('Player and NPC already use the same billboard material; proxy appearance test would be ambiguous.')

      await bridge.resume()
      const deadline = Date.now() + TEST_MS
      let updates = 0
      let walkTick = 0
      let movingUntil = 0
      let previousRemoteX = startPresence.remote.x
      let previousRemoteY = startPresence.remote.y
      let lastDx = 0
      let lastDy = 0
      let lastFrame = trainerFace(startPresence.remote.direction, false, 0)

      while (Date.now() < deadline) {
        const current = presenceRef.current
        if (!current.local || !current.remote) throw new Error('Remote player state disappeared while the proxy was active.')
        if (current.local.location.mapId !== startMap || current.remote.location.mapId !== startMap) throw new Error('Map changed while the proxy was active; stopping before touching replacement actors.')

        const dx = current.remote.x - current.local.x
        const dy = current.remote.y - current.local.y
        if (Math.abs(dx) > MAX_REMOTE_DX || Math.abs(dy) > MAX_REMOTE_DY) throw new Error(`Remote player moved outside the proxy window (${dx}, ${dy}); keep both players within ${MAX_REMOTE_DX} horizontal / ${MAX_REMOTE_DY} vertical tiles.`)

        if (current.remote.x !== previousRemoteX || current.remote.y !== previousRemoteY) {
          previousRemoteX = current.remote.x
          previousRemoteY = current.remote.y
          movingUntil = Date.now() + MOVING_HOLD_MS
          walkTick += 1
        }
        const moving = Date.now() < movingUntil
        const frame = trainerFace(current.remote.direction, moving, walkTick)
        const fieldFace = FIELD_FACE_BY_DIRECTION[current.remote.direction]

        const [npcMatches, playerMatches, handleOwnerNow, playerMatEntryNow] = await Promise.all([
          actorIdentityMatches(npc),
          actorIdentityMatches(player),
          bridge.read32(npcHandle.address + BLACT_HANDLE_ACTOR_INDEX),
          bridge.read16(playerHandle.address + BLACT_HANDLE_MAT_ENTRY_INDEX),
        ])
        if (!npcMatches || !playerMatches) throw new Error('Player or borrowed NPC actor changed identity while the proxy was active.')
        if (handleOwnerNow !== npcBlAct.index) throw new Error('Borrowed NPC billboard handle changed ownership while the proxy was active.')

        const [playerWPosX, playerWPosY, playerWPosZ] = await Promise.all([
          bridge.read32(player.address + ACTOR_WPOS + 0x00),
          bridge.read32(player.address + ACTOR_WPOS + 0x04),
          bridge.read32(player.address + ACTOR_WPOS + 0x08),
        ])
        const targetX = (playerWPosX + dx * TILE_FX32) >>> 0
        const targetY = playerWPosY >>> 0
        const targetZ = (playerWPosZ + dy * TILE_FX32) >>> 0

        await Promise.all([
          bridge.write16(npc.address + ACTOR_FACE_DIR, fieldFace),
          bridge.write32(npc.address + ACTOR_WPOS + 0x00, targetX),
          bridge.write32(npc.address + ACTOR_WPOS + 0x04, targetY),
          bridge.write32(npc.address + ACTOR_WPOS + 0x08, targetZ),
          bridge.write16(npcHandle.address + BLACT_HANDLE_MAT_ENTRY_INDEX, playerMatEntryNow),
          bridge.write16(npcBlAct.address + BLACT_FACE_INDEX, frame),
        ])

        updates += 1
        lastDx = dx
        lastDy = dy
        lastFrame = frame
        await delay(UPDATE_MS)
      }

      await bridge.pause()
      const restored = await restore(original)
      if (!restored) throw new Error('Could not verify restoration of the borrowed NPC pose + billboard binding.')

      setResult(`PASS • REMOTE TRAINER PROXY • NPC SLOT ${npc.index} / BLACT ${npcBlAct.index} / HANDLE ${npcHandle.index} • ${updates} UPDATES / ${TEST_MS}MS • LAST Δ ${lastDx},${lastDy} • LAST FRAME ${lastFrame} • PLAYER MAT ${playerMatEntry} • ORIGINAL NPC STATE RESTORED`)
    } catch (reason) {
      if (original) {
        try {
          if (bridge.status === 'running') await bridge.pause()
          await restore(original)
        } catch { /* best-effort restore with actor + handle ownership guards */ }
      }
      setResult(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • NATIVE REMOTE TRAINER PROXY FAILED.')
    } finally {
      if (wasRunning && bridge.status === 'paused') await bridge.resume()
      setBusy(false)
    }
  }

  const remoteReady = !!presence.local && !!presence.remote && presence.local.location.mapId === presence.remote.location.mapId

  return <section className="white2-memory-research pixel-border">
    <h2>WHITE 2 NATIVE REMOTE TRAINER PROXY</h2>
    <p>This combines the validated remote WPos control, live player billboard material binding, and the learned White 2 trainer frame groups: north 0–2, south 3–5, west 6–8, east 9–11. It temporarily borrows one standard NPC, renders it with the trainer atlas, follows the remote player's relative position and direction, synthesizes a short walk cycle when remote tile coordinates change, then restores the NPC.</p>
    <div className="memory-compare">
      <PixelButton tone="danger" disabled={!bridge || !supported || !remoteReady || busy} onClick={() => void runProxy()}>{busy ? 'RUNNING NATIVE REMOTE TRAINER...' : 'RUN REMOTE TRAINER PROXY 10S + RESTORE'}</PixelButton>
    </div>
    {!supported && <span className="form-error">DISABLED FOR THIS ROM FINGERPRINT.</span>}
    {presence.local && presence.remote ? <code>REMOTE LINK • LOCAL MAP {presence.local.location.mapId} X {presence.local.x} Y {presence.local.y} • REMOTE MAP {presence.remote.location.mapId} X {presence.remote.x} Y {presence.remote.y} {remoteReady ? '• SAME MAP' : '• DIFFERENT MAP'}</code> : <span>WAITING FOR BOTH MULTIPLAYER PLAYER STATES.</span>}
    {result && <span className={result.startsWith('PASS') ? 'memory-ok' : 'form-error'}>{result}</span>}
    <span>TEST: KEEP BOTH PLAYERS ON THE SAME MAP WITHIN 7 HORIZONTAL / 5 VERTICAL TILES. START THIS IN ONE TAB, THEN WALK AND TURN THE OTHER PLAYER. WATCH THE BORROWED NPC ON THE FIRST DS SCREEN: IT SHOULD NOW LOOK LIKE A TRAINER, FOLLOW PLAYER 2, FACE THE RIGHT DIRECTION, AND USE THE CORRECT 0–11 TRAINER FRAME GROUPS.</span>
  </section>
}
