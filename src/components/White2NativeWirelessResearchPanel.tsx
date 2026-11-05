import { useEffect, useRef, useState } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2PartyStructureProbe } from '../multiplayer/games/White2PartyStructureProbe'
import { White2NativeRadioLink, type NativeRadioLinkStatus } from '../multiplayer/games/White2NativeRadioLink'

// PRK63: one-emulator feasibility experiment. These are counters in the
// pinned WASM Wi-Fi callbacks, NOT evidence of a connected second DS.
// No emulated button presses, guest memory writes, packet payloads or sends.
type Counters = ReturnType<MelonDsBridge['getNativeWirelessProbeCounters']>
type Capture = { capturedAt: number; counters: Counters }

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
  const radioLink = useRef<White2NativeRadioLink | null>(null)
  useEffect(() => {
    setBaseline(null)
    setAfter(null)
    setError(null)
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
        note: 'WASM callback counters only. The original MP/Net stubs still do not deliver packets.',
      })
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      console.info('[PokéRun wireless] PRK63 TELEMETRY BLOCKED', { reason: message })
    }
  }

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
          {radioStatus.reason && <p className="form-error">{radioStatus.reason}</p>}
        </div>}
        <p style={{ fontSize: 11, opacity: 0.75 }}>
          Linked means only that two browser tabs exchanged control messages.
          Native RX consumed is stronger evidence that an actual emulator read
          incoming bytes. Neither means White 2 discovered the other trainer,
          entered the Union Room, or completed a trade. Stop the link before
          closing a game tab.
        </p>
      </div>
    </details>
  </section>
}
