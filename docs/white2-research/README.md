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
| Map matrices | `a/0/0/9` | next | — |
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

Each zone event member contains counts followed by background events, NPCs, warps and triggers. A grid warp provides:

- source zone ID
- source warp index
- source grid `x`, `y`, `z`
- source width / height
- destination zone ID
- destination warp index
- transition type

PokéRun then resolves the destination warp index inside the destination zone and records that warp's grid position as `destinationPosition`.

The first validation anchor is the already-observed `427 ↔ 428` door transition. `rom.json.validationAnchors.zone427To428OrReverse` contains any native records connecting those two zones.

## Immediate next decoder: map matrices

Door/cave/stair warps are only one type of field transition. Seamless route/town boundaries are expected to depend on map matrices rather than zone warp records.

The next decoder should therefore parse `a/0/0/9` and produce a normalized matrix representation that can answer:

```text
(zone, current map-cell, movement direction)
    -> neighboring map-cell / zone
```

That will be the basis for direct map-edge transitions without `ARM NEXT HOST DOOR` and without requiring Player 1 to visit a boundary first.

## External research basis

The current Black 2 / White 2 decompilation documents the numbered data archives and byte layouts used here. PokéRun reimplements only the small parsing logic it needs and continues to verify all results against the user's exact ROM.

Primary reference:

- `fuddlesworth/pokebw2` — `docs/data.md`, `tools/data/zone_data.py`, `tools/data/event_data.py`, and their JSON schemas.
