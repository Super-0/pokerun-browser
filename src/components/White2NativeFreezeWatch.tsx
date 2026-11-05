import { useEffect, useRef, useState } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'

// PRK77: read-only, low-frequency diagnostics. No guest memory calls,
// emulator writes, radio packet capture, or artificial scheduling changes.
type Sample = {
  at: number
  frames: number
  raf: number
  batches: number
  processMs: number
  txBeacons: number
  rxBeacons: number
  bridgeStatus: string
  visibility: DocumentVisibilityState
  speed: number
}
type WindowSample = {
  elapsedMs: number
  frames: number
  raf: number
  batches: number
  processMs: number
  txBeacons: number
  rxBeacons: number
  bridgeStatus: string
  visibility: DocumentVisibilityState
  speed: number
  observedAt: number
}
type Check = { phase: 'running' | 'finished'; result?: WindowSample }

function readSample(bridge: MelonDsBridge): Sample {
  const stats = bridge.getFrameStats()
  const canReadRadio = bridge.status === 'running'
  const radio = canReadRadio ? bridge.getNativeWirelessDevLinkCounters() : null
  return {
    at: performance.now(),
    frames: stats.frames,
    raf: stats.rafCallbacks,
    batches: stats.batches,
    processMs: stats.processMs,
    txBeacons: radio?.handshakeStages[0]?.sent ?? 0,
    rxBeacons: radio?.handshakeStages[0]?.receivedByHardware ?? 0,
    bridgeStatus: bridge.status,
    visibility: document.visibilityState,
    speed: bridge.getSpeedMultiplier(),
  }
}

function difference(before: Sample, after: Sample): WindowSample {
  return {
    elapsedMs: Math.max(0, after.at - before.at),
    frames: Math.max(0, after.frames - before.frames),
    raf: Math.max(0, after.raf - before.raf),
    batches: Math.max(0, after.batches - before.batches),
    processMs: Math.max(0, after.processMs - before.processMs),
    txBeacons: Math.max(0, after.txBeacons - before.txBeacons),
    rxBeacons: Math.max(0, after.rxBeacons - before.rxBeacons),
    bridgeStatus: after.bridgeStatus,
    visibility: after.visibility,
    speed: after.speed,
    observedAt: Date.now(),
  }
}

function rate(count: number, elapsedMs: number) {
  return elapsedMs > 0 ? (count * 1000 / elapsedMs).toFixed(1) : '0.0'
}

function classification(window: WindowSample) {
  if (window.bridgeStatus !== 'running') return 'EMULATOR NOT RUNNING'
  if (window.frames === 0 && window.raf === 0) {
    return window.visibility === 'hidden'
      ? 'BACKGROUND TAB: NO EMULATOR CALLBACKS'
      : 'VISIBLE TAB: FRAME CALLBACKS STOPPED'
  }
  if (window.frames === 0) return 'RAF ACTIVE, BUT NO DS FRAMES PROCESSED'
  if (window.visibility === 'hidden') return 'BACKGROUND TAB: FRAME RATE MAY BE THROTTLED'
  if (window.frames * 1000 / Math.max(1, window.elapsedMs) < 25)
    return 'VISIBLE TAB: EMULATION RUNNING VERY SLOWLY'
  return 'EMULATED FRAMES ADVANCING (GAME PROGRESS NOT PROVEN)'
}

export function White2NativeFreezeWatch({ bridge }: { bridge: MelonDsBridge | null }) {
  const [recent, setRecent] = useState<WindowSample | null>(null)
  const [check, setCheck] = useState<Check | null>(null)
  const [error, setError] = useState<string | null>(null)
  const history = useRef<WindowSample[]>([])
  const lastAlert = useRef('')
  const checkTimer = useRef<number | null>(null)

  useEffect(() => {
    history.current = []
    lastAlert.current = ''
    setRecent(null)
    setCheck(null)
    setError(null)
    if (!bridge) return

    let previous: Sample | null = null
    try { previous = readSample(bridge) } catch { /* emulator not ready */ }
    const timer = window.setInterval(() => {
      try {
        const current = readSample(bridge)
        if (previous) {
          const result = difference(previous, current)
          setRecent(result)
          history.current = [...history.current, result].slice(-8)
          const state = classification(result)
          const alert = state.startsWith('EMULATED FRAMES') ? '' : state
          // One diagnostic per distinct degraded condition, not every tick.
          if (alert && alert !== lastAlert.current) {
            console.info('[PokéRun wireless] PRK77 FRAME WATCH CONDITION', {
              condition: alert,
              ...result,
              note: 'A running emulator is not proof the White 2 game progressed. Check input and visible game changes.',
            })
          }
          lastAlert.current = alert
        }
        previous = current
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    }, 2000)
    return () => {
      window.clearInterval(timer)
      if (checkTimer.current !== null) {
        window.clearTimeout(checkTimer.current)
        checkTimer.current = null
      }
    }
  }, [bridge])

  function checkFrozen() {
    if (!bridge || check?.phase === 'running') return
    try {
      const first = readSample(bridge)
      setError(null)
      setCheck({ phase: 'running' })
      checkTimer.current = window.setTimeout(() => {
        checkTimer.current = null
        try {
          const result = difference(first, readSample(bridge))
          setCheck({ phase: 'finished', result })
          console.info('[PokéRun wireless] PRK77 FIVE SECOND FREEZE CHECK', {
            condition: classification(result),
            ...result,
            recentWindows: history.current.slice(-6),
            note: 'Read-only host and emulator counters; if frames advanced, an in-game wait/softlock is still possible.',
          })
        } catch (reason) {
          setCheck(null)
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      }, 5000)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #9bacb9' }}>
    <h3 style={{ fontSize: 14 }}>PRK77 • P2 FREEZE / EMULATOR LIVENESS WATCH</h3>
    <p style={{ fontSize: 12 }}>
      Monitors actual emulated-frame progress every two seconds. If the DS game
      appears frozen, press CHECK FREEZE NOW in that player's own tab.
      Leave the affected tab visible for the five-second check. It does not
      alter radio packets, gameplay, speed, or saved data.
    </p>
    {recent && <div style={{ fontSize: 12, display: 'grid', gap: 4 }}>
      <strong>{classification(recent)}</strong>
      <p>Last interval {(recent.elapsedMs / 1000).toFixed(1)} s:
        {' '}DS frames +{recent.frames} ({rate(recent.frames, recent.elapsedMs)} FPS)
        {' '}• browser RAF +{recent.raf} ({rate(recent.raf, recent.elapsedMs)}/s)
        {' '}• batches +{recent.batches}
      </p>
      <p>melonDS processing time {(recent.processMs / 1000).toFixed(2)} s
        {' '}• emitted beacons +{recent.txBeacons}
        {' '}• received beacon IRQ +{recent.rxBeacons}
        {' '}• tab {recent.visibility.toUpperCase()}
        {' '}• bridge {recent.bridgeStatus.toUpperCase()}
        {' '}• speed {recent.speed}×
      </p>
    </div>}
    <button type="button" disabled={!bridge || check?.phase === 'running'}
      onClick={checkFrozen}>
      {check?.phase === 'running' ? 'CHECKING EMULATOR...' : 'CHECK FREEZE NOW (5 SECONDS)'}
    </button>
    {check?.phase === 'finished' && check.result && <div role="status"
      style={{ fontSize: 12, marginTop: 8, display: 'grid', gap: 3 }}>
      <strong>FREEZE CHECK: {classification(check.result)}</strong>
      <p>Actual elapsed {(check.result.elapsedMs / 1000).toFixed(1)} s
        {' '}• DS frames +{check.result.frames} ({rate(check.result.frames, check.result.elapsedMs)} FPS)
        {' '}• browser RAF +{check.result.raf}
        {' '}• beacons TX +{check.result.txBeacons}
        {' '}• hardware RX +{check.result.rxBeacons}
        {' '}• tab {check.result.visibility}
      </p>
      <p>Full six-window history was written to the in-app development console
        as PRK77 FIVE SECOND FREEZE CHECK. Copy that entry from the frozen player's tab.</p>
    </div>}
    {error && <p role="alert" className="form-error">{error}</p>}
    <p style={{ fontSize: 11, opacity: 0.8 }}>
      Frames advancing means the emulator continues executing, not necessarily
      that the game responds to input. Zero frames in a visible, responsive tab
      suggests the frame scheduler stopped. A fully blocked browser tab cannot
      execute this watchdog; browser visibility and timer delays are reported.
    </p>
  </div>
}
