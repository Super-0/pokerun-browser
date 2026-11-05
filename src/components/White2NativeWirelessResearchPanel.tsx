import { useEffect, useRef, useState } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2PartyStructureProbe } from '../multiplayer/games/White2PartyStructureProbe'
import { White2NativeRadioLink, type NativeRadioLinkStatus } from '../multiplayer/games/White2NativeRadioLink'
import { White2NativeFreezeWatch } from './White2NativeFreezeWatch'

// PRK79: active research panel. Historical PRK63-72 RF surveys remain in
// docs/source telemetry, rather than taking space in the invitation workflow.
type Snapshot = {
  at: number
  emulatedFrames: number
  radio: ReturnType<MelonDsBridge['getNativeWirelessDevLinkCounters']>
}
const delta = (after: number, before: number) => (after - before) >>> 0
const trackedKinds = [
  { id: 0, label: 'Beacons' },
  { id: 3, label: 'Authentication' },
  { id: 4, label: 'Association requests' },
  { id: 5, label: 'Association responses' },
  { id: 6, label: 'Deauthentication / disassociation' },
  { id: 8, label: 'Data' },
] as const

export function White2NativeWirelessResearchPanel({
  bridge, rom, roomCode, startId, localPlayerId, remotePlayerId, saveProfileId,
}: {
  bridge: MelonDsBridge | null
  rom: MultiplayerRomIdentity
  roomCode: string
  startId: string
  localPlayerId: string
  remotePlayerId: string | null
  saveProfileId: string | null
}) {
  const [radioStatus, setRadioStatus] = useState<NativeRadioLinkStatus | null>(null)
  const [radioError, setRadioError] = useState<string | null>(null)
  // PRK78 5ms was the first observed successful Union Room association.
  // Keep it enabled by default, but retain 50ms as a controlled comparison.
  const [fastRadioPoll, setFastRadioPoll] = useState(true)
  const [before, setBefore] = useState<Snapshot | null>(null)
  const [after, setAfter] = useState<Snapshot | null>(null)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const radioLink = useRef<White2NativeRadioLink | null>(null)

  useEffect(() => {
    setBefore(null)
    setAfter(null)
    setCaptureError(null)
    setRadioStatus(null)
    setRadioError(null)
  }, [bridge, rom.sha256, roomCode, startId, localPlayerId, remotePlayerId, saveProfileId])

  useEffect(() => () => {
    radioLink.current?.stop()
    radioLink.current = null
  }, [bridge, rom.sha256, roomCode, startId, localPlayerId, remotePlayerId, saveProfileId])

  if (!import.meta.env.DEV) return null
  const eligible = bridge?.status === 'running' && White2PartyStructureProbe.supportsRom(rom)
  const running = Boolean(radioLink.current && radioStatus?.phase !== 'stopped' && radioStatus?.phase !== 'error')
  const native = radioStatus?.native

  function startRadioLink() {
    if (!bridge || !eligible || !remotePlayerId || !saveProfileId) return
    if (radioLink.current) {
      if (running) return
      radioLink.current.stop()
      radioLink.current = null
    }
    try {
      setRadioError(null)
      const link = new White2NativeRadioLink(bridge, {
        roomCode, startId, localPlayerId, remotePlayerId,
        romSha256: rom.sha256, saveProfileId,
        pollIntervalMs: fastRadioPoll ? 5 : 50,
      }, setRadioStatus)
      radioLink.current = link
      link.start()
    } catch (reason) {
      radioLink.current?.stop()
      radioLink.current = null
      setRadioError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  function stopRadioLink() {
    radioLink.current?.stop()
    radioLink.current = null
  }

  function capture(kind: 'before' | 'after') {
    if (!bridge || !eligible) return
    try {
      const current: Snapshot = {
        at: Date.now(),
        emulatedFrames: bridge.getFrameStats().frames,
        radio: bridge.getNativeWirelessDevLinkCounters(),
      }
      setCaptureError(null)
      if (kind === 'before') {
        setBefore(current)
        setAfter(null)
        return
      }
      setAfter(current)
      if (!before) return
      const r = (key: keyof Snapshot['radio']) => {
        const a = current.radio[key]
        const b = before.radio[key]
        return typeof a === 'number' && typeof b === 'number' ? delta(a, b) : 0
      }
      const stages = trackedKinds.map(({ id, label }) => ({
        label,
        tx: delta(current.radio.handshakeStages[id].sent, before.radio.handshakeStages[id].sent),
        hardwareRx: delta(current.radio.handshakeStages[id].receivedByHardware,
          before.radio.handshakeStages[id].receivedByHardware),
      }))
      console.info('[PokéRun wireless] PRK80 INTERACTION TIMING DELTA', {
        elapsedMs: current.at - before.at,
        emulatedFrames: current.emulatedFrames - before.emulatedFrames,
        mpReplyHostPolls: r('mpReplyHostPolls'),
        mpRepliesTx: r('mpRepliesTx'),
        mpRepliesQueued: r('mpRepliesQueued'),
        mpReplyHostMatched: r('mpReplyHostMatched'),
        mpReplyStale: r('mpReplyStale'),
        mpReplyEmpty: r('mpReplyEmpty'),
        mpHostEmptyPoll: r('mpHostEmptyPoll'),
        mpHostMissPoll: r('mpHostMissPoll'),
        mpHostPendingMiss: r('mpHostPendingMiss'),
        mpHostFutureMatch: r('mpHostFutureMatch'),
        mpHostAckFail: r('mpHostAckFail'),
        mpHostAckOk: r('mpHostAckOk'),
        acceptedFrames: r('wifiAccepted'),
        badChannelFrames: r('wifiBadChannel'),
        nativeRxIrq: r('rxNativeRingIrq'),
        stages,
        note: 'These are local-DS counter deltas, not proof the game completed a trade or battle.',
      })
    } catch (reason) {
      setCaptureError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const d = before && after ? {
    ms: after.at - before.at,
    frames: after.emulatedFrames - before.emulatedFrames,
    txReplies: delta(after.radio.mpRepliesTx, before.radio.mpRepliesTx),
    queuedReplies: delta(after.radio.mpRepliesQueued, before.radio.mpRepliesQueued),
    replyPolls: delta(after.radio.mpReplyHostPolls, before.radio.mpReplyHostPolls),
    matchedReplies: delta(after.radio.mpReplyHostMatched, before.radio.mpReplyHostMatched),
    staleReplies: delta(after.radio.mpReplyStale, before.radio.mpReplyStale),
    emptyReplies: delta(after.radio.mpReplyEmpty, before.radio.mpReplyEmpty),
    mpHostEmptyPoll: delta(after.radio.mpHostEmptyPoll, before.radio.mpHostEmptyPoll),
    mpHostMissPoll: delta(after.radio.mpHostMissPoll, before.radio.mpHostMissPoll),
    mpHostPendingMiss: delta(after.radio.mpHostPendingMiss, before.radio.mpHostPendingMiss),
    mpHostFutureMatch: delta(after.radio.mpHostFutureMatch, before.radio.mpHostFutureMatch),
    mpHostAckFail: delta(after.radio.mpHostAckFail, before.radio.mpHostAckFail),
    mpHostAckOk: delta(after.radio.mpHostAckOk, before.radio.mpHostAckOk),
    badChannel: delta(after.radio.wifiBadChannel, before.radio.wifiBadChannel),
    stages: trackedKinds.map(({ id, label }) => ({
      label,
      tx: delta(after.radio.handshakeStages[id].sent, before.radio.handshakeStages[id].sent),
      rx: delta(after.radio.handshakeStages[id].receivedByHardware, before.radio.handshakeStages[id].receivedByHardware),
    })),
  } : null

  return <section className="multiplayer-session-debug pixel-border" style={{ padding: 12, marginBottom: 12 }}>
    <h2 style={{ fontSize: 16 }}>WHITE 2 • NATIVE MULTIPLAYER TEST</h2>
    <p style={{ fontSize: 12 }}>
      Goal: both players complete a real Union Room invitation without a
      communication error. Native player discovery already works. PRK75 radio
      isolation should remain active in both tabs. Use separate disposable
      saves, the same verified White 2 ROM, and two real melonDS instances.
    </p>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
      <button type="button" disabled={!eligible || !remotePlayerId || !saveProfileId || running}
        onClick={startRadioLink}>START LOCAL DS RADIO</button>
      <button type="button" disabled={!radioLink.current} onClick={stopRadioLink}>
        STOP & CLEAR RADIO QUEUES
      </button>
    </div>
    {!eligible && <p style={{ fontSize: 12 }}>Requires the running, verified White 2 ROM.</p>}
    {radioError && <p className="form-error" role="alert">{radioError}</p>}
    {radioStatus && <div role="status" style={{ fontSize: 12, display: 'grid', gap: 5 }}>
      <strong>{radioStatus.phase.toUpperCase()}
        {' '}• {radioStatus.pollIntervalMs} ms host poll
        {' '}• {native?.firmwareRoleApplied === 1 ? 'PLAYER 1' : native?.firmwareRoleApplied === 2 ? 'PLAYER 2' : 'ROLE UNKNOWN'}
      </strong>
      <p>Browser TX {radioStatus.framesSent} • RX {radioStatus.framesReceived}
        {' '}• rejected {radioStatus.framesRejected}
        {' '}• native queue drops {native?.dropped ?? 0}
      </p>
      {radioStatus.phase === 'linked' &&
        <p>The two browser tabs are linked. Native association and in-game
          interaction must still be verified separately.</p>}
      {radioStatus.reason && <p className="form-error">{radioStatus.reason}</p>}
      {native && <div style={{ borderTop: '1px solid #9bacb9', paddingTop: 8 }}>
        <strong>PRK79 • HOST REPLY DELIVERY (SINCE EMULATOR START)</strong>
        <p>Reply TX {native.mpRepliesTx} • host reply RX queued {native.mpRepliesQueued}
          {' '}• host polls {native.mpReplyHostPolls}
          {' '}• matched {native.mpReplyHostMatched}
          {' '}• stale {native.mpReplyStale}
          {' '}• empty {native.mpReplyEmpty}
        </p>
        <p><strong>PRK80 host timing:</strong> empty queue {native.mpHostEmptyPoll}
          {' '}• unmatched polls {native.mpHostMissPoll}
          {' '}• queued but unmatched {native.mpHostPendingMiss}
          {' '}• future timestamp matches {native.mpHostFutureMatch}
        </p>
        <p>Native ACKs: client failed {native.mpHostAckFail}
          {' '}• no client failure {native.mpHostAckOk}</p>
        <p style={{ opacity: 0.75 }}>
          A sent reply is not necessarily received by the host in time.
          Compare these values during invitation acceptance.
        </p>
      </div>}
    </div>}

    <div style={{ marginTop: 12, borderTop: '1px solid #9bacb9', paddingTop: 10 }}>
      <h3 style={{ fontSize: 14 }}>PRK80 • INTERACTION TIMING BEFORE / AFTER</h3>
      <p style={{ fontSize: 12 }}>
        Reach the native Union Room interaction menu, capture BEFORE on both
        tabs, choose Trade and press the first normal game confirmation.
        Capture AFTER if the game dialogue stalls. No guest memory changes.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" disabled={!eligible} onClick={() => capture('before')}>
          1. CAPTURE BEFORE
        </button>
        <button type="button" disabled={!eligible || !before} onClick={() => capture('after')}>
          2. CAPTURE AFTER
        </button>
      </div>
      {captureError && <p className="form-error" role="alert">{captureError}</p>}
      {before && !after && <p role="status" style={{ fontSize: 12 }}>
        Baseline ready. Attempt one invitation, then capture AFTER.
      </p>}
      {d && <div role="status" style={{ marginTop: 8, fontSize: 12 }}>
        <strong>PRK80 • INTERACTION TIMING RESULT</strong>
        <p>Window {(d.ms / 1000).toFixed(1)} s • DS frames +{d.frames}</p>
        <p>Reply TX +{d.txReplies} • host RX queued +{d.queuedReplies}
          {' '}• host polls +{d.replyPolls} • matched +{d.matchedReplies}
          {' '}• stale +{d.staleReplies} • empty +{d.emptyReplies}
          {' '}• wrong-channel +{d.badChannel}</p>
        <p>PRK80 host: empty queue +{d.mpHostEmptyPoll}
          {' '}• no reply match +{d.mpHostMissPoll}
          {' '}• queued but unmatched +{d.mpHostPendingMiss}
          {' '}• future timestamps +{d.mpHostFutureMatch}</p>
        <p>Native ACKs: client failed +{d.mpHostAckFail}
          {' '}• no client failure +{d.mpHostAckOk}</p>
        {d.stages.map(stage => <p key={stage.label} style={{ margin: '2px 0' }}>
          {stage.label}: TX +{stage.tx} • hardware RX +{stage.rx}
        </p>)}
        <p style={{ opacity: 0.75 }}>
          Report whether the invitation succeeded, then copy this result from each tab.
          Host reply matches are a transport diagnostic, not proof of an in-game trade.
        </p>
      </div>}
    </div>

    <details style={{ marginTop: 12 }}>
      <summary style={{ cursor: 'pointer', fontWeight: 700 }}>
        ADVANCED • RADIO SETTINGS AND CONNECTION COUNTERS
      </summary>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 10 }}>
        <input type="checkbox" checked={fastRadioPoll} disabled={running}
          onChange={event => setFastRadioPoll(event.target.checked)}/>
        PRK78 low-latency 5 ms host poll (uncheck for 50 ms comparison)
      </label>
      <p style={{ fontSize: 11, opacity: 0.75 }}>
        Leave 5 ms enabled for the currently working discovery configuration.
        Stop the link on both tabs before changing modes. Browser timer
        scheduling can still vary.
      </p>
      {native && <div style={{ fontSize: 12 }}>
        <p>Wi-Fi accepted {native.wifiAccepted} • wrong channel {native.wifiBadChannel}
          {' '}• MP-filtered {native.wifiMpFiltered}
          {' '}• association responses accepted {native.wifiAssociationAccepted}
          {' '}• native RX IRQ {native.rxNativeRingIrq}
        </p>
        {trackedKinds.map(({ id, label }) => <p key={id} style={{ margin: '2px 0' }}>
          {label}: TX {native.handshakeStages[id].sent}
          {' '}• hardware RX {native.handshakeStages[id].receivedByHardware}
        </p>)}
      </div>}
      <White2NativeFreezeWatch bridge={bridge}/>
    </details>
  </section>
}
