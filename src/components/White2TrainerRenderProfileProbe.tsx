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
const BLACT_GEOM_FLAGS = 0x00
const BLACT_POSITION = 0x04
const BLACT_FACE_INDEX = 0x10
const BLACT_MAT_FLAGS = 0x18

const HANDLE_SIZE = 0x28
const HANDLE_BLACT_INDEX = 0x00
const HANDLE_MAT_ENTRY = 0x04

const STANDARD_NPC_SCENE_VTABLE = 0x021cf92c
const SPECIAL_PLAYER_COMPANION_UID = 0x00fe
const PLAYER_UID = 0x00ff
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000
const TILE_FX32 = 16 * 4096
const LEARN_MS = 10_000
const PROXY_MS = 10_000
const UPDATE_MS = 50
const MOVING_HOLD_MS = 300
const MAX_REMOTE_DX = 7
const MAX_REMOTE_DY = 5

const FIELD_FACE_BY_DIRECTION = { north: 0, south: 1, west: 2, east: 3 } as const
const DIRECTION_BY_FIELD_FACE: Partial<Record<number, MultiplayerPlayerState['direction']>> = {
  0: 'north',
  1: 'south',
  2: 'west',
  3: 'east',
}
const DIRECTIONS: MultiplayerPlayerState['direction'][] = ['north', 'south', 'west', 'east']

type Direction = MultiplayerPlayerState['direction']

type Binding = {
  actor: White2ActorHeapEntry
  blActIndex: number
  blActAddress: number
  handleIndex: number
  handleAddress: number
}

type RenderProfile = {
  faceIndex: number
  geomFlags: number
  matFlags: number
}

type RenderSample = RenderProfile & {
  direction: Direction
  moving: boolean
}

type LearnedDirection = {
  idle: RenderProfile | null
  moving: RenderProfile[]
  sampleCount: number
}

type LearnedRenderMap = {
  matEntry: number
  sampleCount: number
  directions: Record<Direction, LearnedDirection>
}

type OriginalNpcState = {
  uid: number
  modelId: number
  tcb: number
  faceDir: number
  wposX: number
  wposY: number
  wposZ: number
  matEntry: number
  geomFlags: number
  faceIndex: number
  matFlags: number
}

function hex(value: number, width = 4) {
  return (value >>> 0).toString(16).toUpperCase().padStart(width, '0')
}

function signed32(value: number) {
  return value | 0
}

function delay(ms: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms))
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 0x3) === 0
}

function chooseStandardNpc(entries: White2ActorHeapEntry[], player: White2ActorHeapEntry) {
  return entries
    .filter(entry => entry.state === 'active' && entry.uid !== SPECIAL_PLAYER_COMPANION_UID && entry.sceneNodeVTable === STANDARD_NPC_SCENE_VTABLE)
    .sort((a, b) => (Math.abs(a.x - player.x) + Math.abs(a.y - player.y)) - (Math.abs(b.x - player.x) + Math.abs(b.y - player.y)))[0]
}

function profileKey(profile: RenderProfile) {
  return `${profile.faceIndex}:${profile.geomFlags}:${profile.matFlags}`
}

function mostFrequent(samples: RenderSample[]) {
  if (!samples.length) return null
  const counts = new Map<string, { count: number; profile: RenderProfile }>()
  for (const sample of samples) {
    const profile: RenderProfile = { faceIndex: sample.faceIndex, geomFlags: sample.geomFlags, matFlags: sample.matFlags }
    const key = profileKey(profile)
    const current = counts.get(key)
    if (current) current.count += 1
    else counts.set(key, { count: 1, profile })
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0]?.profile ?? null
}

function learnDirection(samples: RenderSample[], direction: Direction): LearnedDirection {
  const dirSamples = samples.filter(sample => sample.direction === direction)
  const idle = mostFrequent(dirSamples.filter(sample => !sample.moving))
  const movingSamples = dirSamples.filter(sample => sample.moving)
  const byFace = new Map<number, RenderSample[]>()
  for (const sample of movingSamples) {
    const list = byFace.get(sample.faceIndex) ?? []
    list.push(sample)
    byFace.set(sample.faceIndex, list)
  }
  const moving = [...byFace.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, faceSamples]) => mostFrequent(faceSamples))
    .filter((profile): profile is RenderProfile => profile !== null)
  return { idle: idle ?? moving[Math.floor(moving.length / 2)] ?? null, moving, sampleCount: dirSamples.length }
}

function learnedComplete(learned: LearnedRenderMap | null) {
  return !!learned && DIRECTIONS.every(direction => learned.directions[direction].idle && learned.directions[direction].moving.length > 0)
}

export function White2TrainerRenderProfileProbe({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const [busy, setBusy] = useState<'learn' | 'proxy' | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [learned, setLearned] = useState<LearnedRenderMap | null>(null)
  const [presence, setPresence] = useState<MultiplayerPresenceSnapshot>({ local: null, remote: null })
  const presenceRef = useRef<MultiplayerPresenceSnapshot>(presence)
  const supported = White2ActorSystemProbe.supportsRom(rom)

  useEffect(() => multiplayerPresence.subscribe(snapshot => {
    presenceRef.current = snapshot
    setPresence(snapshot)
  }), [])

  async function resolveBinding(entry: White2ActorHeapEntry, sceneActors: number, actorCount: number, actorHandles: number, handleCount: number): Promise<Binding> {
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
        bestDistance = distance
        bestIndex = index
        bestAddress = address
      }
    }
    if (bestIndex < 0) throw new Error(`Could not resolve billboard actor for slot ${entry.index}.`)

    const matches: Array<{ index: number; address: number }> = []
    for (let index = 0; index < handleCount; index += 1) {
      const address = actorHandles + index * HANDLE_SIZE
      if ((await bridge.read32(address + HANDLE_BLACT_INDEX)) === bestIndex) matches.push({ index, address })
    }
    if (matches.length !== 1) throw new Error(`Expected one billboard handle for BlAct ${bestIndex}, found ${matches.length}.`)
    return { actor: entry, blActIndex: bestIndex, blActAddress: bestAddress, handleIndex: matches[0].index, handleAddress: matches[0].address }
  }

  async function prepareBindings() {
    if (!bridge) throw new Error('melonDS bridge is unavailable.')
    const scan = await new White2ActorSystemProbe(bridge).scanHeap()
    if (scan.suspiciousSlots.length) throw new Error('Trainer render test blocked because suspicious actor slots are present.')
    const player = scan.entries.find(entry => entry.state === 'player')
    if (!player || player.uid !== PLAYER_UID) throw new Error('Live player actor was not found.')
    const npc = chooseStandardNpc(scan.entries, player)

    const fieldBlAct = await bridge.read32(scan.actorSystem + ACTOR_SYSTEM_FIELD_BLACT)
    if (!isMainRamPointer(fieldBlAct)) throw new Error(`FieldBlAct pointer is invalid (0x${hex(fieldBlAct, 8)}).`)
    const blActSystem = await bridge.read32(fieldBlAct + FIELD_BLACT_SYSTEM)
    if (!isMainRamPointer(blActSystem)) throw new Error(`BlActSystem pointer is invalid (0x${hex(blActSystem, 8)}).`)
    const [scene, actorHandles, handleCount] = await Promise.all([
      bridge.read32(blActSystem + BLACT_SYSTEM_SCENE),
      bridge.read32(blActSystem + BLACT_SYSTEM_ACTOR_HANDLES),
      bridge.read16(blActSystem + BLACT_SYSTEM_ACTOR_COUNT),
    ])
    if (!isMainRamPointer(scene) || !isMainRamPointer(actorHandles)) throw new Error('Billboard scene/handle pointers are invalid.')
    const [sceneActors, actorCount] = await Promise.all([
      bridge.read32(scene + BLACT_SCENE_ACTORS),
      bridge.read16(scene + BLACT_SCENE_CONFIG_ACTOR_COUNT),
    ])
    if (!isMainRamPointer(sceneActors)) throw new Error('Billboard actor array pointer is invalid.')

    const playerBinding = await resolveBinding(player, sceneActors, actorCount, actorHandles, handleCount)
    const npcBinding = npc ? await resolveBinding(npc, sceneActors, actorCount, actorHandles, handleCount) : null
    return { playerBinding, npcBinding }
  }

  async function bindingIdentityMatches(binding: Binding, uid: number, modelId: number, tcb: number) {
    if (!bridge) return false
    const [uidNow, modelNow, tcbNow, owner] = await Promise.all([
      bridge.read16(binding.actor.address + ACTOR_UID),
      bridge.read16(binding.actor.address + ACTOR_MODEL_ID),
      bridge.read32(binding.actor.address + ACTOR_TCB),
      bridge.read32(binding.handleAddress + HANDLE_BLACT_INDEX),
    ])
    return uidNow === uid && modelNow === modelId && tcbNow === tcb && owner === binding.blActIndex
  }

  async function captureOriginalNpc(binding: Binding): Promise<OriginalNpcState> {
    if (!bridge) throw new Error('melonDS bridge is unavailable.')
    const [faceDir, wposX, wposY, wposZ, matEntry, geomFlags, faceIndex, matFlags] = await Promise.all([
      bridge.read16(binding.actor.address + ACTOR_FACE_DIR),
      bridge.read32(binding.actor.address + ACTOR_WPOS + 0x00),
      bridge.read32(binding.actor.address + ACTOR_WPOS + 0x04),
      bridge.read32(binding.actor.address + ACTOR_WPOS + 0x08),
      bridge.read16(binding.handleAddress + HANDLE_MAT_ENTRY),
      bridge.read16(binding.blActAddress + BLACT_GEOM_FLAGS),
      bridge.read16(binding.blActAddress + BLACT_FACE_INDEX),
      bridge.read16(binding.blActAddress + BLACT_MAT_FLAGS),
    ])
    return { uid: binding.actor.uid, modelId: binding.actor.modelId, tcb: binding.actor.tcb, faceDir, wposX, wposY, wposZ, matEntry, geomFlags, faceIndex, matFlags }
  }

  async function restoreNpc(binding: Binding, original: OriginalNpcState) {
    if (!bridge || !(await bindingIdentityMatches(binding, original.uid, original.modelId, original.tcb))) return false
    await Promise.all([
      bridge.write16(binding.actor.address + ACTOR_FACE_DIR, original.faceDir),
      bridge.write32(binding.actor.address + ACTOR_WPOS + 0x00, original.wposX),
      bridge.write32(binding.actor.address + ACTOR_WPOS + 0x04, original.wposY),
      bridge.write32(binding.actor.address + ACTOR_WPOS + 0x08, original.wposZ),
      bridge.write16(binding.handleAddress + HANDLE_MAT_ENTRY, original.matEntry),
      bridge.write16(binding.blActAddress + BLACT_GEOM_FLAGS, original.geomFlags),
      bridge.write16(binding.blActAddress + BLACT_FACE_INDEX, original.faceIndex),
      bridge.write16(binding.blActAddress + BLACT_MAT_FLAGS, original.matFlags),
    ])
    return true
  }

  async function learnPlayerRenderMap() {
    if (!bridge || !supported) return
    setBusy('learn')
    setStatus(null)
    setLearned(null)
    const wasRunning = bridge.status === 'running'
    try {
      if (!wasRunning) throw new Error('Render-profile learner requires melonDS to be running.')
      await bridge.pause()
      const { playerBinding } = await prepareBindings()
      const [uid, modelId, tcb, matEntry, startX, startZ] = await Promise.all([
        bridge.read16(playerBinding.actor.address + ACTOR_UID),
        bridge.read16(playerBinding.actor.address + ACTOR_MODEL_ID),
        bridge.read32(playerBinding.actor.address + ACTOR_TCB),
        bridge.read16(playerBinding.handleAddress + HANDLE_MAT_ENTRY),
        bridge.read32(playerBinding.actor.address + ACTOR_WPOS + 0x00),
        bridge.read32(playerBinding.actor.address + ACTOR_WPOS + 0x08),
      ])
      await bridge.resume()

      const samples: RenderSample[] = []
      const deadline = Date.now() + LEARN_MS
      let previousX = startX
      let previousZ = startZ
      let movingUntil = 0

      while (Date.now() < deadline) {
        if (!(await bindingIdentityMatches(playerBinding, uid, modelId, tcb))) throw new Error('Player actor changed identity during learning; do not cross a map boundary.')
        const [faceDir, x, z, faceIndex, geomFlags, matFlags, matEntryNow] = await Promise.all([
          bridge.read16(playerBinding.actor.address + ACTOR_FACE_DIR),
          bridge.read32(playerBinding.actor.address + ACTOR_WPOS + 0x00),
          bridge.read32(playerBinding.actor.address + ACTOR_WPOS + 0x08),
          bridge.read16(playerBinding.blActAddress + BLACT_FACE_INDEX),
          bridge.read16(playerBinding.blActAddress + BLACT_GEOM_FLAGS),
          bridge.read16(playerBinding.blActAddress + BLACT_MAT_FLAGS),
          bridge.read16(playerBinding.handleAddress + HANDLE_MAT_ENTRY),
        ])
        if (matEntryNow !== matEntry) throw new Error(`Player material changed during learning (${matEntry}→${matEntryNow}); retry on a normal overworld map.`)
        if (x !== previousX || z !== previousZ) movingUntil = Date.now() + MOVING_HOLD_MS
        previousX = x
        previousZ = z
        const direction = DIRECTION_BY_FIELD_FACE[faceDir]
        if (direction) samples.push({ direction, moving: Date.now() < movingUntil, faceIndex, geomFlags, matFlags })
        await delay(UPDATE_MS)
      }

      const directions = Object.fromEntries(DIRECTIONS.map(direction => [direction, learnDirection(samples, direction)])) as Record<Direction, LearnedDirection>
      const next: LearnedRenderMap = { matEntry, sampleCount: samples.length, directions }
      setLearned(next)
      const missing = DIRECTIONS.filter(direction => !directions[direction].idle || directions[direction].moving.length === 0)
      setStatus(missing.length
        ? `PARTIAL • ${samples.length} SAMPLES • MISSING GOOD IDLE/MOVING DATA FOR ${missing.map(value => value.toUpperCase()).join(', ')}`
        : `PASS • LEARNED ${samples.length} PLAYER RENDER SAMPLES • ALL FOUR DIRECTIONS READY`)
    } catch (reason) {
      setStatus(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • PLAYER RENDER LEARNING FAILED.')
    } finally {
      if (wasRunning && bridge.status === 'paused') await bridge.resume()
      setBusy(null)
    }
  }

  async function runProxyV3() {
    if (!bridge || !supported || !learnedComplete(learned) || !learned) return
    setBusy('proxy')
    setStatus(null)
    const wasRunning = bridge.status === 'running'
    let npcBinding: Binding | null = null
    let original: OriginalNpcState | null = null
    try {
      if (!wasRunning) throw new Error('Remote proxy v3 requires melonDS to be running.')
      const startPresence = presenceRef.current
      if (!startPresence.local || !startPresence.remote) throw new Error('Two live multiplayer player states are required.')
      if (startPresence.local.location.mapId !== startPresence.remote.location.mapId) throw new Error('Both players must be on the same map.')
      const startMap = startPresence.local.location.mapId

      await bridge.pause()
      const { playerBinding, npcBinding: resolvedNpc } = await prepareBindings()
      if (!resolvedNpc) throw new Error('No standard live NPC is available to borrow as the remote trainer proxy.')
      npcBinding = resolvedNpc
      original = await captureOriginalNpc(resolvedNpc)
      const playerMatEntry = await bridge.read16(playerBinding.handleAddress + HANDLE_MAT_ENTRY)
      await bridge.resume()

      const deadline = Date.now() + PROXY_MS
      let updates = 0
      let movingUntil = 0
      let previousRemoteX = startPresence.remote.x
      let previousRemoteY = startPresence.remote.y
      let walkTick = 0
      let lastDirection: Direction = startPresence.remote.direction
      let lastProfile = learned.directions[lastDirection].idle!

      while (Date.now() < deadline) {
        const current = presenceRef.current
        if (!current.local || !current.remote) throw new Error('Remote player state disappeared while proxy v3 was active.')
        if (current.local.location.mapId !== startMap || current.remote.location.mapId !== startMap) throw new Error('Map changed while proxy v3 was active; stopping before touching replacement actors.')
        if (!(await bindingIdentityMatches(resolvedNpc, original.uid, original.modelId, original.tcb))) throw new Error('Borrowed NPC changed identity while proxy v3 was active.')

        const dx = current.remote.x - current.local.x
        const dy = current.remote.y - current.local.y
        if (Math.abs(dx) > MAX_REMOTE_DX || Math.abs(dy) > MAX_REMOTE_DY) throw new Error(`Remote player moved outside the proxy window (${dx}, ${dy}).`)

        if (current.remote.x !== previousRemoteX || current.remote.y !== previousRemoteY) {
          previousRemoteX = current.remote.x
          previousRemoteY = current.remote.y
          movingUntil = Date.now() + MOVING_HOLD_MS
          walkTick = 0
        }
        const direction = current.remote.direction
        const directionProfiles = learned.directions[direction]
        const moving = Date.now() < movingUntil
        let profile = directionProfiles.idle!
        if (moving && directionProfiles.moving.length) {
          profile = directionProfiles.moving[Math.floor(walkTick / 2) % directionProfiles.moving.length]
          walkTick += 1
        }

        const [playerWPosX, playerWPosY, playerWPosZ] = await Promise.all([
          bridge.read32(playerBinding.actor.address + ACTOR_WPOS + 0x00),
          bridge.read32(playerBinding.actor.address + ACTOR_WPOS + 0x04),
          bridge.read32(playerBinding.actor.address + ACTOR_WPOS + 0x08),
        ])
        const targetX = (playerWPosX + dx * TILE_FX32) >>> 0
        const targetZ = (playerWPosZ + dy * TILE_FX32) >>> 0

        await Promise.all([
          bridge.write16(resolvedNpc.actor.address + ACTOR_FACE_DIR, FIELD_FACE_BY_DIRECTION[direction]),
          bridge.write32(resolvedNpc.actor.address + ACTOR_WPOS + 0x00, targetX),
          bridge.write32(resolvedNpc.actor.address + ACTOR_WPOS + 0x04, playerWPosY),
          bridge.write32(resolvedNpc.actor.address + ACTOR_WPOS + 0x08, targetZ),
          bridge.write16(resolvedNpc.handleAddress + HANDLE_MAT_ENTRY, playerMatEntry),
          bridge.write16(resolvedNpc.blActAddress + BLACT_GEOM_FLAGS, profile.geomFlags),
          bridge.write16(resolvedNpc.blActAddress + BLACT_FACE_INDEX, profile.faceIndex),
          bridge.write16(resolvedNpc.blActAddress + BLACT_MAT_FLAGS, profile.matFlags),
        ])

        lastDirection = direction
        lastProfile = profile
        updates += 1
        await delay(UPDATE_MS)
      }

      await bridge.pause()
      const restored = await restoreNpc(resolvedNpc, original)
      if (!restored) throw new Error('Original NPC state could not be restored after proxy v3.')
      setStatus(`PASS • REMOTE TRAINER PROXY V3 • ${updates} UPDATES • LAST ${lastDirection.toUpperCase()} FACE ${lastProfile.faceIndex} GEOM 0x${hex(lastProfile.geomFlags)} MATFLAGS 0x${hex(lastProfile.matFlags)} • ORIGINAL NPC STATE RESTORED`)
    } catch (reason) {
      if (npcBinding && original) {
        try {
          if (bridge.status === 'running') await bridge.pause()
          await restoreNpc(npcBinding, original)
        } catch { /* guarded best-effort restore */ }
      }
      setStatus(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • REMOTE PROXY V3 FAILED.')
    } finally {
      if (wasRunning && bridge.status === 'paused') await bridge.resume()
      setBusy(null)
    }
  }

  const remoteReady = !!presence.local && !!presence.remote && presence.local.location.mapId === presence.remote.location.mapId

  return <section className="white2-memory-research pixel-border">
    <h2>WHITE 2 TRAINER RENDER PROFILE</h2>
    <p>The video confirmed that the shared player material produces the correct protagonist, but proxy v2 still used the wrong facing/animation state. The remaining variable is the live combination of FaceIdx + GeomFlags + MatFlags. Learn those combinations from the real player first, then replay the learned profiles on the remote proxy.</p>
    <div className="memory-compare">
      <PixelButton tone="ghost" disabled={!bridge || !supported || busy !== null} onClick={() => void learnPlayerRenderMap()}>{busy === 'learn' ? 'LEARNING PLAYER RENDER STATES 10S...' : 'LEARN PLAYER RENDER STATES 10S'}</PixelButton>
      <PixelButton tone="danger" disabled={!bridge || !supported || !remoteReady || !learnedComplete(learned) || busy !== null} onClick={() => void runProxyV3()}>{busy === 'proxy' ? 'RUNNING PROXY V3 + RESTORING...' : 'RUN REMOTE PROXY V3 10S + RESTORE'}</PixelButton>
    </div>
    {!supported && <span className="form-error">DISABLED FOR THIS ROM FINGERPRINT.</span>}
    {status && <span className={status.startsWith('FAIL') ? 'form-error' : 'memory-ok'}>{status}</span>}
    {learned && <div className="memory-results">
      <code>PLAYER MAT {learned.matEntry} • {learned.sampleCount} SAMPLES</code>
      {DIRECTIONS.map(direction => {
        const value = learned.directions[direction]
        const idle = value.idle ? `F${value.idle.faceIndex}/G${hex(value.idle.geomFlags)}/M${hex(value.idle.matFlags)}` : 'NONE'
        const moving = value.moving.length ? value.moving.map(profile => `F${profile.faceIndex}/G${hex(profile.geomFlags)}/M${hex(profile.matFlags)}`).join(' | ') : 'NONE'
        return <code key={direction}>{direction.toUpperCase()} • N {value.sampleCount} • IDLE {idle} • MOVING {moving}</code>
      })}
    </div>}
    <span>LEARN STEP: FOR 10 SECONDS, WALK A FEW TILES NORTH, SOUTH, WEST AND EAST AND PAUSE BRIEFLY FACING EACH DIRECTION. DO NOT CROSS A MAP BOUNDARY.</span>
    <span>PROXY V3 USES THE LEARNED LIVE RENDER FLAGS INSTEAD OF A SINGLE STARTUP MATFLAGS/GEOMFLAGS VALUE. +08 AND +0C REMAIN UNTOUCHED.</span>
  </section>
}
