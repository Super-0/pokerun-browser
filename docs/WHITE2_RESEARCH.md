# Pokémon White 2 Reverse-Engineering Notes

Last updated: 2026-10-30
Target: Pokémon White 2 US (IRDO), exact-ROM-fingerprint gated by PokéRun code.

This file contains durable reverse-engineering findings. Keep temporary experiment status in `docs/POKERUN_MULTIPLAYER_STATE.md`.

## Field Actor System

### Known actor fields used by PokéRun

Offsets are relative to a `FieldActor` base.

| Offset | Meaning / current interpretation |
| --- | --- |
| `+0x08` | UID (u16) |
| `+0x0C` | object/model code (u16 portion; observed protagonist `240`) |
| `+0x18` | face/direction-related state |
| `+0x3C` | grid position fields |
| `+0x44` | world position fields |
| `+0x81` | shadow group byte |
| `+0x84` | native actor update TCB pointer |
| `+0x88` | actor-system backpointer |
| `+0x8C` | move-code/function-table pointer |
| `+0x90` | inline scene-node vtable |
| `+0xC4` | BLAct index mirror / related runtime state (observed P1 `9`, P2 `10`) |

FieldActor size used by current code: `0x100` bytes.

## Actor System / BLAct Path

Known constants in current PokéRun code:

| Structure / offset | Meaning |
| --- | --- |
| ActorSystem `+0x28` | Field BLAct wrapper |
| Field BLAct `+0x04` | BLAct system |
| BLAct system `+0x04` | scene |
| BLAct system `+0x18` | actor-handle array |
| BLAct system `+0x1C` | actor-handle count |
| scene `+0x08` | BLAct actor array |
| scene `+0x0E` | configured BLAct actor count |

Known sizes:

- BLAct: `0x1C`
- renderer handle: `0x28`

## BLAct fields currently used

| Offset | Meaning / interpretation |
| --- | --- |
| `+0x00` | geometry/material entry related flags used by current renderer code |
| `+0x04` | position/runtime word |
| `+0x10` | face/frame-related index word |
| `+0x18` | material/visibility flags |

Observed stable protagonist values in map 427 testing:

- `matEntry = 13`
- `geomFlags = 13`
- `matFlags = 4639` (`0x121F`)

## Renderer Handle

Known offsets in current code:

| Offset | Meaning |
| --- | --- |
| `+0x00` | BLAct index |
| `+0x04` | material entry |
| `+0x08` | animation table pointer |
| `+0x0C` | animation count (u16) |
| `+0x0E` | current animation index (u16) |
| `+0x10` | step |
| `+0x12` | wait |
| `+0x14` | loops |
| `+0x18` | animate flag/state |
| `+0x24` | shared renderer/model-manager-related pointer observed in current captures |

Stable map-427 capture:

### P1 handle

- address: `0x0226919C`
- BLAct index: `9`
- matEntry: `13`
- anim table: `0x021CF13C`
- `+0x0C` word: `0x00010030`
- `+0x24`: `0x0230A7CC`

### Injected P2 handle

- address: `0x022691C4`
- BLAct index: `10`
- matEntry: `13`
- anim table: `0x021CF13C`
- `+0x0C` word: `0x00000030`
- `+0x24`: `0x0230A7CC`

Thus both actors share the same animation-table pointer and same `+0x24` pointer. The `+0x0C` difference is current animation index (`1` vs `0`) with the same animation count (`48`).

## Scene Node

Observed scene-node vtable for both real P1 and injected P2:

- `0x021CF974`

Native BLAct-index lookup currently calls:

- `FldAct_GetBlActIdx` at `0x02167240`

## Native Functions Used / Identified

Current exact White 2 addresses used by PokéRun include:

| Function | Address |
| --- | --- |
| Find field actor | `0x02167A54` |
| Create actor | `0x021668B4` |
| Delete actor | `0x02166980` |
| Set actor hidden | `0x02167574` |
| Get BLAct index | `0x02167240` |
| Set shadow group | `0x0216784C` |
| Set force-off shadow | `0x0216787C` |
| GFL TCB manager add task | `0x0203A640` |
| GFL TCB remove | `0x0203A6D4` |

PokéRun schedules native actor creation/deletion/resource operations through White 2's own field task manager rather than relying only on direct bounded ARM9 calls, because resource loading may yield through the game's scheduler.

## Remote Actor Test UID

PokéRun currently uses temporary development UID:

- `0x7F01`

Real local player UID observed:

- `0x00FF`

## Stable Resource-Graph Observation

A read-only resource graph probe compared the real protagonist and the visibly orange injected remote actor.

Even while the two looked different on screen, the following matched:

- model/object code `240`
- scene-node vtable `0x021CF974`
- material entry `13`
- geometry flags `13`
- material flags `4639`
- animation table pointer `0x021CF13C`
- dumped animation table contents
- shared renderer/model-manager-related handle pointer `0x0230A7CC`

This proves the currently mapped `FieldActor.modelId -> BLAct -> renderer handle -> animation table` fields are not sufficient to explain final on-screen trainer identity.

## moveCode Experiment

Original injected `ZoneNPC` used move code `2`, inherited from an earlier Union Room actor bootstrap idea.

With move code `2`:

- real P1 move/function-table pointer: `0x021CC5D0`
- injected P2 pointer: `0x021CC454`

Controlled Probe 2 changed only the injected ZoneNPC move code to `0`.

After fresh creation:

- both P1 and P2 use `0x021CC5D0`;
- P2 still renders as the orange trainer.

Conclusion: move code/function-table identity is not the cause of the orange sprite.

## Resource Manager Clue

The shared pointer at renderer handle `+0x24` was observed at:

- `0x0230A7CC`

A memory head behind that pointer includes ASCII bytes decoding to the prefix:

- `fldmmdl_`

This likely relates to White 2's field model/model manager and is a promising target for locating actual character/texture/palette resource ownership.

Do not yet treat the exact structure layout beyond the observed bytes as proven.

## Static Map / Transition Research

PokéRun has already extracted/decoded a substantial amount of White 2 static field data, including:

- map/zone relationships;
- native warp data;
- destination resolution;
- static transition/boundary triggers.

Current startup logs report 182 static boundary triggers loaded.

Door/transition implementation is intentionally paused while the orange remote visual-identity bug is reverse-engineered.

## Research Rules

Prefer:

- read-only dumps;
- exact before/after snapshots;
- one-variable experiments;
- native White 2 functions where their semantics are known;
- recording falsified hypotheses here.

Avoid:

- copying arbitrary P1 pointers directly into P2;
- changing multiple actor fields at once;
- conflating the second emulator's real player with the injected remote actor;
- resuming higher-level transition polish before visual resource identity is understood.
