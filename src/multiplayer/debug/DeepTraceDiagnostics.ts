import {
  MelonDsBridge,
  type DsButton,
  type DsSpeedMultiplier,
  type MelonDsFrameStats,
} from '../../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerConnectionState, MultiplayerMessage } from '../core/protocol'
import { BroadcastChannelTransport } from '../transports/BroadcastChannelTransport'
import { multiplayerMovementTrace } from './MultiplayerMovementTrace'

type DeepTraceData = Record<string, string | number | boolean | null>
type TraceSnapshot = { active: boolean; traceId: string | null }
type TraceApi = {
  isActive(): boolean
  record(stage: string, data: DeepTraceData): void
  subscribe(listener: (snapshot: TraceSnapshot) => void): () => void
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
type BridgeWindow = {
  at: number
  stats: MelonDsFrameStats
}
type ListenerWindow = {
  calls: number
  totalMs: number
  maxMs: number
}
type IntervalWindow = {
  count: number
  totalMs: number
  minMs: number
  maxMs: number
  over20: number
  over25: number
  over33: number
  over50: number
}
type LagWindow = {
  count: number
  totalMs: number
  maxMs: number
  over10: number
  over25: number
  over50: number
}

const SAMPLE_WINDOW_MS = 250
const EVENT_LOOP_INTERVAL_MS = 50
const trace = multiplayerMovementTrace as unknown as TraceApi
const runtimeWindow = window as RuntimeWindow
const nav = navigator as NavigatorDiagnostics
const bridges = new Set<MelonDsBridge>()
const bridgeWindows = new Map<MelonDsBridge, BridgeWindow>()
const listenerWindows = new Map<MelonDsBridge, ListenerWindow>()
const localSenderIds = new Set<string>()

let diagnosticsActive = false
let rafId: number | null = null
let lastRafAt = 0
let sampleTimer: number | null = null
let eventLoopTimer: number | null = null
let eventLoopExpectedAt = 0
let longTaskObserver: PerformanceObserver | null = null
let rafWindow = emptyIntervalWindow()
let lagWindow = emptyLagWindow()
let longTaskCount = 0
let longTaskTotalMs = 0
let longTaskMaxMs = 0

function emptyIntervalWindow(): IntervalWindow {
  return { count: 0, totalMs: 0, minMs: Number.POSITIVE_INFINITY, maxMs: 0, over20: 0, over25: 0, over33: 0, over50: 0 }
}

function emptyLagWindow(): LagWindow {
  return { count: 0, totalMs: 0, maxMs: 0, over10: 0, over25: 0, over50: 0 }
}

function record(stage: string, data: DeepTraceData) {
  if (!trace.isActive()) return
  trace.record(stage, data)
}

function connectionData() {
  const connection = nav.connection
  return {
    networkEffectiveType: connection?.effectiveType ?? '',
    networkDownlinkMbps: connection?.downlink ?? null,
    networkRttMs: connection?.rtt ?? null,
    networkSaveData: connection?.saveData ?? false,
  } satisfies DeepTraceData
}

function memoryData() {
  const memory = (performance as MemoryPerformance).memory
  return {
    jsHeapUsedBytes: memory?.usedJSHeapSize ?? null,
    jsHeapTotalBytes: memory?.totalJSHeapSize ?? null,
    jsHeapLimitBytes: memory?.jsHeapSizeLimit ?? null,
    wasmHeapBytes: runtimeWindow.Module?.HEAPU8?.byteLength ?? null,
  } satisfies DeepTraceData
}

function environmentData() {
  const ua = nav.userAgentData
  return {
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
  } satisfies DeepTraceData
}

function addRafInterval(intervalMs: number) {
  rafWindow.count += 1
  rafWindow.totalMs += intervalMs
  rafWindow.minMs = Math.min(rafWindow.minMs, intervalMs)
  rafWindow.maxMs = Math.max(rafWindow.maxMs, intervalMs)
  if (intervalMs > 20) rafWindow.over20 += 1
  if (intervalMs > 25) rafWindow.over25 += 1
  if (intervalMs > 33) rafWindow.over33 += 1
  if (intervalMs > 50) rafWindow.over50 += 1
}

function addEventLoopLag(lagMs: number) {
  lagWindow.count += 1
  lagWindow.totalMs += lagMs
  lagWindow.maxMs = Math.max(lagWindow.maxMs, lagMs)
  if (lagMs > 10) lagWindow.over10 += 1
  if (lagMs > 25) lagWindow.over25 += 1
  if (lagMs > 50) lagWindow.over50 += 1
}

function runRaf(now: number) {
  if (!diagnosticsActive) return
  if (lastRafAt) addRafInterval(Math.max(0, now - lastRafAt))
  lastRafAt = now
  rafId = requestAnimationFrame(runRaf)
}

function sampleBrowserAndBridges() {
  if (!diagnosticsActive || !trace.isActive()) return
  const sampleStarted = performance.now()
  const now = performance.now()
  const rafMeanMs = rafWindow.count ? rafWindow.totalMs / rafWindow.count : 0
  const eventLoopMeanLagMs = lagWindow.count ? lagWindow.totalMs / lagWindow.count : 0

  record('browser_perf', {
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    online: navigator.onLine,
    rafSamples: rafWindow.count,
    rafMeanIntervalMs: rafMeanMs,
    rafMinIntervalMs: Number.isFinite(rafWindow.minMs) ? rafWindow.minMs : 0,
    rafMaxIntervalMs: rafWindow.maxMs,
    rafOver20Ms: rafWindow.over20,
    rafOver25Ms: rafWindow.over25,
    rafOver33Ms: rafWindow.over33,
    rafOver50Ms: rafWindow.over50,
    eventLoopSamples: lagWindow.count,
    eventLoopMeanLagMs,
    eventLoopMaxLagMs: lagWindow.maxMs,
    eventLoopOver10Ms: lagWindow.over10,
    eventLoopOver25Ms: lagWindow.over25,
    eventLoopOver50Ms: lagWindow.over50,
    longTaskCount,
    longTaskTotalMs,
    longTaskMaxMs,
    ...connectionData(),
    ...memoryData(),
    diagnosticBuildMs: performance.now() - sampleStarted,
  })

  rafWindow = emptyIntervalWindow()
  lagWindow = emptyLagWindow()
  longTaskCount = 0
  longTaskTotalMs = 0
  longTaskMaxMs = 0

  for (const bridge of bridges) {
    const current = bridge.getFrameStats()
    const previous = bridgeWindows.get(bridge)
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
      const listener = listenerWindows.get(bridge) ?? { calls: 0, totalMs: 0, maxMs: 0 }

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
        framesPerSec: frames * 1000 / elapsedMs,
        targetAttainmentPercent: frames * 1000 / elapsedMs / (speed * 60) * 100,
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

      listenerWindows.set(bridge, { calls: 0, totalMs: 0, maxMs: 0 })
    }
    bridgeWindows.set(bridge, { at: now, stats: current })
  }
}

function startDiagnostics() {
  if (diagnosticsActive) return
  diagnosticsActive = true
  lastRafAt = 0
  rafWindow = emptyIntervalWindow()
  lagWindow = emptyLagWindow()
  longTaskCount = 0
  longTaskTotalMs = 0
  longTaskMaxMs = 0
  bridgeWindows.clear()
  for (const bridge of bridges) bridgeWindows.set(bridge, { at: performance.now(), stats: bridge.getFrameStats() })

  record('environment', environmentData())
  record('page_state', {
    event: 'trace_start',
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    online: navigator.onLine,
  })

  rafId = requestAnimationFrame(runRaf)
  eventLoopExpectedAt = performance.now() + EVENT_LOOP_INTERVAL_MS
  eventLoopTimer = window.setInterval(() => {
    const now = performance.now()
    const lag = Math.max(0, now - eventLoopExpectedAt)
    addEventLoopLag(lag)
    eventLoopExpectedAt += EVENT_LOOP_INTERVAL_MS
    if (now - eventLoopExpectedAt > 1000) eventLoopExpectedAt = now + EVENT_LOOP_INTERVAL_MS
  }, EVENT_LOOP_INTERVAL_MS)
  sampleTimer = window.setInterval(sampleBrowserAndBridges, SAMPLE_WINDOW_MS)

  try {
    longTaskObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        longTaskCount += 1
        longTaskTotalMs += entry.duration
        longTaskMaxMs = Math.max(longTaskMaxMs, entry.duration)
        record('long_task', {
          name: entry.name,
          startTime: entry.startTime,
          durationMs: entry.duration,
        })
      }
    })
    longTaskObserver.observe({ entryTypes: ['longtask'] })
  } catch {
    longTaskObserver = null
  }
}

function stopDiagnostics() {
  if (!diagnosticsActive) return
  diagnosticsActive = false
  if (rafId !== null) cancelAnimationFrame(rafId)
  rafId = null
  if (sampleTimer !== null) window.clearInterval(sampleTimer)
  sampleTimer = null
  if (eventLoopTimer !== null) window.clearInterval(eventLoopTimer)
  eventLoopTimer = null
  longTaskObserver?.disconnect()
  longTaskObserver = null
  lastRafAt = 0
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

function messageData(message: MultiplayerMessage): DeepTraceData {
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
      movementState: message.state.movementState,
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

  trace.subscribe(snapshot => {
    if (snapshot.active) startDiagnostics()
    else stopDiagnostics()
  })

  document.addEventListener('visibilitychange', () => recordPageState('visibilitychange'))
  window.addEventListener('focus', () => recordPageState('focus'))
  window.addEventListener('blur', () => recordPageState('blur'))
  window.addEventListener('online', () => recordPageState('online'))
  window.addEventListener('offline', () => recordPageState('offline'))
  window.addEventListener('pagehide', () => recordPageState('pagehide'))
  window.addEventListener('pageshow', () => recordPageState('pageshow'))
  document.addEventListener('freeze', () => recordPageState('freeze'))
  document.addEventListener('resume', () => recordPageState('resume'))
  nav.connection?.addEventListener?.('change', () => recordPageState('connectionchange'))

  const originalAttachScreens = MelonDsBridge.prototype.attachScreens
  MelonDsBridge.prototype.attachScreens = function(top: HTMLCanvasElement, bottom: HTMLCanvasElement) {
    bridges.add(this)
    listenerWindows.set(this, { calls: 0, totalMs: 0, maxMs: 0 })
    const result = originalAttachScreens.call(this, top, bottom)
    record('emulator_lifecycle', { event: 'attach_screens', speed: this.getSpeedMultiplier() })
    return result
  }

  const originalDispose = MelonDsBridge.prototype.dispose
  MelonDsBridge.prototype.dispose = async function() {
    record('emulator_lifecycle', { event: 'dispose', speed: this.getSpeedMultiplier() })
    bridges.delete(this)
    bridgeWindows.delete(this)
    listenerWindows.delete(this)
    return originalDispose.call(this)
  }

  const originalStart = MelonDsBridge.prototype.start
  MelonDsBridge.prototype.start = async function() {
    record('emulator_lifecycle', { event: 'start_begin', speed: this.getSpeedMultiplier() })
    const started = performance.now()
    try {
      const result = await originalStart.call(this)
      record('emulator_lifecycle', { event: 'start_end', speed: this.getSpeedMultiplier(), durationMs: performance.now() - started })
      return result
    } catch (error) {
      record('emulator_lifecycle', { event: 'start_error', speed: this.getSpeedMultiplier(), durationMs: performance.now() - started, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  const originalPause = MelonDsBridge.prototype.pause
  MelonDsBridge.prototype.pause = async function() {
    record('emulator_lifecycle', { event: 'pause', speed: this.getSpeedMultiplier() })
    return originalPause.call(this)
  }

  const originalResume = MelonDsBridge.prototype.resume
  MelonDsBridge.prototype.resume = async function() {
    record('emulator_lifecycle', { event: 'resume', speed: this.getSpeedMultiplier() })
    return originalResume.call(this)
  }

  const originalReset = MelonDsBridge.prototype.reset
  MelonDsBridge.prototype.reset = async function() {
    record('emulator_lifecycle', { event: 'reset', speed: this.getSpeedMultiplier() })
    return originalReset.call(this)
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
        return listener()
      } finally {
        const durationMs = performance.now() - started
        const stats = listenerWindows.get(bridge) ?? { calls: 0, totalMs: 0, maxMs: 0 }
        stats.calls += 1
        stats.totalMs += durationMs
        stats.maxMs = Math.max(stats.maxMs, durationMs)
        listenerWindows.set(bridge, stats)
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
