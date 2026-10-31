# Pokémon White 2 Reverse-Engineering Notes

Last updated: 2026-10-30
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
| `+0x0C` | model/object code |
| `+0x0E` | moveCode |
| `+0x18` | face direction |
| `+0x2A` | draw status |
| `+0x3C` | grid position |
| `+0x44` | world `VecFx32` |
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

Moving fake P2 separated the heroine from the stationary Youngster, visually confirming the diagnosis.

## Current integration implication

The old design—generic actor creation, native TCB detachment, direct actor/billboard writes, and manual animation replay—is no longer necessary for ordinary same-map remote movement.

The proven native architecture is:

- persistent `FldCommActSys`;
- native comm actor with attached updater;
- PokéRun-owned backing values for direction, world position, and hidden state;
- White 2-owned movement, facing, draw status, billboard animation, and visibility.

Probe 10 is the first cutover where the actual DEV fake P2 uses that architecture instead of a second mirror actor.

## Static map/transition research

White 2 static extraction already includes:

- map/zone relationships;
- native warp data;
- destination resolution;
- static transition/boundary triggers.

Startup currently reports 182 static boundary triggers.

Door/transition integration should resume only after Probe 10 confirms the native comm actor is stable as the actual same-map remote P2.

## Research rules

Prefer decomp confirmation, one-variable experiments, exact snapshots, native White 2 systems, safe scheduled calls, and explicit cleanup.

Avoid copying arbitrary local-player pointers, changing multiple unknown actor fields at once, assuming a second emulator exists, or building transition polish on the old detached-actor architecture.
