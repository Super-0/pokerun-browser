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
        One-time read of local White 2 RAM. The party header is checked first,
        then any encrypted Pokémon bytes are decoded in separate browser copies
        and verified against their checksums. No guest decryption or writes.
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
        <p><strong>Header cross-check:</strong> {snapshot.countMatchesMask
          ? 'Count and slot flags agree.' : 'Count and slot flags disagree — do not trust this layout yet.'}
          {' '}Pointer remained stable throughout the inspection.</p>
        <p><strong>Decoded data:</strong> {snapshot.decodedSlotsVerified
          ? 'Every occupied slot has a matching box checksum, a plausible species ID and valid level/HP.'
          : 'At least one occupied slot failed checksum or metadata validation. Do not trust those fields yet.'}
        </p>
        <div style={{ display: 'grid', gap: 4 }}>
          {snapshot.slots.map(slot => <div key={slot.slot}>
            Slot {slot.slot}: {slot.existsFlag
              ? `Species #${slot.speciesId} • Lv${slot.level} • HP ${slot.currentHp}/${slot.maxHp} • ${slot.boxChecksumValid && slot.speciesPlausible && slot.hpPlausible ? 'CHECKS PASSED' : 'UNVERIFIED'} • ${slot.partyWasEncrypted ? 'party bytes decoded' : 'party bytes already decrypted'}`
              : 'empty by slot flag'}
          </div>)}
        </div>
        <p style={{ fontSize: 11, opacity: .75 }}>
          Species numbers are research values, not verified names. Raw PID and checksum
          values are not displayed. Encrypted/decoded Pokémon bytes remain local:
          no guest memory writes, Pokémon transfers, or protocol messages.
        </p>
      </div>}
    </details>
  </section>
}
