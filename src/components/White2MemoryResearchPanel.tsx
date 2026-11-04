import { useEffect, useState } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import {
  White2PartyStructureProbe,
  type White2PartyStructureSnapshot,
} from '../multiplayer/games/White2PartyStructureProbe'

// PRK62 is a manual, DEV-only read of the exact-ROM party structure.
// No polling, guest CPU calls, writes, save mutation, or network messages.
// Earlier remote actor research remains retired; this does not recreate it.
export function White2MemoryResearchPanel({ bridge, rom }: {
  bridge: MelonDsBridge | null
  rom: MultiplayerRomIdentity
}) {
  const [snapshot, setSnapshot] = useState<White2PartyStructureSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const eligible = Boolean(import.meta.env.DEV && bridge?.status === 'running' &&
    White2PartyStructureProbe.supportsRom(rom))

  useEffect(() => {
    setSnapshot(null)
    setError(null)
  }, [bridge, rom.sha256])

  if (!import.meta.env.DEV) return null

  async function inspectParty() {
    if (!eligible || !bridge || reading) return
    setReading(true)
    setSnapshot(null)
    setError(null)
    try {
      const result = await new White2PartyStructureProbe(bridge).inspect()
      setSnapshot(result)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Unknown read-only party probe failure.'
      setError(message)
      console.info('[PokéRun party] PRK62 READ-ONLY PARTY STRUCTURE BLOCKED', {
        reason: message,
        guestWrites: 0,
        networkMessages: 0,
      })
    } finally {
      setReading(false)
    }
  }

  return <section className="multiplayer-session-debug pixel-border" style={{ padding: 12 }}>
    <details>
      <summary style={{ cursor: 'pointer', fontWeight: 800 }}>PRK62 • WHITE 2 PARTY STRUCTURE RESEARCH (READ ONLY)</summary>
      <p style={{ fontSize: 12, marginTop: 10 }}>
        One-time memory inspection. The derived GameData party pointer is not trusted
        until a live read validates the header. This never changes Pokémon, saves, or
        the simulated trainer.
      </p>
      <button type="button" disabled={!eligible || reading} onClick={() => void inspectParty()}>
        {reading ? 'INSPECTING...' : 'INSPECT LOCAL PARTY STRUCTURE'}
      </button>
      {!eligible && <p style={{ fontSize: 11 }}>Requires a running emulator with the exact tested White 2 ROM.</p>}
      {error && <p className="form-error" role="status">{error}</p>}
      {snapshot && <div role="status" style={{ marginTop: 10, fontSize: 12 }}>
        <p><strong>Candidate party:</strong> {snapshot.party} • GameData + {snapshot.partyPointerOffset}</p>
        <p><strong>Header:</strong> capacity {snapshot.capacity}, count {snapshot.count},
          marked slots {snapshot.markedSlots} • mask {snapshot.slotExistsMask}</p>
        <p><strong>Cross-check:</strong> {snapshot.countMatchesMask
          ? 'Count and slot flags agree.' : 'Count and slot flags disagree — do not trust this layout yet.'}
          {' '}Pointer remained stable throughout the inspection.</p>
        <div style={{ display: 'grid', gap: 4 }}>
          {snapshot.slots.map(slot => <div key={slot.slot}>
            Slot {slot.slot}: {slot.existsFlag
              ? `Lv${slot.level} • HP ${slot.currentHp}/${slot.maxHp} • ${slot.hpPlausible ? 'metadata plausible' : 'METADATA UNVERIFIED'}`
              : 'empty by slot flag'}
          </div>)}
        </div>
        <p style={{ fontSize: 11, opacity: .75 }}>
          PID and checksum values are not displayed. Species and nicknames are not decoded.
          No Pokémon records were transmitted or written.
        </p>
      </div>}
    </details>
  </section>
}
