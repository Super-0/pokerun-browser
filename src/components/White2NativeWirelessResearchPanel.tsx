import { useEffect, useRef, useState } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2PartyStructureProbe } from '../multiplayer/games/White2PartyStructureProbe'
import { White2NativeRadioLink, type NativeRadioLinkStatus } from '../multiplayer/games/White2NativeRadioLink'
import { White2NativeFreezeWatch } from './White2NativeFreezeWatch'

// PRK72 frame-control subtype labels. Matches native 11-kind classifier.
const handshakeStageLabels = [
  'Beacons', 'Probe requests', 'Probe responses', 'Authentication',
  'Association/reassociation requests', 'Association/reassociation responses',
  'Deauth/disassociation', 'Other management', 'Data', 'Control',
  'Reserved/unknown',
] as const

// PRK63: one-emulator feasibility experiment. These are counters in the
// pinned WASM Wi-Fi callbacks, NOT evidence of a connected second DS.
// No emulated button presses, guest memory writes, packet payloads or sends.
type Counters = ReturnType<MelonDsBridge['getNativeWirelessProbeCounters']>
type Capture = { capturedAt: number; counters: Counters }
// PRK76: compare radio activity during a precisely bounded game action.
// This is entirely read-only and does not access packet contents or game saves.
type RadioCounters = ReturnType<MelonDsBridge['getNativeWirelessDevLinkCounters']>
type RadioSample = {
  capturedAt: number
  emulatedFrames: number
  probe: Counters
  radio: RadioCounters
}
function counterDelta(after: number, before: number) {
  return (after - before) >>> 0
}

// PRK69: all counters are per-emulator aggregates. Channel 0 = unknown/invalid.
type RadioChannel = {
  channel: number
  tx: number
  accepted: number
  rejected: number
  tuned: number
}
function formatChannelCounts(channels: RadioChannel[], field: 'tx' | 'accepted' | 'rejected' | 'tuned') {
  return channels
    .filter(row => row[field] > 0)
    .map(row => `ch${row.channel || '?'}: ${row[field]}`)
    .join(' • ') || 'none'
}

const rows: { key: keyof Counters; label: string; note: string }[] = [
  { key: 'wifiStarts', label: 'WI-FI POWER ON', note: 'Native Wi-Fi hardware session started' },
  { key: 'wifiStops', label: 'WI-FI POWER OFF', note: 'Native Wi-Fi hardware session ended' },
  { key: 'mpTxAttempts', label: 'LOCAL TX ATTEMPTS', note: 'MP packets, commands, replies or acknowledgements attempted' },
  { key: 'mpRxPolls', label: 'LOCAL RX POLLS', note: 'Radio queried for incoming ordinary packets' },
  { key: 'mpHostRxPolls', label: 'HOST/REPLY RX POLLS', note: 'Host frames or multiplayer replies requested' },
  { key: 'netTxAttempts', label: 'NET TX ATTEMPTS', note: 'NetPlay-level packet send attempts' },
  // PRK65: the native code only reads the frame-control byte from the host
  // radio buffer and keeps aggregate totals. No addresses or payloads.
  { key: 'txManagement', label: '802.11 MANAGEMENT FRAMES', note: 'Management category, includes beacons/probes' },
  { key: 'txControl', label: '802.11 CONTROL FRAMES', note: 'Control category' },
  { key: 'txData', label: '802.11 DATA FRAMES', note: 'Data category; does not identify trade contents' },
  { key: 'txBeacons', label: 'BEACONS (MANAGEMENT)', note: 'Subtype 8, included in management count' },
  { key: 'txProbes', label: 'PROBE REQUESTS/RESPONSES', note: 'Subtypes 4/5, included in management count' },
  { key: 'txMpCommands', label: 'MP COMMAND SENDS', note: 'Attempts to send native multi-player commands' },
  { key: 'txMpReplies', label: 'MP REPLY SENDS', note: 'Includes empty default replies from native Wi-Fi engine' },
  { key: 'txMpAcks', label: 'MP ACK SENDS', note: 'Attempts to send native multi-player acknowledgments' },
  { key: 'txEmptyOrInvalid', label: 'EMPTY/INVALID TX BUFFERS', note: 'Includes zero-length reply requests; not necessarily an error' },
]

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
  const [baseline, setBaseline] = useState<Capture | null>(null)
  const [after, setAfter] = useState<Capture | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [radioStatus, setRadioStatus] = useState<NativeRadioLinkStatus | null>(null)
  const [radioError, setRadioError] = useState<string | null>(null)
  const [radioBefore, setRadioBefore] = useState<RadioSample | null>(null)
  const [radioAfter, setRadioAfter] = useState<RadioSample | null>(null)
  const [radioCaptureError, setRadioCaptureError] = useState<string | null>(null)
  const radioLink = useRef<White2NativeRadioLink | null>(null)
  useEffect(() => {
    setBaseline(null)
    setAfter(null)
    setError(null)
    setRadioBefore(null)
    setRadioAfter(null)
    setRadioCaptureError(null)
  }, [bridge, rom.sha256])

  useEffect(() => () => {
    radioLink.current?.stop()
    radioLink.current = null
  }, [bridge, rom.sha256, roomCode, startId, localPlayerId, remotePlayerId, saveProfileId])

  if (!import.meta.env.DEV) return null

  const eligible = bridge?.status === 'running' && White2PartyStructureProbe.supportsRom(rom)

  function startRadioLink() {
    if (!bridge || !eligible || !remotePlayerId || !rom.sha256 || !saveProfileId) return
    if (radioLink.current) {
      if (radioStatus?.phase !== 'stopped' && radioStatus?.phase !== 'error') return
      radioLink.current.stop()
      radioLink.current = null
    }
    try {
      setRadioError(null)
      const link = new White2NativeRadioLink(bridge, {
        roomCode, startId, localPlayerId, remotePlayerId,
        romSha256: rom.sha256, saveProfileId,
      }, setRadioStatus)
      radioLink.current = link
      link.start()
    } catch (error) {
      radioLink.current?.stop()
      radioLink.current = null
      setRadioError(error instanceof Error ? error.message : String(error))
    }
  }
  function stopRadioLink() {
    radioLink.current?.stop()
    radioLink.current = null
  }

  function capture(kind: 'baseline' | 'after') {
    if (!eligible || !bridge) return
    try {
      const counters = bridge.getNativeWirelessProbeCounters()
      const snapshot = { capturedAt: Date.now(), counters }
      setError(null)
      if (kind === 'baseline') {
        setBaseline(snapshot)
        setAfter(null)
      } else {
        setAfter(snapshot)
      }
      const delta = baseline && kind === 'after'
        ? Object.fromEntries(rows.map(row => [row.key,
          (counters[row.key] - baseline.counters[row.key]) >>> 0]))
        : null
      console.info('[PokéRun wireless] PRK63 NATIVE WIRELESS TELEMETRY', {
        kind,
        counters,
        delta,
        guestWrites: 0,
        transportedPackets: 0,
        note: 'WASM callback counters only; PRK66, if enabled separately, handles packet transport.',
      })
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      console.info('[PokéRun wireless] PRK63 TELEMETRY BLOCKED', { reason: message })
    }
  }

  function captureRadio(kind: 'before' | 'after') {
    if (!bridge || !eligible) return
    try {
      const sample: RadioSample = {
        capturedAt: Date.now(),
        emulatedFrames: bridge.getFrameStats().frames,
        probe: bridge.getNativeWirelessProbeCounters(),
        radio: bridge.getNativeWirelessDevLinkCounters(),
      }
      setRadioCaptureError(null)
      if (kind === 'before') {
        setRadioBefore(sample)
        setRadioAfter(null)
      } else {
        setRadioAfter(sample)
        if (radioBefore) {
          const stages = sample.radio.handshakeStages.map((stage, i) => ({
            kind: handshakeStageLabels[i] ?? 'Unknown',
            tx: counterDelta(stage.sent, radioBefore.radio.handshakeStages[i].sent),
            hardwareRx: counterDelta(stage.receivedByHardware, radioBefore.radio.handshakeStages[i].receivedByHardware),
          }))
          console.info('[PokéRun wireless] PRK76 CONTROLLED RADIO DELTA', {
            elapsedMs: sample.capturedAt - radioBefore.capturedAt,
            emulatedFrames: sample.emulatedFrames - radioBefore.emulatedFrames,
            wifiPowerOns: counterDelta(sample.probe.wifiStarts, radioBefore.probe.wifiStarts),
            wifiPowerOffs: counterDelta(sample.probe.wifiStops, radioBefore.probe.wifiStops),
            mpTxAttempts: counterDelta(sample.probe.mpTxAttempts, radioBefore.probe.mpTxAttempts),
            mpCommands: counterDelta(sample.probe.txMpCommands, radioBefore.probe.txMpCommands),
            mpReplies: counterDelta(sample.probe.txMpReplies, radioBefore.probe.txMpReplies),
            mpAcks: counterDelta(sample.probe.txMpAcks, radioBefore.probe.txMpAcks),
            incomingEnqueued: counterDelta(sample.radio.incomingEnqueued, radioBefore.radio.incomingEnqueued),
            incomingConsumed: counterDelta(sample.radio.incomingConsumed, radioBefore.radio.incomingConsumed),
            wifiAccepted: counterDelta(sample.radio.wifiAccepted, radioBefore.radio.wifiAccepted),
            wrongChannel: counterDelta(sample.radio.wifiBadChannel, radioBefore.radio.wifiBadChannel),
            hardwareRxIrqs: counterDelta(sample.radio.rxNativeRingIrq, radioBefore.radio.rxNativeRingIrq),
            stages,
            note: 'Two snapshots from this DS only; no packet content, channel forcing, game memory writes or save edits.',
          })
        }
      }
    } catch (reason) {
      setRadioCaptureError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const radioDelta = radioBefore && radioAfter ? {
    elapsedMs: radioAfter.capturedAt - radioBefore.capturedAt,
    emulatedFrames: radioAfter.emulatedFrames - radioBefore.emulatedFrames,
    wifiStarts: counterDelta(radioAfter.probe.wifiStarts, radioBefore.probe.wifiStarts),
    wifiStops: counterDelta(radioAfter.probe.wifiStops, radioBefore.probe.wifiStops),
    mpTxAttempts: counterDelta(radioAfter.probe.mpTxAttempts, radioBefore.probe.mpTxAttempts),
    mpCommands: counterDelta(radioAfter.probe.txMpCommands, radioBefore.probe.txMpCommands),
    mpReplies: counterDelta(radioAfter.probe.txMpReplies, radioBefore.probe.txMpReplies),
    mpAcks: counterDelta(radioAfter.probe.txMpAcks, radioBefore.probe.txMpAcks),
    rxQueue: counterDelta(radioAfter.radio.incomingEnqueued, radioBefore.radio.incomingEnqueued),
    rxConsumed: counterDelta(radioAfter.radio.incomingConsumed, radioBefore.radio.incomingConsumed),
    rxAccepted: counterDelta(radioAfter.radio.wifiAccepted, radioBefore.radio.wifiAccepted),
    wrongChannel: counterDelta(radioAfter.radio.wifiBadChannel, radioBefore.radio.wifiBadChannel),
    rxIrq: counterDelta(radioAfter.radio.rxNativeRingIrq, radioBefore.radio.rxNativeRingIrq),
    stages: radioAfter.radio.handshakeStages.map((stage, i) => ({
      kind: stage.kind,
      tx: counterDelta(stage.sent, radioBefore.radio.handshakeStages[i].sent),
      rx: counterDelta(stage.receivedByHardware, radioBefore.radio.handshakeStages[i].receivedByHardware),
    })),
  } : null

  const changes = baseline && after
    ? rows.map(row => ({
      ...row,
      delta: (after.counters[row.key] - baseline.counters[row.key]) >>> 0,
    }))
    : []
  const byKey = Object.fromEntries(changes.map(item => [item.key, item.delta]))
  const classified = (byKey.txManagement ?? 0) + (byKey.txControl ?? 0) +
    (byKey.txData ?? 0) + (byKey.txEmptyOrInvalid ?? 0)
  const attempted = byKey.mpTxAttempts ?? 0
  const classesMatch = changes.length > 0 && classified === attempted
  return <section className="multiplayer-session-debug pixel-border" style={{ padding: 12 }}>
    <details>
      <summary style={{ cursor: 'pointer', fontWeight: 800 }}>
        PRK63/65 • NATIVE WIRELESS & FRAME TYPES (READ ONLY)
      </summary>
      <p style={{ marginTop: 10, fontSize: 12 }}>
        Observe when the real White 2 game calls the emulator's Wi-Fi hooks.
        This does not connect a second DS or initiate a native trade.
        Our simulated trainer uses a separate PokeRun protocol.
        PRK65 groups outgoing 802.11 frames by type and subtype without
        capturing MAC addresses, trainer identifiers, or packet payloads.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" disabled={!eligible} onClick={() => capture('baseline')}>
          1. CAPTURE BASELINE
        </button>
        <button type="button" disabled={!eligible || !baseline} onClick={() => capture('after')}>
          2. CAPTURE AFTER GAME ACTION
        </button>
      </div>
      {!eligible && <p style={{ fontSize: 11 }}>
        Requires the exact tested White 2 ROM with the emulator running.
      </p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <p style={{ fontSize: 11 }}>
        Between captures, use White 2's normal menus. With C-Gear already
        enabled, turn its wireless power off/on or open its Wireless panel.
        Union Room is optional for this early diagnostic. Do not edit saves
        or enter unsupported game functions.
      </p>
      {baseline && <p style={{ fontSize: 11 }}>
        Baseline captured. {after
          ? 'The differences below represent callbacks since baseline.'
          : 'Perform a normal in-game action, then capture again.'}
      </p>}
      {changes.length > 0 && <div role="status" style={{ display: 'grid', gap: 6, fontSize: 12 }}>
        {changes.map(item => <div key={item.key} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between' }}>
          <span title={item.note}>{item.label}</span>
          <strong>+{item.delta} ({baseline!.counters[item.key]} → {after!.counters[item.key]})</strong>
        </div>)}
        <p style={{ marginTop: 8, fontSize: 11 }}>
          <strong>PRK65 frame accounting:</strong> {classified} classified / {attempted} outgoing attempts
          {' '}• {classesMatch ? 'MATCH' : 'MISMATCH — DO NOT USE THESE CATEGORIES AS VERIFIED'}
        </p>
        <p style={{ marginTop: 8, fontSize: 11 }}>
          {changes.some(item => item.key === 'wifiStarts' && item.delta > 0)
            ? 'The game switched on emulated Wi-Fi during the interval.'
            : 'No new Wi-Fi power-on callback was observed during the interval.'}
          {' '}Nonzero TX counters show attempted sends, not delivered packets.
          Zero values do not prove native trading is impossible.
          Management/beacon/probe categories are nested counts, not additional
          packets. Command/reply/ack values are host callback kinds and are
          separate from the 802.11 frame-type categories.
        </p>
      </div>}
      <p style={{ fontSize: 11, opacity: 0.75 }}>
        PRK63/65 counters work independently of PRK66. With PRK66 stopped,
        no wireless packets are transported. No native trade is possible yet.
      </p>
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #9bacb9' }}>
        <h3 style={{ fontSize: 14 }}>PRK66 • EXPERIMENTAL TWO-DS LOCAL RADIO</h3>
        <p style={{ fontSize: 12 }}>
          Requires <strong>two actual running melonDS game tabs</strong> in the
          same PokeRun room, on the same browser origin, using the same White 2 ROM
          but <strong>two distinct save slots</strong>.
          The fake P2 trainer cannot connect. Start this on both real player tabs.
          Raw emulated Wi-Fi frames stay in this browser's BroadcastChannel.
          This is a risky research experiment: use backed-up disposable saves.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" disabled={!eligible || !remotePlayerId || !saveProfileId ||
              Boolean(radioLink.current && radioStatus?.phase !== 'stopped' && radioStatus?.phase !== 'error')}
            onClick={startRadioLink}>START LOCAL DS RADIO</button>
          <button type="button" disabled={!radioLink.current} onClick={stopRadioLink}>
            STOP & CLEAR RADIO QUEUES
          </button>
        </div>
        {radioError && <p className="form-error" role="alert">{radioError}</p>}
        {radioStatus && <div role="status" style={{ fontSize: 12, marginTop: 8 }}>
          <strong>{radioStatus.phase.toUpperCase()}</strong>
          {' '}— {radioStatus.peerPresent
            ? 'A matching real emulator tab responded. Radio frames can now be exchanged.'
            : 'Awaiting an opted-in, verified real DS peer.'}
          <p>Browser TX {radioStatus.framesSent} • Browser RX accepted {radioStatus.framesReceived}
            {' '}• Browser RX rejected {radioStatus.framesRejected}</p>
          {radioStatus.native && <p>
            Native TX queued {radioStatus.native.outgoingEnqueued}
            {' '}• Native RX queued {radioStatus.native.incomingEnqueued}
            {' '}• Native RX consumed {radioStatus.native.incomingConsumed}
            {' '}• Native queue drops {radioStatus.native.dropped}
          </p>}
          {radioStatus.native && <p>
            <strong>PRK67 NATIVE WI-FI:</strong>
            {' '}accepted {radioStatus.native.wifiAccepted}
            {' '}• bad-length {radioStatus.native.wifiBadLength}
            {' '}• wrong-channel {radioStatus.native.wifiBadChannel}
            {' '}• MP-filtered {radioStatus.native.wifiMpFiltered}
            {' '}• beacons accepted {radioStatus.native.wifiBeaconsAccepted}
            {' '}• association responses accepted {radioStatus.native.wifiAssociationAccepted}
          </p>}
          {radioStatus.native && <div style={{ paddingTop: 8, borderTop: '1px solid #9bacb9' }}>
            <strong>PRK69 • NATIVE RF CHANNELS (READ ONLY)</strong>
            <p>Current RF channel: {radioStatus.native.radioCurrentChannel || 'unknown'}
              {' '}• game-driven channel changes: {radioStatus.native.radioChannelChanges}</p>
            <p><strong>TX:</strong> {formatChannelCounts(radioStatus.native.radioChannels, 'tx')}</p>
            <p><strong>Accepted RX:</strong> {formatChannelCounts(radioStatus.native.radioChannels, 'accepted')}</p>
            <p><strong>Wrong-channel RX:</strong> {formatChannelCounts(radioStatus.native.radioChannels, 'rejected')}</p>
            <p><strong>RF tuned to:</strong> {formatChannelCounts(radioStatus.native.radioChannels, 'tuned')}</p>
            <p style={{ opacity: 0.75, fontSize: 11 }}>
              Cumulative totals since this emulator booted. Mismatched channels
              may reflect normal scanning, not a transport failure. These counts
              never override radio channels or capture packet payloads.
            </p>
          </div>}
          {radioStatus.native && <div style={{ paddingTop: 8, borderTop: '1px solid #9bacb9' }}>
            <strong>PRK71 • DISTINCT IN-MEMORY FIRMWARE IDENTITIES</strong>
            <p>Verified test DS firmware role: {radioStatus.native.firmwareRoleApplied === 1
              ? 'PLAYER 1' : radioStatus.native.firmwareRoleApplied === 2 ? 'PLAYER 2' : 'NOT APPLIED'}
              {' '}• expected: {new URLSearchParams(window.location.search).get('player') === '1'
                ? 'PLAYER 1' : 'PLAYER 2'}</p>
            <p style={{ fontSize: 11, opacity: 0.75 }}>
              Both players must have opposite applied roles before starting the
              radio link. Only freshly generated, in-memory firmware is changed;
              no ROM, stored firmware or battery-save data is rewritten.
              PRK70 below verifies the *actual radio-frame addresses*.
            </p>
          </div>}
          {radioStatus.native && <div style={{ paddingTop: 8, borderTop: '1px solid #9bacb9' }}>
            <strong>PRK72 • NATIVE CONNECTION FRAME STAGES (READ ONLY)</strong>
            <p style={{ fontSize: 11, opacity: 0.75 }}>
              TX counts actual outgoing Wi-Fi callbacks; hardware RX counts
              packets committed to the emulated DS receive ring (IRQ).
              This is not proof the game parsed or responded to a packet.
            </p>
            {radioStatus.native.handshakeStages.map(stage => <p key={stage.kind}
              style={{ margin: '3px 0', fontSize: 12 }}>
              {handshakeStageLabels[stage.kind] ?? 'Unknown'}:
              {' '}TX {stage.sent} • hardware RX {stage.receivedByHardware}
            </p>)}
            {radioStatus.native.handshakeStages[0]?.sent > 0 &&
              radioStatus.native.handshakeStages.slice(1).every(stage =>
                stage.sent === 0 && stage.receivedByHardware === 0) && <p
                  role="status" style={{ fontSize: 12, fontWeight: 600 }}>
                BEACON-ONLY — NO CONNECTION FRAMES OBSERVED. PRK73 next test:
                with two independently created, normally progressed White 2
                trainer saves (Basic Badge and C-Gear acquired), enter the
                actual in-game Union Room through the left desk on Pokémon
                Center 2F in BOTH real emulator tabs. Keep PRK66 radio enabled
                and compare these same counters again. A copied .sav has the
                same trainer identity and is not a conclusive peer test.
              </p>}
            <p style={{ fontSize: 11, opacity: 0.75 }}>
              C-Gear wireless being enabled is not the same as initiating
              a local Union Room session. A raw DS beacon—even one delivered
              through RX IRQ—does not prove player discovery or association.
              Do not force BSSID, channel, connection state, or trade overlay.
            </p>
          </div>}
          {radioStatus.native && <div style={{ paddingTop: 8, borderTop: '1px solid #9bacb9' }}>
            <strong>PRK70 • NATIVE BEACON DELIVERY + MAC COLLISION (READ ONLY)</strong>
            <p>Incoming beacons whose sender MAC matches this DS:
              {' '}{radioStatus.native.rxBeaconSameLocalMac}
              {' '}• different MAC: {radioStatus.native.rxBeaconDifferentLocalMac}</p>
            <p>Native frames completed by hardware: {radioStatus.native.rxNativeCompleted}
              {' '}• RX ring/IRQ signaled: {radioStatus.native.rxNativeRingIrq}</p>
            <p>Hardware destination filtered: {radioStatus.native.rxDestinationRejected}
              {' '}• WEP filtered: {radioStatus.native.rxWepRejected}
              {' '}• beacon BSSID matched: {radioStatus.native.rxBeaconBssidMatched}
              {' '}• beacon RX filter rejected: {radioStatus.native.rxBeaconHardwareFiltered}</p>
            <p style={{ fontSize: 11, opacity: 0.75 }}>
              Same-MAC is an equality check only; neither MAC address is
              exposed. Counts are cumulative since emulator startup.
              RX IRQ indicates the native Wi-Fi hardware raised a receive
              interrupt, not that White 2 discovered another player.
            </p>
          </div>}
          {radioStatus.reason && <p className="form-error">{radioStatus.reason}</p>}
        </div>}
        <p style={{ fontSize: 11, opacity: 0.75 }}>
          Linked means only that two browser tabs exchanged control messages.
          Native RX consumed means the emulator copied an incoming frame.
          PRK67 Wi-Fi accepted means it passed the receiver's length, channel,
          and MP filtering checks. An accepted beacon is not a discovered
          trainer; positive association responses are a stronger, separate
          milestone. Stop the link before closing a game tab.
        </p>
      </div>
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #9bacb9' }}>
        <h3 style={{ fontSize: 14 }}>PRK76 • CONTROLLED UNION ROOM RADIO DELTA (READ ONLY)</h3>
        <p style={{ fontSize: 12 }}>
          PRK72 numbers above are cumulative since boot. Capture a baseline on
          <strong> both real tabs</strong>, enter the native Union Room on both
          games (or wait while already inside), then capture AFTER on both.
          Compare changes, not lifetime totals. Keep PRK75 isolation enabled
          and PRK66 linked for a live two-DS test. No game memory or saved data is changed.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" disabled={!eligible} onClick={() => captureRadio('before')}>
            1. CAPTURE RADIO BASELINE
          </button>
          <button type="button" disabled={!eligible || !radioBefore}
            onClick={() => captureRadio('after')}>
            2. CAPTURE RADIO AFTER
          </button>
        </div>
        {radioCaptureError && <p className="form-error" role="alert">{radioCaptureError}</p>}
        {radioBefore && !radioAfter && <p role="status" style={{ fontSize: 12 }}>
          Radio baseline captured. Now perform the in-game action on both DS systems.
        </p>}
        {radioDelta && <div role="status" style={{ fontSize: 12, display: 'grid', gap: 5, marginTop: 8 }}>
          <strong>PRK76 • DELTA FROM BASELINE</strong>
          <p>
            Observation window: {(radioDelta.elapsedMs / 1000).toFixed(1)} s
            {' '}• emulated DS frames advanced: {radioDelta.emulatedFrames}
          </p>
          <p>
            Wi-Fi power on +{radioDelta.wifiStarts} / off +{radioDelta.wifiStops}
            {' '}• MP TX callbacks +{radioDelta.mpTxAttempts}
            {' '}• MP command +{radioDelta.mpCommands}
            {' '}• reply +{radioDelta.mpReplies}
            {' '}• ack +{radioDelta.mpAcks}
          </p>
          <p>
            Transport RX queued +{radioDelta.rxQueue}
            {' '}• consumed +{radioDelta.rxConsumed}
            {' '}• accepted by receiver +{radioDelta.rxAccepted}
            {' '}• rejected wrong channel +{radioDelta.wrongChannel}
            {' '}• native RX IRQ +{radioDelta.rxIrq}
          </p>
          {radioDelta.stages.map(stage => <p key={stage.kind} style={{ margin: '2px 0' }}>
            {handshakeStageLabels[stage.kind] ?? 'Unknown'}:
            {' '}TX +{stage.tx} • hardware RX +{stage.rx}
          </p>)}
          {radioDelta.stages.slice(1).every(stage => stage.tx === 0 && stage.rx === 0)
            && <p style={{ fontWeight: 700 }}>
              BEACON-ONLY DURING THIS OBSERVATION WINDOW. Confirm whether
              both trainers are visible and have distinct in-game Trainer IDs;
              do not force RF channels or attempt a native trade.
            </p>}
          {radioDelta.emulatedFrames === 0 && radioDelta.elapsedMs > 1000 &&
            <p className="form-error">
              NO EMULATED FRAMES ADVANCED during this capture. Check if the game
              is paused, stalled or throttled before interpreting the Wi-Fi results.
            </p>}
          <p style={{ opacity: 0.8 }}>
            These are counts from one emulator tab; collect both players.
            A hardware IRQ does not prove the game parsed the frame. PRK76
            also logs its aggregate delta to the DEV console.
          </p>
        </div>}
      </div>
      <White2NativeFreezeWatch bridge={bridge}/>
    </details>
  </section>
}
