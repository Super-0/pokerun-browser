import { useEffect, useState } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2PartyStructureProbe } from '../multiplayer/games/White2PartyStructureProbe'

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
]

export function White2NativeWirelessResearchPanel({ bridge, rom }: {
  bridge: MelonDsBridge | null
  rom: MultiplayerRomIdentity
}) {
  const [baseline, setBaseline] = useState<Capture | null>(null)
  const [after, setAfter] = useState<Capture | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setBaseline(null)
    setAfter(null)
    setError(null)
  }, [bridge, rom.sha256])

  if (!import.meta.env.DEV) return null

  const eligible = bridge?.status === 'running' && White2PartyStructureProbe.supportsRom(rom)

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
  return <section className="multiplayer-session-debug pixel-border" style={{ padding: 12 }}>
    <details>
      <summary style={{ cursor: 'pointer', fontWeight: 800 }}>
        PRK63 • NATIVE WHITE 2 WIRELESS FEASIBILITY (READ ONLY)
      </summary>
      <p style={{ marginTop: 10, fontSize: 12 }}>
        Observe when the real White 2 game calls the emulator's Wi-Fi hooks.
        This does not connect a second DS or initiate a native trade.
        Our simulated trainer uses a separate PokeRun protocol.
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
        Between captures, use only White 2's normal menus. Once the game has
        granted the C-Gear, you can toggle its wireless feature or visit the
        Union Room. If not unlocked, do not modify or bypass your save.
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
          {changes.some(item => item.key === 'wifiStarts' && item.delta > 0)
            ? 'The game switched on emulated Wi-Fi during the interval.'
            : 'No new Wi-Fi power-on callback was observed during the interval.'}
          {' '}Nonzero TX counters show attempted sends, not delivered packets.
          Zero values do not prove native trading is impossible.
        </p>
      </div>}
      <p style={{ fontSize: 11, opacity: 0.75 }}>
        PRK63 transports zero packets and never reads raw wireless payloads,
        Pokémon records or save bytes. No actual trade is possible in this experiment.
      </p>
    </details>
  </section>
}
