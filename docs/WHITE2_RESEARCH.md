# Pokémon White 2 Reverse-Engineering Notes

Last updated: 2026-11-02
Target: Pokémon White 2 US (IRDO), exact-ROM-fingerprint gated by PokéRun code.

This file contains durable findings. Temporary experiment state belongs in `docs/POKERUN_MULTIPLAYER_STATE.md`.

## Harness context

Current tests use **one real White 2 emulator/game** plus a **headless fake P2 peer**. The fake peer feeds remote state through PokéRun's multiplayer path. Do not assume a second emulator/tab exists when interpreting current logs.

## Primary external reference

`fuddlesworth/pokebw2` reconstructs White 2 US structures/functions at addresses matching PokéRun's independent findings. Use it before guessing unknown offsets.

## FieldActor layout

Important live offsets:

| Offset | Field |
| --- | --- |
| `+0x00` | flags |
| `+0x04` | movementFlags |
| `+0x08` | UID |
| `+0x0A` | zoneId |
| `+0x0C` | model/object code |
| `+0x0E` | moveCode |
| `+0x18` | face direction |
| `+0x2A` | draw status |
| `+0x3C` | grid position |
| `+0x44` | world `VecFx32` |
| `+0x81` | shadow group |
| `+0x84` | native actor TCB |
| `+0x88` | actor-system backpointer |
| `+0x8C` | move-code vtable |
| `+0x90` | scene-node vtable |
| `+0x94` | position/rail work block |
| `+0xA4` | move-subprocess work |
| `+0xB4` | movement-command work |
| `+0xC4` | billboard work |
| `+0xE4` | embedded `FieldActorConfig` |

Actor stride in the tested heap is `0x100`.

## Object codes confirmed

- `OBJ_CODE_HERO = 231`
- `OBJ_CODE_HEROINE = 240`
- `OBJ_CODE_YOUNGSTER = 11`

The tested local player and PokéRun remote use heroine `240`.

## Native White 2 communication actors

`src/ov036/field_comm_actor.c` is explicitly White 2's system for other players' field actors.

Native template:

- UID `0xFC`
- supplied hero/heroine model
- `MOVE_CODE_COMM_ACTOR = 0x44`
- script `0x7D0`
- area 4x4
- grid actor

Native setup after creation:

1. store pointers to direction, position, hidden state, and `FldCommActEntry` in actor position work;
2. set initial world position/facing;
3. disable height calculation;
4. disable map attributes;
5. set persistent actor flag `0x20`;
6. disable collision;
7. enable ignore-disable-all;
8. disable movement-bit terrain effects.

Native `FieldCommActor_Move`:

- reads direction pointer;
- updates facing;
- reads `VecFx32` position pointer;
- moves actor to that value;
- sets stopped/walk/run draw status;
- treats hero/heroine large deltas as running;
- reads hidden pointer and calls `SetActorHidden`.

## Native comm structures

```c
struct FldCommActSys {
    u16 count;
    u16 allowRun;
    MMSys *actorSystem;
    FldCommActEntry *entries;
};

struct FldCommActEntry {
    u32 netId;
    u16 actorDeleted;
    u16 allowRun;
    FieldActor *actor;
};

struct FldCommActLink {
    const u16 *dir;
    const VecFx32 *pos;
    const u32 *hidden;
    FldCommActEntry *entry;
};
```

Observed live layout matches the decomp:

- comm system size `0x0C`;
- entry size `0x0C`;
- four work pointers stored at FieldActor `+0x94`.

## Native comm symbols validated resident

On ordinary map 427, the following overlay-36 functions are resident:

| Function | Address |
| --- | --- |
| `FldCommActSys_Create` | `0x0218AE78` |
| `FldCommActSys_Free` | `0x0218AEBC` |
| `FldCommActSys_CreateActor` | `0x0218AEF4` |
| `FldCommActSys_DeleteActor` | `0x0218AF48` |
| `FieldCommActor_Add` | `0x0218AFFC` |
| `FieldCommActor_MoveInit` | `0x0218B084` |
| `FieldCommActor_MoveDelete` | `0x0218B090` |
| `FieldCommActor_Move` | `0x0218B0A0` |
| `FieldCommActor_SetMoveWork` | `0x0218B150` |

The live move-code table at `0x021CC418` matches the decomp and points to the expected init/move/delete callbacks.

Other useful validated symbols:

| Function | Address |
| --- | --- |
| `FindFieldActor` | `0x02167A54` |
| `CreateNewActorByEntityNoWKOBJCODE` | `0x021668B4` |
| `DeleteActor` | `0x02166980` |
| billboard getter | `0x02167240` |
| `SetActorHidden` | `0x02167574` |
| `FldAct_SetHeightCalcDisabled` | `0x0216767C` |
| `FldAct_SetActorFlag32` | `0x021676B0` |
| `FldAct_SetShadowGroup` | `0x0216784C` |
| `FldAct_GetShadowGroup` | `0x02167864` |
| `FldAct_SetForceOffShadow` | `0x0216787C` |
| `FldAct_IsForceOffShadow` | `0x02167898` |
| `GetActorMovementFlags` | `0x02167024` |
| `SetActorMovementFlag` | `0x02167028` |
| `ClearActorMovementFlag` | `0x02167030` |
| GFL TCB manager add | `0x0203A640` |
| GFL TCB manager remove | `0x0203A6D4` |
| `FldAct_GetFieldEffects` | `0x02194F18` |
| `FldeffShadow_Start` | `0x021A3C30` |
| `FieldEffect_Shadow_Create` | `0x021A3B74` |
| `FieldEffect_Shadow_Free` | `0x021A3BC8` |
| `GameData_GetFieldStatus` | `0x020175B4` |
| `FieldStatus_GetBusyFlag` | `0x02019378` |

`FLD_STATUS_BUSY_LOADING = 2`.

## Native communication lifecycle

White 2's own communication-player lifecycle is the strongest guide for safe PokéRun behavior.

In `src/ov012/comm_player.c`:

- `CommPlayer_HideActors` deletes active communication actors, frees the `FldCommActSys`, and nulls the actor controller before the field closes;
- `CommPlayer_RestoreActors` creates a new `FldCommActSys` against the current field actor system and recreates players after the field is ready;
- `CommPlayer_GetMyStatus` checks `FieldStatus_GetBusyFlag(GameData_GetFieldStatus(gameData)) == FLD_STATUS_BUSY_LOADING`.

Therefore:

- real field loads/warps/buildings must delete/free remote communication actors before teardown;
- pointers to FieldActor, comm system, TCB manager, field effects, or billboard structures must not be carried across actual field teardown;
- a stable actorSystem address alone does **not** prove the field identity is unchanged.

Observed actorSystem `0x0223D968` remained the same across multiple map transitions while P1 actor addresses, TCB manager, field effects, and billboard resources changed.

## Native comm validation results

### Probe 6 — allocator/lifetime

`FldCommActSys_Create` and `FldCommActSys_Free` both returned normally against the live field actor system.

Result: `allocatorLifetimeValidated = true`.

### Probe 7 — hidden native actor control

A native comm heroine was created through `FldCommActSys_CreateActor` with UID `0xFC`, moveCode `0x44`, vtable `0x021CC418`, and a live updater TCB.

PokéRun modified only backing direction/position memory. White 2 itself consumed those values, moved the actor, changed facing, and produced movement drawStatus `10`.

Result: `nativeCommActorControlValidated = true`.

### Probe 8 — visible native renderer

A visible native comm heroine successfully:

- bound heroine material 13;
- remained visible with native animation enabled;
- reached streamed world positions;
- changed renderer face when backing direction changed;
- hid when backing hidden changed;
- deleted/freed safely.

The single false boolean was a transient animation sample taken after drawStatus had already returned to STOP. That does not contradict Probe 7, which directly observed the native movement draw state.

### Probe 9 — live multiplayer presence stream

The actual fake-P2 multiplayer stream drove a native comm heroine for 15 seconds.

Observed:

- 242 writes to native backing state;
- 80 distinct remote positions;
- native movement draw status observed;
- final world position exactly matched expected;
- final face direction exactly matched expected;
- native updater stayed attached;
- cleanup succeeded.

Results:

- `liveFakePeerToNativeCommValidated = true`
- `userMovementObserved = true`

This proves the end-to-end chain:

`fake peer -> GAME_STATE -> multiplayerPresence -> native backing state -> FieldCommActor`.

## Native shadow behavior

`FieldCommActor_Add` disables the ordinary movement-bit terrain-effect path, so communication actors do not automatically receive the standard floor shadow.

PokéRun successfully starts White 2's native `FldeffShadow` task once for UID `0xFC` and sets movement flag `0x4000`. The shadow then follows P2 natively and is tied to the actor lifecycle.

## Billboard path

Known structure path:

| Structure / offset | Meaning |
| --- | --- |
| ActorSystem `+0x28` | Field billboard wrapper |
| wrapper `+0x04` | BillboardActorSys |
| BillboardActorSys `+0x04` | scene |
| BillboardActorSys `+0x18` | handle array |
| BillboardActorSys `+0x1C` | handle count |
| scene `+0x08` | BillboardActor array |

Sizes:

- `BillboardActor = 0x1C`
- `BillboardActorHandle = 0x28`

Relevant handle fields:

| Offset | Field |
| --- | --- |
| `+0x00` | scene actor index |
| `+0x04` | texMat/material entry |
| `+0x08` | animation table |
| `+0x0C` | animation count |
| `+0x0E` | current animation |
| `+0x18` | animate BOOL |

Relevant BillboardActor fields:

| Offset | Field |
| --- | --- |
| `+0x00` | material/type |
| `+0x04` | world position |
| `+0x10` | face index |
| `+0x18` | packed visibility/alpha/etc flags |

## Resolved Youngster overlap

The apparent orange remote character was a native Youngster occupying the exact same world position as the injected heroine.

Youngster:

- UID `1`
- model `11`
- material `6`

PokéRun heroine:

- model `240`
- material `13`

The stale Youngster was persisted contamination, not a legitimate Aspertia event actor. It was removed once from the save with an exact-signature scrubber; the scrubber has since been removed.

## Current integration implication

The old design—generic actor creation, native TCB detachment, direct actor/billboard writes, and manual animation replay—is no longer necessary for ordinary same-map remote movement.

The proven native architecture is:

- persistent `FldCommActSys` while a field is valid;
- native comm actor with attached updater;
- PokéRun-owned backing values for direction, world position, and hidden state;
- White 2-owned movement, facing, draw status, billboard animation, and visibility;
- native shadow task attached to the remote actor.

## Door transitions versus seamless edges

White 2 exposes two fundamentally different transition classes that must not share lifecycle rules.

### Field-changing transitions

Doors, buildings, gates, and other warps can enter field loading and replace field resources.

For these transitions:

- use `FLD_STATUS_BUSY_LOADING = 2` as the authoritative pre-teardown signal;
- delete P2 and free the comm system before teardown;
- wait for the destination field to stabilize;
- recreate P2 only when local and remote map state rendezvous again.

Door visuals may be staged/polished, but the native actor lifecycle must still respect field teardown.

### True seamless map edges

A true seamless overworld edge changes the logical map/zone ID while leaving the live field intact.

The canonical proven pair is:

`437 <-> 439`

This corresponds to Route 19 <-> Floccesy Town.

Across this edge:

- P1 FieldActor stayed at `0x0223DFE4`;
- actorSystem stayed `0x0223D968`;
- the live billboard binding survived;
- no `FLD_STATUS_BUSY_LOADING` field teardown occurred;
- grid/world coordinates remained globally continuous;
- world-position deltas could be smaller than a full tile;
- map ID could flip before the next movement sample advanced, producing a valid zero-delta moving boundary sample.

Therefore a seamless edge should **preserve the same remote native communication actor** rather than deleting/recreating it.

PokéRun now latches a verified map pair while local and remote map IDs temporarily differ. During that latch the same FieldCommActor, comm system, TCB, shadow, and backing state stay alive until the players reunite or a real field load/different map pair invalidates the latch.

## Map-edge classifier findings

A map-ID change is classified as `kind: "map-edge"` only when the world/grid samples look continuous.

Current durable criteria:

- map IDs must differ;
- grid Manhattan distance must be `<= 1`;
- and either:
  - the world horizontal movement is nonzero, small (`<= 0x10000`), directionally consistent with the actor's movement direction, and within the vertical/axis slop; or
  - the boundary sample has zero grid/world delta, unchanged direction, and at least one side reports `movementState === "moving"`.

Observed constants in the current classifier:

- `MAP_EDGE_WORLD_MAX_STEP = 0x10000`
- `MAP_EDGE_WORLD_AXIS_SLOP = 0x1000`
- `MAP_EDGE_HEIGHT_SLOP = 0x10000`

The zero-delta case is necessary because White 2 can change the zone ID one sample before the movement sample advances.

Large coordinate jumps such as Aspertia City -> Aspertia Gate remain `unclassified` and correctly fall back to ordinary field/warp lifecycle handling.

## Static map/transition research

White 2 static extraction includes:

- map/zone headers;
- native warp data and resolved destinations;
- zone event metadata;
- map matrices;
- geometric same-matrix zone boundaries;
- directional tile-edge triggers.

The original matrix-only runtime registry contained **182 directional triggers**. That count represented same-matrix geometry, not guaranteed direct gameplay traversal.

### Important zone identities

Confirmed around the canonical test area:

- `427` = Aspertia City
- `438` = Aspertia Gate
- `437` = Route 19
- `439` = Floccesy Town

The apparent geometric `427 <-> 437` adjacency is **not** directly traversable in gameplay. Real traversal is:

`427 <-> 438 <-> 437`

The gate map has reciprocal native warps to both outdoor zones.

### Warp-bridge quarantine rule

`runtime-boundary-export.mjs` now combines matrix adjacency with the native warp graph.

For a geometric boundary `A <-> B`, if a third zone `G` forms a reciprocal native-warp bridge:

`A <-> G <-> B`

then the direct matrix boundary `A <-> B` is quarantined as `reason: "intermediate-warp-bridge"`.

The reciprocal requirement prevents unrelated one-way/script warps from suppressing an otherwise legitimate edge.

The exporter also quarantines matrix/header mismatches separately.

Current generated runtime registry after filtering:

- schema version `2`;
- `traversableOnly: true`;
- **140 traversable directional triggers**;
- **44 quarantined directional triggers** total;
- 42 quarantine entries are gate/tunnel warp bridges;
- 2 quarantine entries are matrix/header mismatches.

Known validation anchors:

- `427 <-> 437` must be quarantined via intermediate zone `438`;
- `437 <-> 439` must remain traversable.

The exporter fails if either anchor is violated.

This rule generalized beyond Aspertia and detected other gate/tunnel bridge structures, such as `446 <-> 448` via `447`.

### Runtime boundary semantics

The fake-P2 boundary normalizer loads only schema-v2 `traversableOnly` registries. Stale schema-v1 geometric-only registries are rejected.

Candidate logs now distinguish:

- usable traversable edges;
- quarantined geometric neighbors and their reason/intermediate zone.

Proven examples:

- map 427: zero usable candidates; `437 north` quarantined via `438`;
- map 437: usable `439 east` edge; `427 south` quarantined via `438`;
- pressing fake P2 north on the old map-427 geometric boundary does not emit `FAKE P2 MAP EDGE`;
- pressing fake P2 east at the real Route 19 boundary emits `FAKE P2 MAP EDGE 437 -> 439` and enters native actor preservation.

## Runtime boundary rebuild

After White 2 has already been extracted, the filtered runtime registry can be regenerated without rereading the ROM:

```bash
npm run white2:runtime-boundaries
```

Full extraction remains:

```bash
npm run white2:extract -- /path/to/PokemonWhite2.nds
```

## Known diagnostic noise

The DEV harness can occasionally log:

`Probe 10 timed out waiting for 1 emulated frames.`

When the surrounding native status continues to report `healthy: true`, treat this as an idle diagnostic timeout rather than evidence that the actor failed.

Cold startup can also briefly log invalid GameSystem/GameData pointers before White 2 has finished initializing.

## Research rules

Prefer decomp confirmation, one-variable experiments, exact snapshots, native White 2 systems, safe scheduled calls, and explicit cleanup.

Avoid:

- copying arbitrary local-player pointers;
- changing multiple unknown actor fields at once;
- assuming a second emulator exists;
- treating actorSystem alone as field identity;
- treating same-matrix geometry as proof of direct traversal;
- carrying native field pointers across real field teardown;
- rebuilding transition polish on the old detached-actor architecture.

For transition work, preserve the distinction:

- real field load/warp -> delete/free/recreate;
- verified seamless edge -> keep the same native communication actor alive.
