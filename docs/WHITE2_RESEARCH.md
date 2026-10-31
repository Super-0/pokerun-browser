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

The tested local player and PokéRun remote both use heroine `240`.

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

On ordinary map 427, Probe 5 verified the following overlay-36 functions are resident:

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

## Probe 6 — allocator/lifetime validation

A native `FldCommActSys` was created against the live actor system with count 1 and `allowRun=1`.

Observed:

- count = 1;
- allowRun = 1;
- actor-system pointer matched live MMSys;
- entries pointer was valid;
- first entry was zeroed;
- `FldCommActSys_Free` returned normally.

Conclusion: native comm-system allocator/lifetime is safe in the tested field context.

## Probe 7 — native comm actor control — VALIDATED

PokéRun created a temporary hidden actor through `FldCommActSys_CreateActor` while leaving the existing custom P2 actor untouched.

Observed actor:

- UID `252` / `0xFC`;
- model `240` heroine;
- moveCode `68` / `0x44`;
- move-code vtable `0x021CC418`;
- TCB `0x0230A13C` remained attached;
- flags `0x000006A7`;
- movement flags `0x00180802`;
- position work contained the exact four backing pointers.

All native-setup checks passed:

- persistent flag;
- collision disabled;
- height calculation disabled;
- map attributes disabled;
- ignore-disable-all;
- terrain effects disabled.

PokéRun then wrote only to the backing state:

1. changed backing position from x `3702784` to `3768320`;
2. White 2 moved the actor to the new x itself;
3. actor draw status became `10` for the large move;
4. changed backing direction from east (`3`) to west (`2`);
5. White 2 changed `faceDir` to `2` itself.

No direct actor position/facing write was used for those checks.

Result: `nativeCommActorControlValidated = true`.

Cleanup also passed: native actor deletion and comm-system free returned normally.

### Meaning

This proves PokéRun can use White 2's built-in multiplayer actor architecture instead of permanently detaching a generic NPC updater and manually replaying the remote trainer's renderer state.

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

The apparent orange remote character was actually a native Youngster occupying the exact same world position as the injected heroine.

Youngster:

- UID `1`
- model `11`
- material `6`

PokéRun custom heroine:

- UID `0x7F01`
- model `240`
- material `13`

Moving fake P2 separated the heroine from the stationary Youngster, visually confirming the diagnosis.

## Probe 8 — current visual native-comm test

Probe 8 creates a **visible** temporary native comm heroine near the current fake P2 and keeps the existing custom P2 actor untouched.

It validates:

- native billboard binding;
- heroine material binding;
- visible state;
- streamed backing-position movement;
- native movement/draw animation response;
- backing-direction facing response;
- backing-hidden visibility response;
- safe deletion/free.

Expected marker:

`[PokéRun resdiag] NATIVE COMM VISUAL CONTROL`

Expected success:

`nativeCommVisualPathValidated: true`

## Static map/transition research

White 2 static extraction already includes:

- map/zone relationships;
- native warp data;
- destination resolution;
- static transition/boundary triggers.

Startup currently reports 182 static boundary triggers.

Higher-level door/transition work remains intentionally paused while the native remote actor architecture is finalized.

## Research rules

Prefer:

- decomp confirmation before guessing offsets;
- one-variable experiments;
- exact before/after snapshots;
- native White 2 actor systems where available;
- safe scheduled calls and explicit cleanup;
- recording falsified hypotheses.

Avoid:

- copying arbitrary local-player pointers into remote actors;
- changing multiple unknown actor fields at once;
- assuming a second emulator exists in the current harness;
- building transition polish on top of the old detached-actor renderer before native comm integration is settled.
