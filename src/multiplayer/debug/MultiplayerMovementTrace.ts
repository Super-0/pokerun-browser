import { MelonDsBridge, type Arm9NativeCallResult } from '../../core/emulator/melonds/MelonDsBridge'
import { LocalMultiplayerSession } from '../core/LocalMultiplayerSession'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerMessage, MultiplayerPlayerState, MultiplayerWorldPosition } from '../core/protocol'
import { POKERUN_NATIVE_TEST_UID } from '../games/White2NativeActor'
import { White2ActorSystemProbe } from '../games/White2ActorSystem'
import { White2WorldPositionReader } from '../games/White2WorldPositionReader'
import { BroadcastChannelTransport } from '../transports/BroadcastChannelTransport'

const TRACE_CHANNEL = 'pokerun-multiplayer-movement-trace-v1'
const TRACE_VERSION = 1
const MAX_EVENTS = 12000
const SAMPLE_MS = 20
const FX32_TILE = 0x10000

const FIELD_ACTOR_SIZE = 0x100
const ACTOR_UID = 0x08
const ACTOR_MODEL_ID = 0x0c
const ACTOR_FACE_DIR = 0x18
const ACTOR_GPOS = 0x3c
const ACTOR_WPOS = 0x44
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
const BLACT_NONE = 0xffff
const PLAYER_UID = 0x00ff
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000

type TraceStage =
  | 'local_sample'
  | 'publish'
  | 'receive_wire'
  | 'remote_target'
  | 'memory_sample'
  | 'actor_discovery'
  | 'marker'
  | 'trace_note'

type TraceScalar = string | number | boolean | null
export type TraceData = Record<string, TraceScalar>

export type MultiplayerMovementTraceEvent = {
  version: typeof TRACE_VERSION
  traceId: string
  tabId: string
  tabLabel: string
  stage: TraceStage
  at: number
  perfAt: number
  data: TraceData
}

export type TraceNumberStats = {
  count: number
  min: number | null
  median: number | null
  p95: number | null
  max: number | null
  mean: number | null
}

export type MultiplayerMovementTraceSummary = {
  eventCount: number
  durationMs: number | null
  tabs: string[]
  stageCounts: Record<string, number>
  speedCounts: Record<string, number>
  localSampleIntervalMs: TraceNumberStats
  publishIntervalMs: TraceNumberStats
  receiveIntervalMs: TraceNumberStats
  packetAgeMs: TraceNumberStats
  renderErrorTiles: TraceNumberStats
  sampleOverheadMs: TraceNumberStats
  sequenceGaps: number
  localProfileChanges: number
  remoteProfileChanges: number
  remoteOnlyProfiles: Record<string, number>
}

export type MultiplayerMovementTraceSnapshot = {
  active: boolean
  traceId: string | null
  startedAt: number | null
  endsAt: number | null
  eventCount: number
  tabLabel: string
}

type TraceWireMessage =
  | { type: 'start'; traceId: string; startedAt: number; durationMs: number }
  | { type: 'stop'; traceId: string; stoppedAt: number }
  | { type: 'clear' }
  | { type: 'event'; event: MultiplayerMovementTraceEvent }

type RenderBinding = {
  actorAddress: number
  blActIndex: number
  blActAddress: number
  handleAddress: number
}

type BridgeTraceState = {
  bridge: MelonDsBridge
  blActIndexByActor: Map<number, number>
  playerAddress: number | null
  remoteAddress: number | null
  playerBinding: RenderBinding | null
  remoteBinding: RenderBinding | null
  lastDiscoveryAt: number
  sampling: boolean
}

type TraceWindow = Window & {
  __POKERUN_MOVEMENT_TRACE_CONTROLLER__?: MultiplayerMovementTraceController
  __POKERUN_MOVEMENT_TRACE_INSTALLED__?: boolean
}

let latestPresence: MultiplayerPresenceSnapshot = { local: null, remote: null }

function signed32(value: number) {
  return value | 0
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 0x3) === 0
}

function profileKey(profile: { matEntry: number; faceIndex: number; geomFlags: number; matFlags: number } | null) {
  if (!profile) return null
  return `${profile.matEntry}:${profile.faceIndex}:${profile.geomFlags}:${profile.matFlags}`
}

function stateData(state: MultiplayerPlayerState | null) {
  const world = state?.worldPosition
  return {
    mapId: state ? String(state.location.mapId) : '',
    gridX: state?.x ?? 0,
    gridY: state?.y ?? 0,
    direction: state?.direction ?? '',
    movementState: state?.movementState ?? '',
    worldX: world?.x ?? 0,
    worldY: world?.y ?? 0,
    worldZ: world?.z ?? 0,
  } satisfies TraceData
}

function numberStats(values: number[]): TraceNumberStats {
  if (!values.length) return { count: 0, min: null, median: null, p95: null, max: null, mean: null }
  const sorted = values.slice().sort((a, b) => a - b)
  const percentile = (ratio: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  return {
    count: sorted.length,
    min: sorted[0],
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted[sorted.length - 1],
    mean,
  }
}

function eventIntervals(events: MultiplayerMovementTraceEvent[], stage: TraceStage) {
  const byTab = new Map<string, MultiplayerMovementTraceEvent[]>()
  for (const event of events) {
    if (event.stage !== stage) continue
    const list = byTab.get(event.tabId) ?? []
    list.push(event)
    byTab.set(event.tabId, list)
  }
  const values: number[] = []
  for (const list of byTab.values()) {
    list.sort((a, b) => a.at - b.at)
    for (let index = 1; index < list.length; index += 1) values.push(list[index].at - list[index - 1].at)
  }
  return values
}

function countProfileChanges(events: MultiplayerMovementTraceEvent[], field: 'localProfile' | 'remoteProfile') {
  const byTab = new Map<string, MultiplayerMovementTraceEvent[]>()
  for (const event of events) {
    if (event.stage !== 'memory_sample') continue
    const list = byTab.get(event.tabId) ?? []
    list.push(event)
    byTab.set(event.tabId, list)
  }
  let changes = 0
  for (const list of byTab.values()) {
    list.sort((a, b) => a.at - b.at)
    let previous: string | null = null
    for (const event of list) {
      const value = typeof event.data[field] === 'string' && event.data[field] ? String(event.data[field]) : null
      if (!value) continue
      if (previous && previous !== value) changes += 1
      previous = value
    }
  }
  return changes
}

function summarize(events: MultiplayerMovementTraceEvent[], startedAt: number | null, stoppedAt: number | null): MultiplayerMovementTraceSummary {
  const sorted = events.slice().sort((a, b) => a.at - b.at)
  const stageCounts: Record<string, number> = {}
  const speedCounts: Record<string, number> = {}
  const packetAges: number[] = []
  const renderErrors: number[] = []
  const overheads: number[] = []
  const remoteProfiles = new Map<string, number>()
  const localProfiles = new Set<string>()
  let sequenceGaps = 0
  const lastSequenceBySender = new Map<string, number>()

  for (const event of sorted) {
    stageCounts[event.stage] = (stageCounts[event.stage] ?? 0) + 1
    if (event.stage === 'memory_sample') {
      const speed = Number(event.data.speed || 0)
      if (speed) speedCounts[`${speed}x`] = (speedCounts[`${speed}x`] ?? 0) + 1
      const renderError = Number(event.data.renderErrorTiles)
      if (Number.isFinite(renderError)) renderErrors.push(renderError)
      const overhead = Number(event.data.sampleDurationMs)
      if (Number.isFinite(overhead)) overheads.push(overhead)
      const localProfile = typeof event.data.localProfile === 'string' ? event.data.localProfile : ''
      const remoteProfile = typeof event.data.remoteProfile === 'string' ? event.data.remoteProfile : ''
      if (localProfile) localProfiles.add(localProfile)
      if (remoteProfile) remoteProfiles.set(remoteProfile, (remoteProfiles.get(remoteProfile) ?? 0) + 1)
    }
    if (event.stage === 'receive_wire') {
      const age = Number(event.data.packetAgeMs)
      if (Number.isFinite(age)) packetAges.push(age)
      const sender = String(event.data.senderId || '')
      const sequence = Number(event.data.sequence)
      if (sender && Number.isFinite(sequence)) {
        const previous = lastSequenceBySender.get(sender)
        if (previous !== undefined && sequence > previous + 1) sequenceGaps += sequence - previous - 1
        if (previous === undefined || sequence > previous) lastSequenceBySender.set(sender, sequence)
      }
    }
  }

  const remoteOnlyProfiles: Record<string, number> = {}
  for (const [key, count] of remoteProfiles) {
    if (!localProfiles.has(key)) remoteOnlyProfiles[key] = count
  }

  return {
    eventCount: sorted.length,
    durationMs: startedAt === null ? null : Math.max(0, (stoppedAt ?? Date.now()) - startedAt),
    tabs: [...new Set(sorted.map(event => event.tabLabel))].filter(Boolean).sort(),
    stageCounts,
    speedCounts,
    localSampleIntervalMs: numberStats(eventIntervals(sorted, 'local_sample')),
    publishIntervalMs: numberStats(eventIntervals(sorted, 'publish')),
    receiveIntervalMs: numberStats(eventIntervals(sorted, 'receive_wire')),
    packetAgeMs: numberStats(packetAges),
    renderErrorTiles: numberStats(renderErrors),
    sampleOverheadMs: numberStats(overheads),
    sequenceGaps,
    localProfileChanges: countProfileChanges(sorted, 'localProfile'),
    remoteProfileChanges: countProfileChanges(sorted, 'remoteProfile'),
    remoteOnlyProfiles,
  }
}

class MultiplayerMovementTraceController {
  readonly tabId = crypto.randomUUID()
  private tabLabel = 'PLAYER ?'
  private active = false
  private traceId: string | null = null
  private startedAt: number | null = null
  private endsAt: number | null = null
  private stoppedAt: number | null = null
  private events: MultiplayerMovementTraceEvent[] = []
  private readonly listeners = new Set<(snapshot: MultiplayerMovementTraceSnapshot) => void>()
  private readonly bridgeStates = new Map<MelonDsBridge, BridgeTraceState>()
  private channel: BroadcastChannel | null = null
  private stopTimer: number | null = null
  private samplerTimer: number | null = null
  private emitTimer: number | null = null

  constructor() {
    if ('BroadcastChannel' in window) {
      this.channel = new BroadcastChannel(TRACE_CHANNEL)
      this.channel.onmessage = event => this.receiveWire(event.data as TraceWireMessage)
    }
  }

  setTabLabel(label: string) {
    this.tabLabel = label
    this.scheduleEmit()
  }

  registerBridge(bridge: MelonDsBridge) {
    if (this.bridgeStates.has(bridge)) return
    this.bridgeStates.set(bridge, {
      bridge,
      blActIndexByActor: new Map<number, number>(),
      playerAddress: null,
      remoteAddress: null,
      playerBinding: null,
      remoteBinding: null,
      lastDiscoveryAt: 0,
      sampling: false,
    })
  }

  unregisterBridge(bridge: MelonDsBridge) {
    this.bridgeStates.delete(bridge)
  }

  observeBlActIndex(bridge: MelonDsBridge, actorAddress: number, index: number) {
    const state = this.bridgeStates.get(bridge)
    if (!state || index === BLACT_NONE) return
    const previous = state.blActIndexByActor.get(actorAddress)
    state.blActIndexByActor.set(actorAddress, index)
    if (previous !== index) {
      if (state.playerBinding?.actorAddress === actorAddress) state.playerBinding = null
      if (state.remoteBinding?.actorAddress === actorAddress) state.remoteBinding = null
    }
  }

  isActive() {
    return this.active
  }

  start(durationMs = 10000) {
    const traceId = crypto.randomUUID()
    const startedAt = Date.now()
    this.applyStart(traceId, startedAt, durationMs)
    this.channel?.postMessage({ type: 'start', traceId, startedAt, durationMs } satisfies TraceWireMessage)
  }

  stop() {
    if (!this.active || !this.traceId) return
    const traceId = this.traceId
    const stoppedAt = Date.now()
    this.applyStop(traceId, stoppedAt)
    this.channel?.postMessage({ type: 'stop', traceId, stoppedAt } satisfies TraceWireMessage)
  }

  clear() {
    this.events = []
    this.stoppedAt = null
    this.channel?.postMessage({ type: 'clear' } satisfies TraceWireMessage)
    this.scheduleEmit()
  }

  mark(note = 'VISUAL MARK') {
    this.record('marker', { note })
  }

  record(stage: TraceStage, data: TraceData) {
    if (!this.active || !this.traceId) return
    const event: MultiplayerMovementTraceEvent = {
      version: TRACE_VERSION,
      traceId: this.traceId,
      tabId: this.tabId,
      tabLabel: this.tabLabel,
      stage,
      at: Date.now(),
      perfAt: performance.now(),
      data,
    }
    this.appendEvent(event)
    this.channel?.postMessage({ type: 'event', event } satisfies TraceWireMessage)
  }

  subscribe(listener: (snapshot: MultiplayerMovementTraceSnapshot) => void) {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  snapshot(): MultiplayerMovementTraceSnapshot {
    return {
      active: this.active,
      traceId: this.traceId,
      startedAt: this.startedAt,
      endsAt: this.endsAt,
      eventCount: this.events.length,
      tabLabel: this.tabLabel,
    }
  }

  summary() {
    return summarize(this.events, this.startedAt, this.stoppedAt)
  }

  exportJson() {
    const events = this.events.slice().sort((a, b) => a.at - b.at || a.tabId.localeCompare(b.tabId))
    return JSON.stringify({
      version: TRACE_VERSION,
      traceId: this.traceId,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      summary: summarize(events, this.startedAt, this.stoppedAt),
      events,
    }, null, 2)
  }

  private receiveWire(message: TraceWireMessage) {
    if (!message || typeof message !== 'object') return
    if (message.type === 'start') this.applyStart(message.traceId, message.startedAt, message.durationMs)
    if (message.type === 'stop') this.applyStop(message.traceId, message.stoppedAt)
    if (message.type === 'clear') {
      this.events = []
      this.stoppedAt = null
      this.scheduleEmit()
    }
    if (message.type === 'event' && this.traceId === message.event.traceId) this.appendEvent(message.event)
  }

  private applyStart(traceId: string, startedAt: number, durationMs: number) {
    this.traceId = traceId
    this.startedAt = startedAt
    this.endsAt = startedAt + durationMs
    this.stoppedAt = null
    this.events = []
    this.active = true
    if (this.stopTimer !== null) window.clearTimeout(this.stopTimer)
    this.stopTimer = window.setTimeout(() => this.stop(), Math.max(0, this.endsAt - Date.now()))
    this.startSampler()
    this.record('trace_note', { note: 'TRACE START', durationMs })
    this.scheduleEmit()
  }

  private applyStop(traceId: string, stoppedAt: number) {
    if (this.traceId !== traceId) return
    this.active = false
    this.stoppedAt = stoppedAt
    this.endsAt = null
    if (this.stopTimer !== null) window.clearTimeout(this.stopTimer)
    this.stopTimer = null
    this.stopSampler()
    this.scheduleEmit()
  }

  private appendEvent(event: MultiplayerMovementTraceEvent) {
    if (this.events.length >= MAX_EVENTS) this.events.shift()
    this.events.push(event)
    this.scheduleEmit()
  }

  private scheduleEmit() {
    if (this.emitTimer !== null) return
    this.emitTimer = window.setTimeout(() => {
      this.emitTimer = null
      const snapshot = this.snapshot()
      this.listeners.forEach(listener => listener(snapshot))
    }, 120)
  }

  private startSampler() {
    if (this.samplerTimer !== null) return
    const run = () => {
      if (!this.active) return
      for (const state of this.bridgeStates.values()) void this.sampleBridge(state)
    }
    this.samplerTimer = window.setInterval(run, SAMPLE_MS)
    run()
  }

  private stopSampler() {
    if (this.samplerTimer !== null) window.clearInterval(this.samplerTimer)
    this.samplerTimer = null
  }

  private async sampleBridge(state: BridgeTraceState) {
    if (state.sampling || state.bridge.status !== 'running') return
    state.sampling = true
    const started = performance.now()
    try {
      await this.ensureActorAddresses(state)
      const bridge = state.bridge
      const remoteAddress = state.remoteAddress
      if (!remoteAddress) return

      const [remoteUid, remoteModelId, remoteFaceDir, remoteGridX, remoteGridY, remoteWorldX, remoteWorldY, remoteWorldZ] = await Promise.all([
        bridge.read16(remoteAddress + ACTOR_UID),
        bridge.read16(remoteAddress + ACTOR_MODEL_ID),
        bridge.read16(remoteAddress + ACTOR_FACE_DIR),
        bridge.read16(remoteAddress + ACTOR_GPOS + 0x00),
        bridge.read16(remoteAddress + ACTOR_GPOS + 0x04),
        bridge.read32(remoteAddress + ACTOR_WPOS + 0x00),
        bridge.read32(remoteAddress + ACTOR_WPOS + 0x04),
        bridge.read32(remoteAddress + ACTOR_WPOS + 0x08),
      ])

      if (remoteUid !== POKERUN_NATIVE_TEST_UID) {
        state.remoteAddress = null
        state.remoteBinding = null
        return
      }

      const playerAddress = state.playerAddress
      let localProfile: string | null = null
      let remoteProfile: string | null = null
      let localFaceDir: number | null = null

      if (playerAddress) {
        const localUid = await bridge.read16(playerAddress + ACTOR_UID)
        if (localUid !== PLAYER_UID) {
          state.playerAddress = null
          state.playerBinding = null
        } else {
          localFaceDir = await bridge.read16(playerAddress + ACTOR_FACE_DIR)
          state.playerBinding = await this.ensureRenderBinding(state, playerAddress, state.playerBinding)
          const profile = state.playerBinding ? await this.readRenderProfile(bridge, state.playerBinding) : null
          localProfile = profileKey(profile)
        }
      }

      state.remoteBinding = await this.ensureRenderBinding(state, remoteAddress, state.remoteBinding)
      const remoteRenderProfile = state.remoteBinding ? await this.readRenderProfile(bridge, state.remoteBinding) : null
      remoteProfile = profileKey(remoteRenderProfile)

      const target = latestPresence.remote?.worldPosition
      const deltaX = target ? signed32(remoteWorldX) - signed32(target.x) : 0
      const deltaY = target ? signed32(remoteWorldY) - signed32(target.y) : 0
      const deltaZ = target ? signed32(remoteWorldZ) - signed32(target.z) : 0
      const renderErrorTiles = target ? Math.hypot(deltaX, deltaZ) / FX32_TILE : 0

      this.record('memory_sample', {
        speed: bridge.getSpeedMultiplier(),
        remoteUid,
        remoteModelId,
        remoteFaceDir,
        remoteGridX,
        remoteGridY,
        remoteWorldX,
        remoteWorldY,
        remoteWorldZ,
        targetWorldX: target?.x ?? 0,
        targetWorldY: target?.y ?? 0,
        targetWorldZ: target?.z ?? 0,
        deltaX,
        deltaY,
        deltaZ,
        renderErrorTiles,
        remoteDirection: latestPresence.remote?.direction ?? '',
        remoteMovementState: latestPresence.remote?.movementState ?? '',
        localFaceDir: localFaceDir ?? -1,
        localProfile: localProfile ?? '',
        remoteProfile: remoteProfile ?? '',
        sampleDurationMs: performance.now() - started,
      })
    } catch (error) {
      this.record('trace_note', { note: error instanceof Error ? `MEMORY SAMPLE: ${error.message}` : 'MEMORY SAMPLE FAILED' })
    } finally {
      state.sampling = false
    }
  }

  private async ensureActorAddresses(state: BridgeTraceState) {
    const now = performance.now()
    const bridge = state.bridge

    if (state.playerAddress !== null) {
      if (await bridge.read16(state.playerAddress + ACTOR_UID) !== PLAYER_UID) {
        state.playerAddress = null
        state.playerBinding = null
      }
    }
    if (state.remoteAddress !== null) {
      if (await bridge.read16(state.remoteAddress + ACTOR_UID) !== POKERUN_NATIVE_TEST_UID) {
        state.remoteAddress = null
        state.remoteBinding = null
      }
    }

    if (state.playerAddress !== null && state.remoteAddress !== null) return
    if (now - state.lastDiscoveryAt < 350) return
    state.lastDiscoveryAt = now

    const snapshot = await new White2ActorSystemProbe(bridge).inspect()
    const previousPlayer = state.playerAddress
    const previousRemote = state.remoteAddress
    state.playerAddress = snapshot.playerActor?.address ?? null

    let remoteAddress: number | null = null
    for (let index = 0; index < snapshot.capacity; index += 1) {
      const address = snapshot.actorHeap + index * FIELD_ACTOR_SIZE
      if (await bridge.read16(address + ACTOR_UID) === POKERUN_NATIVE_TEST_UID) {
        remoteAddress = address
        break
      }
    }
    state.remoteAddress = remoteAddress

    if (previousPlayer !== state.playerAddress) state.playerBinding = null
    if (previousRemote !== state.remoteAddress) state.remoteBinding = null
    if (previousPlayer !== state.playerAddress || previousRemote !== state.remoteAddress) {
      this.record('actor_discovery', {
        playerAddress: state.playerAddress ?? 0,
        remoteAddress: state.remoteAddress ?? 0,
        actorHeap: snapshot.actorHeap,
        capacity: snapshot.capacity,
      })
    }
  }

  private async ensureRenderBinding(state: BridgeTraceState, actorAddress: number, current: RenderBinding | null) {
    const bridge = state.bridge
    const index = state.blActIndexByActor.get(actorAddress)
    if (index === undefined || index === BLACT_NONE) return null

    if (current && current.actorAddress === actorAddress && current.blActIndex === index) {
      const owner = await bridge.read32(current.handleAddress + HANDLE_BLACT_INDEX)
      if (owner === index) return current
    }

    const actorSystem = await bridge.read32(actorAddress + ACTOR_SYSTEM_BACKPTR)
    if (!isMainRamPointer(actorSystem)) return null
    const fieldBlAct = await bridge.read32(actorSystem + ACTOR_SYSTEM_FIELD_BLACT)
    if (!isMainRamPointer(fieldBlAct)) return null
    const blActSystem = await bridge.read32(fieldBlAct + FIELD_BLACT_SYSTEM)
    if (!isMainRamPointer(blActSystem)) return null
    const [scene, actorHandles, handleCount] = await Promise.all([
      bridge.read32(blActSystem + BLACT_SYSTEM_SCENE),
      bridge.read32(blActSystem + BLACT_SYSTEM_ACTOR_HANDLES),
      bridge.read16(blActSystem + BLACT_SYSTEM_ACTOR_COUNT),
    ])
    if (!isMainRamPointer(scene) || !isMainRamPointer(actorHandles)) return null
    const [sceneActors, sceneActorCount] = await Promise.all([
      bridge.read32(scene + BLACT_SCENE_ACTORS),
      bridge.read16(scene + BLACT_SCENE_CONFIG_ACTOR_COUNT),
    ])
    if (!isMainRamPointer(sceneActors) || index >= sceneActorCount) return null

    let handleAddress = 0
    for (let handleIndex = 0; handleIndex < handleCount; handleIndex += 1) {
      const candidate = actorHandles + handleIndex * HANDLE_SIZE
      if (await bridge.read32(candidate + HANDLE_BLACT_INDEX) !== index) continue
      if (handleAddress) return null
      handleAddress = candidate
    }
    if (!handleAddress) return null

    return {
      actorAddress,
      blActIndex: index,
      blActAddress: sceneActors + index * BLACT_SIZE,
      handleAddress,
    }
  }

  private async readRenderProfile(bridge: MelonDsBridge, binding: RenderBinding) {
    const [matEntry, faceIndex, geomFlags, matFlags] = await Promise.all([
      bridge.read16(binding.handleAddress + HANDLE_MAT_ENTRY),
      bridge.read16(binding.blActAddress + BLACT_FACE_INDEX),
      bridge.read16(binding.blActAddress + BLACT_GEOM_FLAGS),
      bridge.read16(binding.blActAddress + BLACT_MAT_FLAGS),
    ])
    return { matEntry, faceIndex, geomFlags, matFlags }
  }
}

const traceWindow = window as TraceWindow
export const multiplayerMovementTrace = traceWindow.__POKERUN_MOVEMENT_TRACE_CONTROLLER__ ?? new MultiplayerMovementTraceController()
traceWindow.__POKERUN_MOVEMENT_TRACE_CONTROLLER__ = multiplayerMovementTrace

export function installMultiplayerMovementTraceInstrumentation() {
  if (traceWindow.__POKERUN_MOVEMENT_TRACE_INSTALLED__) return
  traceWindow.__POKERUN_MOVEMENT_TRACE_INSTALLED__ = true

  multiplayerPresence.subscribe(snapshot => {
    const previousRemote = latestPresence.remote
    latestPresence = snapshot
    if (snapshot.remote && snapshot.remote !== previousRemote) {
      multiplayerMovementTrace.record('remote_target', stateData(snapshot.remote))
    }
  })

  const originalAttachScreens = MelonDsBridge.prototype.attachScreens
  MelonDsBridge.prototype.attachScreens = function(top: HTMLCanvasElement, bottom: HTMLCanvasElement) {
    multiplayerMovementTrace.registerBridge(this)
    return originalAttachScreens.call(this, top, bottom)
  }

  const originalDispose = MelonDsBridge.prototype.dispose
  MelonDsBridge.prototype.dispose = async function() {
    multiplayerMovementTrace.unregisterBridge(this)
    return originalDispose.call(this)
  }

  const originalNativeCall = MelonDsBridge.prototype.callArm9Thumb4
  MelonDsBridge.prototype.callArm9Thumb4 = async function(
    functionAddress: number,
    r0 = 0,
    r1 = 0,
    r2 = 0,
    r3 = 0,
    stackReserve = 0x1000,
  ): Promise<Arm9NativeCallResult> {
    const result = await originalNativeCall.call(this, functionAddress, r0, r1, r2, r3, stackReserve)
    if ((functionAddress >>> 0) === FLDACT_GET_BLACT_IDX && result.status === 1) {
      multiplayerMovementTrace.observeBlActIndex(this, r0 >>> 0, result.result & 0xffff)
    }
    return result
  }

  const originalWorldRead = White2WorldPositionReader.prototype.read
  White2WorldPositionReader.prototype.read = async function(): Promise<MultiplayerWorldPosition> {
    const started = performance.now()
    const result = await originalWorldRead.call(this)
    const bridge = (this as unknown as { bridge: MelonDsBridge }).bridge
    multiplayerMovementTrace.record('local_sample', {
      speed: bridge.getSpeedMultiplier(),
      worldX: result.x,
      worldY: result.y,
      worldZ: result.z,
      readDurationMs: performance.now() - started,
    })
    return result
  }

  const originalPublish = LocalMultiplayerSession.prototype.publishGameState
  LocalMultiplayerSession.prototype.publishGameState = function(state: MultiplayerPlayerState) {
    const result = originalPublish.call(this, state)
    const outbound = latestPresence.local
    const sequence = Number((this as unknown as { sequence: number }).sequence)
    multiplayerMovementTrace.record('publish', {
      sequence,
      playerId: this.localPlayerId,
      ...stateData(outbound),
    })
    return result
  }

  const originalOnMessage = BroadcastChannelTransport.prototype.onMessage
  BroadcastChannelTransport.prototype.onMessage = function(listener: (message: MultiplayerMessage) => void) {
    return originalOnMessage.call(this, message => {
      if (message.type === 'GAME_STATE') {
        multiplayerMovementTrace.record('receive_wire', {
          senderId: message.senderId,
          playerId: message.playerId,
          sequence: message.sequence,
          packetAgeMs: Math.max(0, Date.now() - message.sentAt),
          ...stateData(message.state),
        })
      }
      listener(message)
    })
  }
}
