import { useEffect, useRef, useState } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import {
  MANUAL_TRADE_INPUT_EVENT,
  MANUAL_TRADE_RUNTIME_ERROR_EVENT,
  type ManualTradeInputDetail,
  type ManualTradeRuntimeErrorDetail,
} from './manualTradeDiagnosticEvents'

type Props = {
  bridge: MelonDsBridge | null
  playerRole: 1 | 2
}

type Sample = {
  at: number
  fps: number
  focused: boolean
  visible: boolean
  frames: number
  workerRadio: boolean
  firmwareRole: number
  radio: ReturnType<MelonDsBridge['getNativeWirelessDevLinkCounters']>
}

type DiagnosticEvent =
  | ({ kind: 'input' } & ManualTradeInputDetail)
  | ({ kind: 'runtime-error' } & ManualTradeRuntimeErrorDetail)

const MAX_EVENTS = 100

function downloadJson(value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `pokerun-white2-trade-diagnostic-p${Date.now()}.json`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ManualTradeDiagnostic({ bridge, playerRole }: Props) {
  const [samples, setSamples] = useState<Sample[]>([])
  const [events, setEvents] = useState<DiagnosticEvent[]>([])
  const [message, setMessage] = useState('READY')
  const sampleRef = useRef<Sample | null>(null)
  const samplesRef = useRef<Sample[]>([])
  const eventsRef = useRef<DiagnosticEvent[]>([])

  useEffect(() => {
    samplesRef.current = samples
  }, [samples])
  useEffect(() => {
    eventsRef.current = events
  }, [events])

  useEffect(() => {
    const appendEvent = (event: DiagnosticEvent) => {
      const next = [...eventsRef.current, event].slice(-MAX_EVENTS)
      eventsRef.current = next
      setEvents(next)
    }
    const onInput = (event: Event) => {
      const detail = (event as CustomEvent<ManualTradeInputDetail>).detail
      if (detail) appendEvent({ kind: 'input', ...detail })
    }
    const onRuntimeError = (event: Event) => {
      const detail = (event as CustomEvent<ManualTradeRuntimeErrorDetail>).detail
      if (detail) appendEvent({ kind: 'runtime-error', ...detail })
    }
    const onWindowError = (event: ErrorEvent) => appendEvent({
      kind: 'runtime-error', source: 'window-error',
      message: event.message || 'Window error', at: performance.now(),
    })
    const onUnhandledRejection = (event: PromiseRejectionEvent) => appendEvent({
      kind: 'runtime-error', source: 'unhandled-rejection',
      message: event.reason instanceof Error ? event.reason.message : String(event.reason),
      at: performance.now(),
    })
    window.addEventListener(MANUAL_TRADE_INPUT_EVENT, onInput)
    window.addEventListener(MANUAL_TRADE_RUNTIME_ERROR_EVENT, onRuntimeError)
    window.addEventListener('error', onWindowError)
    window.addEventListener('unhandledrejection', onUnhandledRejection)
    return () => {
      window.removeEventListener(MANUAL_TRADE_INPUT_EVENT, onInput)
      window.removeEventListener(MANUAL_TRADE_RUNTIME_ERROR_EVENT, onRuntimeError)
      window.removeEventListener('error', onWindowError)
      window.removeEventListener('unhandledrejection', onUnhandledRejection)
    }
  }, [])

  useEffect(() => {
    sampleRef.current = null
    samplesRef.current = []
    setSamples([])
    const timer = window.setInterval(() => {
      if (!bridge || bridge.status !== 'running') return
      const now = performance.now()
      const stats = bridge.getFrameStats()
      const previous = sampleRef.current
      const sample: Sample = {
        at: now,
        fps: previous ? (stats.frames - previous.frames) * 1000 / Math.max(1, now - previous.at) : 0,
        focused: document.hasFocus(),
        visible: document.visibilityState === 'visible',
        frames: stats.frames,
        workerRadio: bridge.getRuntimeDiagnostics().workerRadio,
        firmwareRole: bridge.getNativeWirelessDevLinkCounters().firmwareRoleApplied,
        radio: bridge.getNativeWirelessDevLinkCounters(),
      }
      sampleRef.current = sample
      const next = [...samplesRef.current, sample].slice(-120)
      samplesRef.current = next
      setSamples(next)
    }, 500)
    return () => window.clearInterval(timer)
  }, [bridge])

  function capture() {
    if (!bridge) {
      setMessage('NO EMULATOR')
      return
    }
    const query = new URLSearchParams(window.location.search)
    const payload = {
      schema: 1,
      capturedAt: new Date().toISOString(),
      page: {
        urlPath: window.location.pathname,
        legacyHarness: query.has('player') || query.get('fake') === '1',
        playerRole,
        crossOriginIsolated,
      },
      runtime: bridge.getRuntimeDiagnostics(),
      samples: samplesRef.current,
      events: eventsRef.current,
    }
    downloadJson(payload)
    setMessage(`DOWNLOADED ${samplesRef.current.length} SAMPLES / ${eventsRef.current.length} EVENTS`)
  }

  async function copySummary() {
    const latest = samplesRef.current.at(-1)
    if (!latest) {
      setMessage('WAITING FOR RUNTIME SAMPLE')
      return
    }
    const summary = [
      `P${playerRole} ${Math.round(latest.fps)} DS FPS`,
      `worker=${latest.workerRadio ? 'on' : 'off'}`,
      `firmwareRole=${latest.firmwareRole}`,
      `radioTX=${latest.radio.outgoingEnqueued}`,
      `radioRX=${latest.radio.incomingConsumed}`,
      `replyTX=${latest.radio.mpRepliesTx}`,
      `replyQueued=${latest.radio.mpRepliesQueued}`,
      `polls=${latest.radio.mpReplyHostPolls}`,
      `matched=${latest.radio.mpReplyHostMatched}`,
      `ackOk=${latest.radio.mpHostAckOk}`,
      `ackFail=${latest.radio.mpHostAckFail}`,
      `events=${eventsRef.current.length}`,
    ].join(' ')
    try {
      await navigator.clipboard.writeText(summary)
      setMessage('SUMMARY COPIED')
    } catch (error) {
      setMessage(error instanceof Error ? `COPY FAILED: ${error.message}` : 'COPY FAILED')
    }
  }

  const latest = samples.at(-1)
  return <section className="multiplayer-session-debug pixel-border" aria-label={`Manual trade diagnostic player ${playerRole}`}>
    <h2>MANUAL TRADE DIAGNOSTIC • P{playerRole}</h2>
    <p>Capture after Player 1 offers and Player 2 cannot choose. This records scalars and input/error events only; it does not read ROM or save data.</p>
    <p role="status">
      {latest ? `${Math.round(latest.fps)} DS FPS • ${latest.focused ? 'FOCUSED' : 'UNFOCUSED'} • ${latest.visible ? 'VISIBLE' : 'HIDDEN'} • WORKER ${latest.workerRadio ? 'ON' : 'OFF'} • FIRMWARE ROLE ${latest.firmwareRole} • ${message}` : message}
    </p>
    {latest && <p>
      TX {latest.radio.outgoingEnqueued} • RX {latest.radio.incomingConsumed} •
      reply TX {latest.radio.mpRepliesTx} • queued {latest.radio.mpRepliesQueued} •
      polls {latest.radio.mpReplyHostPolls} • matched {latest.radio.mpReplyHostMatched} •
      ACK OK {latest.radio.mpHostAckOk} • ACK FAIL {latest.radio.mpHostAckFail} •
      input/error events {events.length}
    </p>}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button type="button" onClick={capture}>DOWNLOAD DIAGNOSTIC JSON</button>
      <button type="button" onClick={() => void copySummary()}>COPY SUMMARY</button>
    </div>
  </section>
}
