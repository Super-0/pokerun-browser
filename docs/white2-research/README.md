# White 2 knowledge extraction

PokéRun treats the exact tested Pokémon White 2 ROM as a read-only source of static game knowledge. The extractor lives in `tools/white2-extract/` and writes reproducible local output to `generated/white2/`.

## Tested ROM

- Game code: `IRDO`
- SHA-256: `54bec4091ba3eb89f4e1ee4e2f3421005835804376a34e5e45f3157e1f55625a`
- The extractor refuses any other ROM revision.

Run:

```bash
npm run white2:extract -- /path/to/PokemonWhite2.nds
```

Generated output is intentionally ignored by Git. Never commit ROM bytes or extracted copyrighted assets.

## Knowledge layers

Keep these separate:

1. **Static ROM knowledge** — zones, warps, map matrices, collision, encounters, scripts, flags, trainers, species, items.
2. **Runtime symbols** — live field/actor/render addresses needed by the emulator integration.
3. **PokéRun runtime invariants** — behavior discovered through testing, such as delaying native remote creation during field bootstrap and normalizing remote render writes before they reach melonDS.

A static decoder must never write to emulator memory.

## Current extraction status

| Subject | ROM source | Status | Generated output |
| --- | --- | --- | --- |
| NDS header / NitroFS | NDS header + FNT/FAT | decoded | `rom.json`, `nitrofs.json`, `directories.json` |
| NARC inventory | all NitroFS files | decoded | `narc-index.json` |
| Zone headers | `a/0/1/2` | decoded | `zones.json` |
| Zone events index | `a/1/2/6` | decoded | `events-index.json` |
| Warp graph | `a/1/2/6` + zone headers | decoded | `warps.json` |
| Map matrices | `a/0/0/9` | decoded | `map-matrices.json` |
| Seamless zone adjacency | overworld matrix zone grids | decoded | `zone-boundaries.json`, `zone-adjacency.json` |
| Directional tile-edge triggers | matrix cells + White 2 coordinate conversion | decoded | `zone-boundary-triggers.json`, `zone-boundary-trigger-index.json` |
| Safe fake-P2 runtime registry | validated tile-edge triggers | decoded | `public/dev-generated/white2-boundary-trigger-index.json` |
| Areas | `a/0/1/3` | identified | — |
| Map models | `a/0/0/8` | identified | — |
| Map textures | `a/0/1/4` | identified | — |
| Wild encounters | `a/1/2/7` | identified | — |
| NPC caches | `a/0/5/7` | identified | — |
| Field actors | `a/0/4/7`, `a/0/4/8` | identified | — |
| Town map | `a/0/8/5` | identified | — |
| Field props | `a/2/2/5`, `a/2/2/6` | identified | — |
| Prop textures | `a/1/7/4`, `a/1/7/5` | identified | — |
| Walking Pokémon | `a/2/0/8` | identified | — |
| Scripts / script text | zone header references | planned | — |
| Event flags / variables | script/save systems | planned | — |
| Collision / tile permissions | field map data | planned | — |
| Trainers / teams | trainer archives | planned | — |
| Species / moves / items / learnsets | game-data archives | planned | — |
| Save layout | save system | planned | — |

## Native warp graph

White 2 zone headers are 0x30 bytes each. A header supplies the numeric entity-file index for its zone. The extractor uses that index to read the corresponding member of `a/1/2/6`.

Each zone event member contains counts followed by background events, NPCs, warps and triggers. A grid warp provides source zone/warp information, destination zone/warp information, transition type, and its source grid position. PokéRun resolves the destination warp index inside the destination zone and records the destination position.

The first validation anchor is the already-observed `427 ↔ 428` Aspertia door transition. The tested ROM exposes two native records connecting those zones, one in each direction.

## Seamless map boundaries

`a/0/0/9` contains map matrices. The overworld matrix contains both map-model IDs and a parallel grid of zone IDs. Adjacent matrix cells with different zone IDs describe seamless route/town boundaries.

White 2 converts world position to a matrix cell with `GetChunkCoordOfWorld`:

```text
((worldCoordinate / 0x1000) / 16) / 32
```

PokéRun's live multiplayer grid uses tile coordinates, so the equivalent relationship is:

```text
matrixCell = floor(tileCoordinate / 32)
```

The extractor therefore converts every physical zone boundary into two directional tile-edge triggers. On the tested ROM this yields 92 physical boundaries and 184 directional triggers.

### Validation quarantine

A trigger is considered safe for the fake-P2 runtime only when both participating zone headers name the same matrix that produced the boundary. The current ROM has one exceptional pair in both directions:

- zone 120 — Opelucid City
- zone 355 — Route 10

The overworld matrix retains their legacy adjacency, while Route 10's header names matrix 44. Because Route 10 is legacy/inaccessible map data in Black 2/White 2, PokéRun keeps these two directional triggers in the research output but excludes them from the safe runtime registry. The safe registry therefore contains 182 directional triggers.

## Dev fake-P2 integration

`runtime-boundary-export.mjs` writes the validated runtime registry to `public/dev-generated/white2-boundary-trigger-index.json`. `BroadcastChannelTransport` applies this registry only to `fake-remote-*` `GAME_STATE` packets.

When a fake P2 movement packet advances exactly one tile across a validated source edge, the transport mutates P2's map ID to the destination zone while preserving the continuous tile/world position. The remote door runtime classifies an inferred one-tile map change as `map-edge` and deliberately skips door animation.

This keeps static route/town navigation separate from the already-stable building-door system.

## External research basis

The current Black 2 / White 2 decompilation documents the numbered data archives and byte layouts used here. PokéRun reimplements only the small parsing logic it needs and continues to verify all results against the user's exact ROM.

Primary reference:

- `fuddlesworth/pokebw2` — `docs/data.md`, `tools/data/zone_data.py`, `tools/data/event_data.py`, `tools/data/map_matrix_data.py`, and `src/ov012/map_matrix.c`.
