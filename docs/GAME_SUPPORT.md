# Game support matrix

PokéRun currently registers every mainline individual version from Generation I through Generation V in the runtime layer.

This means the app knows which emulator family, ROM extension, screen layout, and future memory-adapter family each game belongs to. It does **not** mean all 20 games already have production memory parsers or playable WASM emulator integration.

| Generation | Games | Platform | Emulator target | Adapter family | ROM |
| --- | --- | --- | --- | --- | --- |
| I | Red, Blue, Yellow | GB | mGBA | `gen1-rby` | `.gb` |
| II | Gold, Silver, Crystal | GBC | mGBA | `gen2-gsc` | `.gbc` |
| III | Ruby, Sapphire, Emerald | GBA | mGBA | `gen3-rse` | `.gba` |
| III | FireRed, LeafGreen | GBA | mGBA | `gen3-frlg` | `.gba` |
| IV | Diamond, Pearl, Platinum | NDS | melonDS | `gen4-dppt` | `.nds` |
| IV | HeartGold, SoulSilver | NDS | melonDS | `gen4-hgss` | `.nds` |
| V | Black, White | NDS | melonDS | `gen5-bw` | `.nds` |
| V | Black 2, White 2 | NDS | melonDS | `gen5-b2w2` | `.nds` |

## What works now

- All 20 games are selectable from Home.
- New Run resolves a runtime definition for every game.
- The ROM picker accepts the correct file extension for the selected platform.
- Selected ROM bytes remain local to the browser and are kept in an in-memory session store.
- GB/GBC/GBA games resolve to the mGBA emulator target.
- DS games resolve to the melonDS emulator target.
- All games map to one of eight game-state adapter families.
- The current mock adapter can exercise the same normalized run pipeline for any registered game.

## Still to implement

1. Real mGBA WASM bridge.
2. Real melonDS WASM bridge.
3. Battery-save persistence in IndexedDB.
4. Real memory readers for each of the eight game families.
5. Deterministic randomization support by generation.
6. ROM fingerprinting/version detection so adapters can use exact addresses for each supported revision.

The important architecture rule is that screens should depend on normalized `RunState` / `GameSnapshot`, never directly on emulator-specific memory addresses.
