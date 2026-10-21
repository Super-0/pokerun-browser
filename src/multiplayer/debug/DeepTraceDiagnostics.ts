import {
  MelonDsBridge,
  type DsButton,
  type DsSpeedMultiplier,
  type MelonDsFrameStats,
} from '../../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerConnectionState, MultiplayerMessage } from '../core/protocol'
import { BroadcastChannelTransport } from '../transports/BroadcastChannelTransport'
import { multiplayerMovementTrace } from './MultiplayerMovementTrace'

type TraceData = Record<string, string | number | boolean | null>
type TraceApi = {
  isActive(): boolean
  record(stage: string, data: TraceData): void
  subscribe(listener: (snapshot: { active: boolean }) => void): () => void
}
type MemoryPerformance = Performance & {
  memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
}
type NetworkInformation = EventTarget & {
  effectiveType?: string
  downlink?: number
  rtt?: number
  saveData?: boolean
}
type NavigatorDiagnostics = Navigator & {
  deviceMemory?: number
  connection?: NetworkInformation
  userAgentData?: {
    brands?: Array<{ brand: string; version: string }>
    mobile?: boolean
    platform?: string
  }
}
type RuntimeWindow = Window & {
  Module?: { HEAPU8?: { byteLength?: number } }
  __POKERUN_DEEP_TRACE_INSTALLED__?: boolean
}
type BridgeSnapshot = { at: number; stats: MelonDsFrameStats }
type ListenerStats = { calls: number; totalMs: number; maxMs: number }
type RafStats = {
  count: number
  totalMs: number
  minMs: number
  maxMs: number
  over20: number
  over25: number
  over33: number
  over50: number
}
type LoopStats = {
  count: number
  totalMs: number
  maxMs: number
  over10: number
  over25: number
  over50: number
}

const SAMPLE_MS = 250
const LOOP_MS = 50
const trace = multiplayerMovementTrace as unknown as TraceApi
const runtimeWindow = window as RuntimeWindow
const nav = navigator as NavigatorDiagnostics
const bridges = new Set<MelonDsBridge>()
const bridgeSnapshots = new Map<MelonDsBridge, BridgeSnapshot>()
const listenerStats = new Map<MelonDsBridge, ListenerStats>()
const localSenderIds = new Set<string>()

let active = false
let rafId: number | null = null
let sampleTimer: number | null = null
let loopTimer: number | null = null
let loopExpectedAt = 0
let lastRafAt = 0
let longTaskObserver: PerformanceObserver | null = null
let rafStats = newRafStats()
let loopStats = newLoopStats()
let longTaskCount = 0
let longTaskTotalMs = 0
let longTaskMaxMs = 0

function newRafStats(): RafStats {
  return { count: 0, totalMs: 0, minMs: Number.POSITIVE_INFINITY, maxMs: 0, over20: 0, over25: 0, over33: 0, over50: 0 }
}

function newLoopStats(): LoopStats {
  return { count: 0, totalMs: 0, maxMs: 0, over10: 0, over25: 0, over50: 0 }
}

function record(stage: string, data: TraceData) {
  if (trace.isActive()) trace.record(stage, data)
}

function connectionData(): TraceData {
  const connection = nav.connection
  return {
    networkEffectiveType: connection?.effectiveType ?? '',
    networkDownlinkMbps: connection?.downlink ?? null,
    networkRttMs: connection?.rtt ?? null,
    networkSaveData: connection?.saveData ?? false,
  }
}

function memoryData(): TraceData {
  const memory = (performance as MemoryPerformance).memory
  return {
    jsHeapUsedBytes: memory?.usedJSHeapSize ?? null,
    jsHeapTotalBytes: memory?.totalJSHeapSize ?? null,
    jsHeapLimitBytes: memory?.jsHeapSizeLimit ?? null,
    wasmHeapBytes: runtimeWindow.Module?.HEAPU8?.byteLength ?? null,
  }
}

function recordEnvironment() {
  const ua = nav.userAgentData
  record('environment', {
    userAgent: navigator.userAgent,
    uaBrands: ua?.brands?.map(item => `${item.brand}/${item.version}`).join(', ') ?? '',
    uaPlatform: ua?.platform ?? navigator.platform,
    uaMobile: ua?.mobile ?? false,
    language: navigator.language,
    hardwareConcurrency: navigator.hardwareConcurrency || null,
    deviceMemoryGiB: nav.deviceMemory ?? null,
    maxTouchPoints: navigator.maxTouchPoints,
    crossOriginIsolated: window.crossOriginIsolated,
    devicePixelRatio: window.devicePixelRatio,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    online: navigator.onLine,
    timeOrigin: performance.timeOrigin,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...connectionData(),
    ...memoryData(),
  })
}

function runRaf(now: number) {
  if (!active) return
  if (lastRafAt) {
    const interval = Math.max(0, now - lastRafAt)
    rafStats.count += 1
    rafStats.totalMs += interval
    rafStats.minMs = Math.min(rafStats.minMs, interval)
    rafStats.maxMs = Math.max(rafStats.maxMs, interval)
    if (interval > 20) rafStats.over20 += 1
    if (interval > 25) rafStats.over25 += 1
    if (interval > 33) rafStats.over33 += 1
    if (interval > 50) rafStats.over50 += 1
  }
  lastRafAt = now
  rafId = requestAnimationFrame(runRaf)
}

function sample() {
  if (!active || !trace.isActive()) return
  const now = performance.now()
  const buildStarted = now

  record('browser_perf', {
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    online: navigator.onLine,
    rafSamples: rafStats.count,
    rafMeanIntervalMs: rafStats.count ? rafStats.totalMs / rafStats.count : 0,
    rafMinIntervalMs: Number.isFinite(rafStats.minMs) ? rafStats.minMs : 0,
    rafMaxIntervalMs: rafStats.maxMs,
    rafOver20Ms: rafStats.over20,
    rafOver25Ms: rafStats.over25,
    rafOver33Ms: rafStats.over33,
    rafOver50Ms: rafStats.over50,
    eventLoopSamples: loopStats.count,
    eventLoopMeanLagMs: loopStats.count ? loopStats.totalMs / loopStats.count : 0,
    eventLoopMaxLagMs: loopStats.maxMs,
    eventLoopOver10Ms: loopStats.over10,
    eventLoopOver25Ms: loopStats.over25,
    eventLoopOver50Ms: loopStats.over50,
    longTaskCount,
    longTaskTotalMs,
    longTaskMaxMs,
    ...connectionData(),
    ...memoryData(),
    diagnosticBuildMs: performance.now() - buildStarted,
  })

  rafStats = newRafStats()
  loopStats = newLoopStats()
  longTaskCount = 0
  longTaskTotalMs = 0
  longTaskMaxMs = 0

  for (const bridge of bridges) {
    const current = bridge.getFrameStats()
    const previous = bridgeSnapshots.get(bridge)
    if (previous) {
      const elapsedMs = Math.max(0.001, now - previous.at)
      const frames = current.frames - previous.stats.frames
      const hiddenFrames = current.hiddenFrames - previous.stats.hiddenFrames
      const visibleFrames = current.visibleFrames - previous.stats.visibleFrames
      const batches = current.batches - previous.stats.batches
      const callbacks = current.rafCallbacks - previous.stats.rafCallbacks
      const processMs = current.processMs - previous.stats.processMs
      const hiddenProcessMs = current.hiddenProcessMs - previous.stats.hiddenProcessMs
      const visibleProcessMs = current.visibleProcessMs - previous.stats.visibleProcessMs
      const batchMs = current.batchMs - previous.stats.batchMs
      const speed = bridge.getSpeedMultiplier()
      const listener = listenerStats.get(bridge) ?? { calls: 0, totalMs: 0, maxMs: 0 }
      const fps = frames * 1000 / elapsedMs

      record('emulator_window', {
        speed,
        targetFramesPerSec: speed * 60,
        elapsedMs,
        frames,
        hiddenFrames,
        visibleFrames,
        batches,
        rafCallbacks: callbacks,
        skippedRafCallbacks: Math.max(0, callbacks - batches),
        framesPerSec: fps,
        targetAttainmentPercent: fps / (speed * 60) * 100,
        processMs,
        processMsPerFrame: frames ? processMs / frames : 0,
        hiddenMsPerFrame: hiddenFrames ? hiddenProcessMs / hiddenFrames : 0,
        visibleMsPerFrame: visibleFrames ? visibleProcessMs / visibleFrames : 0,
        batchMs,
        batchMsPerBatch: batches ? batchMs / batches : 0,
        busyPercent: batchMs * 100 / elapsedMs,
        emulatedFrameListenerCalls: listener.calls,
        emulatedFrameListenerMs: listener.totalMs,
        emulatedFrameListenerMaxMs: listener.maxMs,
      })
      listenerStats.set(bridge, { calls: 0, totalMs: 0, maxMs: 0 })
    }
    bridgeSnapshots.set(bridge, { at: now, stats: current })
  }
}

function startDiagnostics() {
  if (active) return
  active = true
  lastRafAt = 0
  rafStats = newRafStats()
  loopStats = newLoopStats()
  longTaskCount = 0
  longTaskTotalMs = 0
  longTaskMaxMs = 0
  bridgeSnapshots.clear()
  for (const bridge of bridges) bridgeSnapshots.set(bridge, { at: performance.now(), stats: bridge.getFrameStats() })

  recordEnvironment()
  recordPageState('trace_start')
  rafId = requestAnimationFrame(runRaf)

  loopExpectedAt = performance.now() + LOOP_MS
  loopTimer = window.setInterval(() => {
    const now = performance.now()
    const lag = Math.max(0, now - loopExpectedAt)
    loopStats.count += 1
    loopStats.totalMs += lag
    loopStats.maxMs = Math.max(loopStats.maxMs, lag)
    if (lag > 10) loopStats.over10 += 1
    if (lag > 25) loopStats.over25 += 1
    if (lag > 50) loopStats.over50 += 1
    loopExpectedAt += LOOP_MS
    if (now - loopExpectedAt > 1000) loopExpectedAt = now + LOOP_MS
  }, LOOP_MS)

  sampleTimer = window.setInterval(sample, SAMPLE_MS)

  try {
    longTaskObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        longTaskCount += 1
        longTaskTotalMs += entry.duration
        longTaskMaxMs = Math.max(longTaskMaxMs, entry.duration)
        record('long_task', { name: entry.name, startTime: entry.startTime, durationMs: entry.duration })
      }
    })
    longTaskObserver.observe({ entryTypes: ['longtask'] })
  } catch {
    longTaskObserver = null
  }
}

function stopDiagnostics() {
  if (!active) return
  active = false
  if (rafId !== null) cancelAnimationFrame(rafId)
  if (sampleTimer !== null) window.clearInterval(sampleTimer)
  if (loopTimer !== null) window.clearInterval(loopTimer)
  rafId = null
  sampleTimer = null
  loopTimer = null
  longTaskObserver?.disconnect()
  longTaskObserver = null
}

function recordPageState(event: string) {
  record('page_state', {
    event,
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    online: navigator.onLine,
    ...connectionData(),
  })
}

function messageData(message: MultiplayerMessage): TraceData {
  if (message.type === 'GAME_STATE') {
    return {
      type: message.type,
      senderId: message.senderId,
      playerId: message.playerId,
      sequence: message.sequence,
      sentAt: message.sentAt,
      senderClockAgeMs: Math.max(0, Date.now() - message.sentAt),
      mapId: String(message.state.location.mapId),
      gridX: message.state.x,
      gridY: message.state.y,
      direction: message.state.direction,
      movementState: message.state.movementState ?? '',
    }
  }
  return {
    type: message.type,
    senderId: message.senderId,
    sentAt: message.sentAt,
    senderClockAgeMs: Math.max(0, Date.now() - message.sentAt),
  }
}

export function installDeepTraceDiagnostics() {
  if (runtimeWindow.__POKERUN_DEEP_TRACE_INSTALLED__) return
  runtimeWindow.__POKERUN_DEEP_TRACE_INSTALLED__ = true

  trace.subscribe(snapshot => snapshot.active ? startDiagnostics() : stopDiagnostics())

  document.addEventListener('visibilitychange', () => recordPageState('visibilitychange'))
  window.addEventListener('focus', () => recordPageState('focus'))
  window.addEventListener('blur', () => recordPageState('blur'))
  window.addEventListener('online', () => recordPageState('online'))
  window.addEventListener('offline', () => recordPageState('offline'))
  window.addEventListener('pagehide', () => recordPageState('pagehide'))
  window.addEventListener('pageshow', () => recordPageState('pageshow'))
  nav.connection?.addEventListener?.('change', () => recordPageState('connectionchange'))

  const originalAttachScreens = MelonDsBridge.prototype.attachScreens
  MelonDsBridge.prototype.attachScreens = function(top: HTMLCanvasElement, bottom: HTMLCanvasElement) {
    bridges.add(this)
    listenerStats.set(this, { calls: 0, totalMs: 0, maxMs: 0 })
    const result = originalAttachScreens.call(this, top, bottom)
    record('emulator_lifecycle', { event: 'attach_screens', speed: this.getSpeedMultiplier() })
    return result
  }

  const originalDispose = MelonDsBridge.prototype.dispose
  MelonDsBridge.prototype.dispose = async function() {
    record('emulator_lifecycle', { event: 'dispose', speed: this.getSpeedMultiplier() })
    bridges.delete(this)
    bridgeSnapshots.delete(this)
    listenerStats.delete(this)
    return originalDispose.call(this)
  }

  const originalSetSpeed = MelonDsBridge.prototype.setSpeedMultiplier
  MelonDsBridge.prototype.setSpeedMultiplier = function(multiplier: DsSpeedMultiplier) {
    const previous = this.getSpeedMultiplier()
    const result = originalSetSpeed.call(this, multiplier)
    record('speed_change', { from: previous, to: multiplier })
    return result
  }

  const originalPress = MelonDsBridge.prototype.press
  MelonDsBridge.prototype.press = function(button: DsButton, pressed: boolean) {
    record('input', { kind: 'button', button, pressed, speed: this.getSpeedMultiplier() })
    return originalPress.call(this, button, pressed)
  }

  const originalTouch = MelonDsBridge.prototype.touch
  MelonDsBridge.prototype.touch = function(clientX: number, clientY: number) {
    record('input', { kind: 'touch', clientX, clientY, speed: this.getSpeedMultiplier() })
    return originalTouch.call(this, clientX, clientY)
  }

  const originalReleaseTouch = MelonDsBridge.prototype.releaseTouch
  MelonDsBridge.prototype.releaseTouch = function() {
    record('input', { kind: 'touch_release', speed: this.getSpeedMultiplier() })
    return originalReleaseTouch.call(this)
  }

  const originalSubscribeFrame = MelonDsBridge.prototype.subscribeEmulatedFrame
  MelonDsBridge.prototype.subscribeEmulatedFrame = function(listener: () => void) {
    const bridge = this
    return originalSubscribeFrame.call(this, () => {
      if (!trace.isActive()) return listener()
      const started = performance.now()
      try {
        listener()
      } finally {
        const durationMs = performance.now() - started
        const stats = listenerStats.get(bridge) ?? { calls: 0, totalMs: 0, maxMs: 0 }
        stats.calls += 1
        stats.totalMs += durationMs
        stats.maxMs = Math.max(stats.maxMs, durationMs)
        listenerStats.set(bridge, stats)
      }
    })
  }

  const originalSend = BroadcastChannelTransport.prototype.send
  BroadcastChannelTransport.prototype.send = function(message: MultiplayerMessage) {
    localSenderIds.add(message.senderId)
    record('transport_send', {
      ...messageData(message),
      transport: new URLSearchParams(window.location.search).get('transport') === 'network' ? 'network' : 'broadcast',
    })
    return originalSend.call(this, message)
  }

  const originalOnMessage = BroadcastChannelTransport.prototype.onMessage
  BroadcastChannelTransport.prototype.onMessage = function(listener: (message: MultiplayerMessage) => void) {
    return originalOnMessage.call(this, message => {
      record('transport_receive', {
        ...messageData(message),
        isSelfEcho: localSenderIds.has(message.senderId),
        transport: new URLSearchParams(window.location.search).get('transport') === 'network' ? 'network' : 'broadcast',
      })
      listener(message)
    })
  }

  const originalOnConnectionChange = BroadcastChannelTransport.prototype.onConnectionChange
  BroadcastChannelTransport.prototype.onConnectionChange = function(listener: (state: MultiplayerConnectionState) => void) {
    return originalOnConnectionChange.call(this, state => {
      record('transport_connection', { state })
      listener(state)
    })
  }
}
