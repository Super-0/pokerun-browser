# Pokémon White 2 Reverse-Engineering Notes

Last updated: 2026-10-30
Target: Pokémon White 2 US (IRDO), exact-ROM-fingerprint gated by PokéRun code.

This file contains durable reverse-engineering findings. Keep temporary experiment status in `docs/POKERUN_MULTIPLAYER_STATE.md`.

## Primary External Reference

A public decomp/reconstruction repository, `fuddlesworth/pokebw2`, contains White 2 US source reconstruction, exact symbol names, and addresses matching PokéRun's independently identified functions.

This should now be treated as a primary reverse-engineering reference before inferring unknown structure semantics from RAM.

## Exact FieldActor Layout

`include/field/field_actor_internal.h` reconstructs the live actor layout.

Important offsets:

| Offset | Field |
| --- | --- |
| `+0x00` | `flags` (u32) |
| `+0x04` | `movementFlags` (u32) |
| `+0x08` | `uid` (u16) |
| `+0x0A` | `zoneId` (u16) |
| `+0x0C` | `modelId` / object code (u16) |
| `+0x0E` | `moveCode` (u16) |
| `+0x10` | event type |
| `+0x12` | spawn flag |
| `+0x14` | script ID |
| `+0x16` | default direction |
| `+0x18` | face direction |
| `+0x1A` | motion direction |
| `+0x1C` | last face direction |
| `+0x1E` | last motion direction |
| `+0x20/+0x22/+0x24` | user params 0/1/2 |
| `+0x26` | next action command |
| `+0x28` | action-command state |
| `+0x2A` | draw status |
| `+0x2C/+0x2E` | area width/height |
| `+0x30` | default grid position |
| `+0x36` | initial grid position |
| `+0x3C` | current grid position |
| `+0x44` | world position `VecFx32` |
| `+0x50` | world-position offset |
| `+0x5C` | outer draw offset |
| `+0x68` | attribute draw offset |
| `+0x74` | current tile |
| `+0x78` | original-Y tile |
| `+0x7C/+0x7D` | collision width/height |
| `+0x7E..+0x80` | model position offsets |
| `+0x81` | shadow group |
| `+0x84` | native actor TCB pointer |
| `+0x88` | actor-system backpointer |
| `+0x8C` | move-code vtable pointer |
| `+0x90` | scene-node vtable pointer |
| `+0x94` | rail/position work block begins |
| `+0xA4` | move-subprocess work |
| `+0xB4` | movement-command work |
| `+0xC4` | billboard actor work |
| `+0xE4` | embedded `FieldActorConfig` |

Current PokéRun uses a `0x100`-byte actor stride, consistent with the live heap observations.

## FieldActorConfig

`FieldActorConfig` is the object-code record from the field model table. It contains:

- object/config UID;
- entity type;
- scene-node type;
- shadow/reflection/footprint settings;
- billboard size;
- sprite-atlas size;
- sprite controller type;
- gender;
- collision size;
- model position offsets;
- resource-group indices.

In the stable map-427 orange-P2 test, P1 and P2 have byte-for-byte identical embedded `FieldActorConfig` for object code `240`.

Generated object-code data identifies:

- `OBJ_CODE_HERO` = 231
- `OBJ_CODE_HEROINE` = 240

The tested local player is therefore using the heroine object code.

## Native White 2 Player Creation

`field_player_core.c` creates the real player from a `ZoneNPC` template:

- UID `0xFF`;
- model `OBJ_CODE_HERO`/`OBJ_CODE_HEROINE` depending player state/sex;
- `MOVE_CODE_NONE` while on the normal grid;
- normal field actor creation via `CreateNewActorByEntityNoWKOBJCODE`.

After creation it calls `SetActorFlag32(actor, TRUE)`.

`SetActorFlag32` sets actor flag `0x20`. Other code shows this flag is used for persistent/resident actors across actor cleanup/zone changes; it is not currently proven to affect visual model identity.

Stable flags in the orange-P2 experiment:

- P1: `0x00000023`
- P2: `0x00010003`

So P1 has flag `0x20` and P2 does not, but current decomp usage points toward persistence rather than texture selection.

## White 2 Already Has Remote-Player Field Actors

`src/ov036/field_comm_actor.c` is explicitly the game's system for:

> the actors of the other players in a field communication

This is directly relevant to PokéRun.

### Native remote-player ZoneNPC template

White 2's communication actor template uses:

- UID `0xFC`;
- model filled per remote player;
- `MOVE_CODE_COMM_ACTOR`;
- no event type;
- spawn flag 0;
- script ID `0x7D0`;
- direction 0;
- params 0;
- area width/height 4;
- grid actor (not rail).

From `generated/move_codes.txt`, `MOVE_CODE_COMM_ACTOR` is the slot immediately after `MOVE_CODE_WALK_RANDOM_LEFT_RIGHT_BUMP`; counting from `MOVE_CODE_NONE = 0` places it at `0x44`.

`field_actor_movedata.c` maps this move code to:

- `FieldCommActor_MoveInit`
- `FieldCommActor_Move`
- `FieldCommActor_MoveDelete`
- normal move-code return handler

### Native remote-player setup

After creation, White 2's `FieldCommActor_Add` performs:

1. stores pointers to direction, position, hidden state, and the communication entry in the actor's position work block;
2. sets actor world position/facing;
3. disables height calculation;
4. disables map attributes;
5. sets actor flag `0x20`;
6. disables collision;
7. enables ignore-disable-all;
8. disables movement-bit terrain effects.

### Native remote-player movement

`FieldCommActor_Move` each frame:

- reads remote direction;
- updates face direction;
- reads remote world position;
- moves actor to that position;
- sets draw status to stopped/walking/running depending movement distance;
- handles hero/heroine running specifically;
- reads hidden state and calls `SetActorHidden`.

This is conceptually almost identical to PokéRun's desired remote-controlled other-trainer system.

Long-term architecture should strongly consider adapting this native path rather than maintaining a detached generic actor and manually replaying billboard frames.

## Actor System / BLAct Path

Known live structure path:

| Structure / offset | Meaning |
| --- | --- |
| ActorSystem `+0x28` | Field billboard actor wrapper |
| wrapper `+0x04` | `BillboardActorSys` |
| `BillboardActorSys +0x04` | scene |
| `BillboardActorSys +0x18` | handle array |
| `BillboardActorSys +0x1C` | handle count |
| scene `+0x08` | `BillboardActor` array |
| scene `+0x0E` | configured actor count |

Known sizes in current White 2 layout:

- `BillboardActor`: `0x1C`
- `BillboardActorHandle`: `0x28`

## BillboardActor

The decomp defines BLAct as `BillboardActor`:

| Offset | Field |
| --- | --- |
| `+0x00` | material (14 bits) + billboard type (2 bits) |
| `+0x04` | `VecFx32` position |
| `+0x10` | face index |
| `+0x12` | scale X |
| `+0x14` | scale Y |
| `+0x16` | rotation |
| `+0x18` | packed alpha/polygon/visible/flip/light bits |

Stable map-427 capture:

- P1 material: `13`
- P2 material: `13`

## BillboardActorHandle

Exact handle layout from the decomp:

| Offset | Field |
| --- | --- |
| `+0x00` | scene actor index |
| `+0x04` | texMat index |
| `+0x08` | animation-table pointer |
| `+0x0C` | animation count |
| `+0x0E` | current animation |
| `+0x10` | animation step |
| `+0x12` | wait |
| `+0x14` | loop state |
| `+0x18` | animate BOOL |
| `+0x1C` | last animation command |
| `+0x20` | callback |
| `+0x24` | callback data |

Important correction: the previously observed shared pointer at handle `+0x24` is callback data, not a model-manager pointer.

Stable capture:

### P1

- handle `0x0226919C`
- scene actor `9`
- texMat `13`
- animation table `0x021CF13C`
- animation count `48`
- current animation `1`

### P2

- handle `0x022691C4`
- scene actor `10`
- texMat `13`
- animation table `0x021CF13C`
- animation count `48`
- current animation `0`

The animation difference can explain pose selection, not a wholly different trainer texture.

## Billboard Material Loading

`field_actor_billboard.c` shows that field billboard materials are cached by object code.

Important behavior:

- `FieldActorConfig.uid` is used as the object-code key for pending/material cache entries;
- the material is loaded from the resource group in the actor config;
- actors sharing the same cached object code can reuse the same billboard material;
- `FldAct_SwapObjCode` updates actor billboard information and handles asynchronous material replacement/deletion.

Because P1 and P2 both report object code/config 240 and both actual scene material 13, a visibly unrelated orange sprite is difficult to reconcile with BLAct 10 truly being the orange figure. This is why actor/billboard identity is now the next research target.

## Native Functions Used / Identified

Current exact White 2 US addresses used by PokéRun include:

| Function | Address |
| --- | --- |
| Find field actor | `0x02167A54` |
| Create actor | `0x021668B4` |
| Delete actor | `0x02166980` |
| Set actor hidden | `0x02167574` |
| Get BLAct index | `0x02167240` |
| Set height-calc disabled | `0x0216767C` |
| Set actor flag 32 | `0x021676B0` |
| Set shadow group | `0x0216784C` |
| Set force-off shadow | `0x0216787C` |
| GFL TCB manager add task | `0x0203A640` |
| GFL TCB remove | `0x0203A6D4` |

Additional field-communication helper addresses should be taken from the same White 2 US symbol map before implementation.

## Remote Actor Test UID

PokéRun currently uses temporary development UID:

- `0x7F01`

Real local player UID:

- `0x00FF`

White 2's own communication-actor template uses:

- `0x00FC`

## Stable Resource-Graph Observation

Even while the injected actor appears orange on screen, P1 and P2 match on:

- object code `240` (`OBJ_CODE_HEROINE`);
- embedded `FieldActorConfig`;
- move-code vtable after Probe 2;
- scene-node vtable `0x021CF974`;
- actual billboard scene material `13`;
- texMat `13`;
- animation table `0x021CF13C`;
- dumped animation table contents.

This means the next required proof is identity: verify which allocated FieldActor/BLAct actually owns the visible orange pixels.

## Probe 2: moveCode 2 -> 0

Original PokéRun remote actor used move code `2`.

Controlled experiment changed only that to `MOVE_CODE_NONE (0)`.

Result:

- P2 remained orange;
- P2 move-code vtable became identical to P1 (`0x021CC5D0`).

Conclusion: generic move code 2 was not the cause.

## Probe 3: Actor/Billboard Census

PokéRun commit `aa5e613` adds a read-only census of every allocated actor and resolved billboard.

It records:

- actor identity and state;
- model and move code;
- flags;
- grid/world position;
- TCB and vtables;
- BLAct index/address;
- actual scene material/type;
- BLAct position/face/render flags;
- texMat and animation state.

Goal: determine whether BLAct 10 is truly the visible orange figure or whether another actor/billboard is overlapping or being mistaken for the remote actor.

## Static Map / Transition Research

PokéRun has already extracted/decoded substantial White 2 static field data:

- map/zone relationships;
- native warp data;
- destination resolution;
- static transition/boundary triggers.

Current startup logs report 182 static boundary triggers loaded.

Door/transition implementation is intentionally paused while remote actor rendering is reverse-engineered.

## Research Rules

Prefer:

- decomp/source confirmation before guessing unknown offsets;
- read-only dumps;
- exact before/after snapshots;
- one-variable experiments;
- White 2's own native actor systems when available;
- recording falsified hypotheses.

Avoid:

- copying arbitrary P1 pointers directly into P2;
- changing multiple unknown actor fields at once;
- conflating the second emulator's real player with the injected remote actor;
- resuming higher-level transition polish before actor/resource identity is understood.
