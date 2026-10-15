import { useEffect, useRef, useState } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../multiplayer/core/MultiplayerPresence'
import type { MultiplayerPlayerState, MultiplayerRomIdentity, MultiplayerWorldPosition } from '../multiplayer/core/protocol'
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
const LEARN_MS = 10_000
const PROXY_MS = 10_000
const UPDATE_MS = 40
const MOVING_HOLD_MS = 120
const MAX_REMOTE_DX = 7
const MAX_REMOTE_DY = 5
const MAX_STEP_HOLD_MS = 250

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
  runId: number | null
}

type RenderSequenceStep = RenderProfile & {
  holdMs: number
}

type LearnedDirection = {
  idle: RenderProfile | null
  movingSequence: RenderSequenceStep[]
  sampleCount: number
  runCount: number
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

function profileFromSample(sample: RenderSample): RenderProfile {
  return { faceIndex: sample.faceIndex, geomFlags: sample.geomFlags, matFlags: sample.matFlags }
}

function profileKey(profile: RenderProfile) {
  return `${profile.faceIndex}:${profile.geomFlags}:${profile.matFlags}`
}

function mostFrequent(samples: RenderSample[]) {
  if (!samples.length) return null
  const counts = new Map<string, { count: number; profile: RenderProfile }>()
  for (const sample of samples) {
    const profile = profileFromSample(sample)
    const key = profileKey(profile)
    const current = counts.get(key)
    if (current) current.count += 1
    else counts.set(key, { count: 1, profile })
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0]?.profile ?? null
}

function compressRun(samples: RenderSample[]): RenderSequenceStep[] {
  const sequence: RenderSequenceStep[] = []
  for (const sample of samples) {
    const profile = profileFromSample(sample)
    const previous = sequence[sequence.length - 1]
    if (previous && profileKey(previous) === profileKey(profile)) {
      previous.holdMs = Math.min(MAX_STEP_HOLD_MS, previous.holdMs + UPDATE_MS)
    } else {
      sequence.push({ ...profile, holdMs: UPDATE_MS })
    }
  }
  return sequence
}

function learnDirection(samples: RenderSample[], direction: Direction): LearnedDirection {
  const dirSamples = samples.filter(sample => sample.direction === direction)
  const idle = mostFrequent(dirSamples.filter(sample => !sample.moving))
  const runs = new Map<number, RenderSample[]>()
  for (const sample of dirSamples) {
    if (!sample.moving || sample.runId === null) continue
    const run = runs.get(sample.runId) ?? []
    run.push(sample)
    runs.set(sample.runId, run)
  }

  const bestRun = [...runs.values()].sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length
    return compressRun(b).length - compressRun(a).length
  })[0] ?? []
  const movingSequence = compressRun(bestRun)
  return {
    idle: idle ?? movingSequence[0] ?? null,
    movingSequence,
    sampleCount: dirSamples.length,
    runCount: runs.size,
  }
}

function learnedComplete(learned: LearnedRenderMap | null) {
  return !!learned && DIRECTIONS.every(direction => learned.directions[direction].idle && learned.directions[direction].movingSequence.length > 0)
}

function worldChanged(a: MultiplayerWorldPosition | null, b: MultiplayerWorldPosition) {
  return !a || a.x !== b.x || a.y !== b.y || a.z !== b.z
}

export function White2TrainerContinuousWPosProbe({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const [busy, setBusy] = useState<'learn' | 'proxy' | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [learned, setLearned] = useState<LearnedRenderMap | null>(null)
  const [presenceReady, setPresenceReady] = useState(false)
  const presenceRef = useRef<MultiplayerPresenceSnapshot>({ local: null, remote: null })
  const supported = White2ActorSystemProbe.supportsRom(rom)

  useEffect(() => multiplayerPresence.subscribe(snapshot => {
    presenceRef.current = snapshot
    const ready = Boolean(snapshot.local?.worldPosition && snapshot.remote?.worldPosition)
    setPresenceReady(previous => previous === ready ? previous : ready)
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
    if (scan.suspiciousSlots.length) throw new Error('Trainer proxy blocked because suspicious actor slots are present.')
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

  async function learnPlayerRenderSequence() {
    if (!bridge || !supported) return
    setBusy('learn')
    setStatus(null)
    setLearned(null)
    const wasRunning = bridge.status === 'running'
    try {
      if (!wasRunning) throw new Error('Render-sequence learner requires melonDS to be running.')
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
      let nextRunId = 0
      let currentRunId: number | null = null
      let previousMoving = false
      let previousMovingDirection: Direction | null = null

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

        const now = Date.now()
        if (x !== previousX || z !== previousZ) movingUntil = now + MOVING_HOLD_MS
        previousX = x
        previousZ = z
        const direction = DIRECTION_BY_FIELD_FACE[faceDir]
        if (direction) {
          const moving = now < movingUntil
          if (moving && (!previousMoving || previousMovingDirection !== direction)) {
            nextRunId += 1
            currentRunId = nextRunId
          }
          if (!moving) currentRunId = null
          samples.push({ direction, moving, runId: moving ? currentRunId : null, faceIndex, geomFlags, matFlags })
          previousMoving = moving
          previousMovingDirection = moving ? direction : null
        }
        await delay(UPDATE_MS)
      }

      const directions = Object.fromEntries(DIRECTIONS.map(direction => [direction, learnDirection(samples, direction)])) as Record<Direction, LearnedDirection>
      const next: LearnedRenderMap = { matEntry, sampleCount: samples.length, directions }
      setLearned(next)
      const missing = DIRECTIONS.filter(direction => !directions[direction].idle || directions[direction].movingSequence.length === 0)
      setStatus(missing.length
        ? `PARTIAL • ${samples.length} SAMPLES • MISSING GOOD IDLE/MOVING RUN FOR ${missing.map(value => value.toUpperCase()).join(', ')}`
        : `PASS • LEARNED ${samples.length} PLAYER RENDER SAMPLES • V6 DIRECT WPOS READY FOR ALL FOUR DIRECTIONS`)
    } catch (reason) {
      setStatus(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • PLAYER RENDER-SEQUENCE LEARNING FAILED.')
    } finally {
      if (wasRunning && bridge.status === 'paused') await bridge.resume()
      setBusy(null)
    }
  }

  async function runProxyV6() {
    if (!bridge || !supported || !learnedComplete(learned) || !learned) return
    setBusy('proxy')
    setStatus(null)
    const wasRunning = bridge.status === 'running'
    let npcBinding: Binding | null = null
    let original: OriginalNpcState | null = null

    try {
      if (!wasRunning) throw new Error('Remote proxy v6 requires melonDS to be running.')
      const startPresence = presenceRef.current
      if (!startPresence.local || !startPresence.remote) throw new Error('Two live multiplayer player states are required.')
      if (!startPresence.local.worldPosition || !startPresence.remote.worldPosition) throw new Error('Both players must be publishing continuous FieldActor.WPos first.')
      if (startPresence.local.location.mapId !== startPresence.remote.location.mapId) throw new Error('Both players must be on the same map.')
      const startMap = startPresence.local.location.mapId

      await bridge.pause()
      const { playerBinding, npcBinding: resolvedNpc } = await prepareBindings()
      if (!resolvedNpc) throw new Error('No standard live NPC is available to borrow as the remote trainer proxy.')
      npcBinding = resolvedNpc
      original = await captureOriginalNpc(resolvedNpc)
      const playerMatEntry = await bridge.read16(playerBinding.handleAddress + HANDLE_MAT_ENTRY)
      if (playerMatEntry !== learned.matEntry) throw new Error(`Player material changed since learning (${learned.matEntry}→${playerMatEntry}); relearn the render sequence.`)
      await bridge.resume()

      const deadline = Date.now() + PROXY_MS
      let updates = 0
      let worldUpdates = 0
      let activeDirection: Direction = startPresence.remote.direction
      let sequenceIndex = 0
      let stepStartedAt = Date.now()
      let wasMoving = false
      let movingUntil = 0
      let lastWorld: MultiplayerWorldPosition | null = null
      let lastProfile = learned.directions[activeDirection].idle!

      while (Date.now() < deadline) {
        const current = presenceRef.current
        if (!current.local || !current.remote) throw new Error('Remote player state disappeared while proxy v6 was active.')
        if (current.local.location.mapId !== startMap || current.remote.location.mapId !== startMap) throw new Error('Map changed while proxy v6 was active; stopping before touching replacement actors.')
        if (!(await bindingIdentityMatches(resolvedNpc, original.uid, original.modelId, original.tcb))) throw new Error('Borrowed NPC changed identity while proxy v6 was active.')

        const remoteWorld = current.remote.worldPosition
        if (!remoteWorld) throw new Error('Remote continuous world position disappeared while proxy v6 was active.')
        const now = Date.now()
        const dx = current.remote.x - current.local.x
        const dy = current.remote.y - current.local.y
        if (Math.abs(dx) > MAX_REMOTE_DX || Math.abs(dy) > MAX_REMOTE_DY) throw new Error(`Remote player moved outside the proxy window (${dx}, ${dy}).`)

        if (worldChanged(lastWorld, remoteWorld)) {
          movingUntil = now + MOVING_HOLD_MS
          lastWorld = { ...remoteWorld }
          worldUpdates += 1
        }

        const direction = current.remote.direction
        if (direction !== activeDirection) {
          activeDirection = direction
          sequenceIndex = 0
          stepStartedAt = now
        }

        const directionProfile = learned.directions[direction]
        const moving = now < movingUntil
        let profile = directionProfile.idle!
        if (moving && directionProfile.movingSequence.length) {
          if (!wasMoving) {
            sequenceIndex = 0
            stepStartedAt = now
          }
          const sequence = directionProfile.movingSequence
          let safety = sequence.length + 1
          while (safety > 0 && now - stepStartedAt >= sequence[sequenceIndex].holdMs) {
            stepStartedAt += sequence[sequenceIndex].holdMs
            sequenceIndex = (sequenceIndex + 1) % sequence.length
            safety -= 1
          }
          profile = sequence[sequenceIndex]
        } else if (wasMoving) {
          sequenceIndex = 0
          stepStartedAt = now
        }
        wasMoving = moving

        await Promise.all([
          bridge.write16(resolvedNpc.actor.address + ACTOR_FACE_DIR, FIELD_FACE_BY_DIRECTION[direction]),
          bridge.write32(resolvedNpc.actor.address + ACTOR_WPOS + 0x00, remoteWorld.x >>> 0),
          bridge.write32(resolvedNpc.actor.address + ACTOR_WPOS + 0x04, remoteWorld.y >>> 0),
          bridge.write32(resolvedNpc.actor.address + ACTOR_WPOS + 0x08, remoteWorld.z >>> 0),
          bridge.write16(resolvedNpc.handleAddress + HANDLE_MAT_ENTRY, playerMatEntry),
          bridge.write16(resolvedNpc.blActAddress + BLACT_GEOM_FLAGS, profile.geomFlags),
          bridge.write16(resolvedNpc.blActAddress + BLACT_FACE_INDEX, profile.faceIndex),
          bridge.write16(resolvedNpc.blActAddress + BLACT_MAT_FLAGS, profile.matFlags),
        ])

        lastProfile = profile
        updates += 1
        await delay(UPDATE_MS)
      }

      await bridge.pause()
      const restored = await restoreNpc(resolvedNpc, original)
      if (!restored) throw new Error('Original NPC state could not be restored after proxy v6.')
      setStatus(`PASS • REMOTE TRAINER PROXY V6 • ${updates} RENDER UPDATES • ${worldUpdates} DIRECT WPOS UPDATES • LAST ${activeDirection.toUpperCase()} FACE ${lastProfile.faceIndex} • NO TILE INTERPOLATION • ORIGINAL NPC STATE RESTORED`)
    } catch (reason) {
      if (npcBinding && original) {
        try {
          if (bridge.status === 'running') await bridge.pause()
          await restoreNpc(npcBinding, original)
        } catch { /* guarded best-effort restore */ }
      }
      setStatus(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • REMOTE PROXY V6 FAILED.')
    } finally {
      if (wasRunning && bridge.status === 'paused') await bridge.resume()
      setBusy(null)
    }
  }

  const ready = learnedComplete(learned)

  return <section className="white2-memory-research pixel-border">
    <h2>WHITE 2 TRAINER DIRECT WPOS • V6</h2>
    <p>V5 proved the protagonist render path, size, native walk frames and safe NPC restoration. V6 keeps that render path but removes reconstructed tile travel: each browser now publishes its real FieldActor.WPos and the partner proxy receives those continuous X/Y/Z coordinates directly.</p>
    <div className="memory-compare">
      <PixelButton tone="ghost" disabled={!bridge || !supported || busy !== null} onClick={() => void learnPlayerRenderSequence()}>{busy === 'learn' ? 'LEARNING NATIVE WALK SEQUENCES...' : 'LEARN NATIVE WALK SEQUENCES 10S'}</PixelButton>
      <PixelButton tone="danger" disabled={!bridge || !supported || !ready || !presenceReady || busy !== null} onClick={() => void runProxyV6()}>{busy === 'proxy' ? 'RUNNING V6 + RESTORING...' : 'RUN REMOTE PROXY V6 10S + RESTORE'}</PixelButton>
    </div>
    {!supported && <span className="form-error">DISABLED FOR THIS ROM FINGERPRINT.</span>}
    {!presenceReady && <span>WAITING FOR BOTH TABS TO PUBLISH CONTINUOUS FIELD ACTOR WORLD POSITION.</span>}
    {learned && <span>{DIRECTIONS.map(direction => `${direction.toUpperCase()} ${learned.directions[direction].movingSequence.length} STEPS/${learned.directions[direction].runCount} RUNS`).join(' • ')}</span>}
    {status && <span className={status.startsWith('PASS') ? 'memory-ok' : status.startsWith('PARTIAL') ? '' : 'form-error'}>{status}</span>}
    <span>LEARN: WALK SEVERAL CONTINUOUS TILES NORTH, SOUTH, WEST AND EAST AND PAUSE BRIEFLY WHILE FACING EACH DIRECTION. V6 THEN WRITES THE PARTNER'S TRANSMITTED WPOS DIRECTLY; IT DOES NOT SYNTHESIZE A TILE-CENTER PATH.</span>
  </section>
}
