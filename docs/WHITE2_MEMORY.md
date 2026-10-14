# Pokémon White 2 live-memory research

## Status

No White 2 player-state address, pointer chain, location identifier, or facing
encoding is recorded yet. This document intentionally contains no guessed
offsets. The current multiplayer game screen labels local state as waiting for
the White 2 adapter until one is empirically validated for a fingerprint.

`Arm9MemoryInspector` supplies development-only bounded snapshot/compare
primitives over the deliberate `MelonDsBridge.readBytes()` ARM9 bus boundary.
It is intentionally generic: it does not include any White 2 offsets.

## Required evidence record

For every supported revision, record:

| Field | Required evidence |
| --- | --- |
| ROM SHA-256 | Full local SHA-256 |
| NDS header | Title, game code, region/revision if determinable |
| Provenance | Reverse-engineering source and/or controlled experiment |
| Location identity | Address/pointer path, size/encoding, transition tests |
| X/Y | Address/pointer path, encoding, controlled one-tile tests |
| Direction | Address/pointer path, raw values and normalization |
| Stability | Restart, save reload, and map-transition results |

## Validation procedure

1. Capture a bounded ARM9-main-RAM snapshot while still.
2. Move exactly one tile in each direction and compare snapshots.
3. Face each direction without moving where possible.
4. Cross town/route/interior/floor boundaries.
5. Repeat after emulator restart and a save reload.

Addresses found in another revision or a temporary heap allocation must remain
hypotheses until these tests pass for the recorded SHA-256.
