import { useEffect, useMemo, useState } from 'react'
import {
  multiplayerMovementTrace,
  type MultiplayerMovementTraceSnapshot,
  type TraceNumberStats,
} from './MultiplayerMovementTrace'

function formatNumber(value: number | null, digits = 2) {
  return value === null || !Number.isFinite(value) ? '—' : value.toFixed(digits)
}

function compactStats(stats: TraceNumberStats, suffix = ' ms') {
  if (!stats.count) return '—'
  return `MED ${formatNumber(stats.median)}${suffix} • P95 ${formatNumber(stats.p95)}${suffix} • MAX ${formatNumber(stats.max)}${suffix}`
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  document.execCommand('copy')
  area.remove()
}

export function MultiplayerMovementTracePanel({ player }: { player: 1 | 2 }) {
  const [snapshot, setSnapshot] = useState<MultiplayerMovementTraceSnapshot>(() => multiplayerMovementTrace.snapshot())
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    multiplayerMovementTrace.setTabLabel(`PLAYER ${player}`)
    const unsubscribe = multiplayerMovementTrace.subscribe(setSnapshot)
    return () => { unsubscribe() }
  }, [player])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(timer)
  }, [])

  const summary = useMemo(() => multiplayerMovementTrace.summary(), [snapshot.eventCount, snapshot.active, snapshot.traceId])
  const remaining = snapshot.active && snapshot.endsAt ? Math.max(0, snapshot.endsAt - now) : 0
  const remoteOnlyCount = Object.values(summary.remoteOnlyProfiles).reduce((sum, count) => sum + count, 0)

  async function copyTrace() {
    await copyText(multiplayerMovementTrace.exportJson())
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return <aside style={{
    position: 'fixed',
    right: 12,
    bottom: 12,
    zIndex: 10000,
    width: 'min(390px, calc(100vw - 24px))',
    maxHeight: '54vh',
    overflow: 'auto',
    background: 'rgba(244, 249, 252, 0.97)',
    border: '3px solid #35546b',
    boxShadow: '6px 6px 0 rgba(53, 84, 107, 0.28)',
    padding: 12,
    fontFamily: 'inherit',
    color: '#243f54',
  }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
      <strong>MULTIPLAYER TRACE • P{player}</strong>
      <span style={{ fontSize: 12 }}>{snapshot.active ? `${(remaining / 1000).toFixed(1)}s` : 'IDLE'}</span>
    </div>

    <p style={{ margin: '8px 0', fontSize: 12, lineHeight: 1.4 }}>
      Use one speed per trace. Walk normally for 10 seconds. Starting here starts the same trace in both tabs.
    </p>

    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      <button className="pixel-button" disabled={snapshot.active} onClick={() => multiplayerMovementTrace.start(10000)}>START 10s TRACE</button>
      <button className="pixel-button ghost" disabled={!snapshot.active} onClick={() => multiplayerMovementTrace.stop()}>STOP</button>
      <button className="pixel-button ghost" disabled={!snapshot.active} onClick={() => multiplayerMovementTrace.mark('VISUAL GLITCH')}>MARK NOW</button>
      <button className="pixel-button ghost" disabled={!snapshot.eventCount} onClick={() => void copyTrace()}>{copied ? 'COPIED' : 'COPY JSON'}</button>
      <button className="pixel-button ghost" disabled={snapshot.active || !snapshot.eventCount} onClick={() => multiplayerMovementTrace.clear()}>CLEAR</button>
    </div>

    <div style={{ marginTop: 10, fontSize: 11, lineHeight: 1.55 }}>
      <div><b>EVENTS</b> {snapshot.eventCount} • <b>TABS</b> {summary.tabs.join(', ') || '—'}</div>
      <div><b>SPEED SAMPLES</b> {Object.entries(summary.speedCounts).map(([speed, count]) => `${speed}:${count}`).join(' • ') || '—'}</div>
      <div><b>LOCAL READ</b> {compactStats(summary.localSampleIntervalMs)}</div>
      <div><b>PUBLISH</b> {compactStats(summary.publishIntervalMs)}</div>
      <div><b>RECEIVE</b> {compactStats(summary.receiveIntervalMs)}</div>
      <div><b>PACKET AGE</b> {compactStats(summary.packetAgeMs)}</div>
      <div><b>RENDER ERROR</b> {compactStats(summary.renderErrorTiles, ' tiles')}</div>
      <div><b>TRACE OVERHEAD</b> {compactStats(summary.sampleOverheadMs)}</div>
      <div><b>SEQUENCE GAPS</b> {summary.sequenceGaps}</div>
      <div><b>PROFILE CHANGES</b> LOCAL {summary.localProfileChanges} • REMOTE {summary.remoteProfileChanges}</div>
      <div><b>REMOTE-ONLY PROFILE SAMPLES</b> {remoteOnlyCount}</div>
    </div>
  </aside>
}
