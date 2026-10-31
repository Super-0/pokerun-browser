# PokéRun Multiplayer State

Last updated: 2026-10-30
Branch: `mp/map-transition-recovery-v2`

## Purpose

Canonical handoff for the current White 2 multiplayer implementation and reverse-engineering state. New chats should read this file and `docs/WHITE2_RESEARCH.md` before proposing changes.

## CURRENT HARNESS — IMPORTANT

The current debugging setup has **ONE real White 2 emulator/game/tab** plus a **headless fake P2 peer**.

Inside the one real White 2 instance:

- P1 is the real local White 2 player.
- fake P2 publishes normal multiplayer remote state through PokéRun's protocol path.
- a native White 2 `FieldActor` represents fake P2 in the real game.

There is no separate Player 2 emulator/tab in this harness.

## Current production-ish remote actor path

The existing PokéRun runtime still uses the older custom path:

1. receive fake-P2 state;
2. build a `ZoneNPC`;
3. create a native FieldActor through White 2's scheduler;
4. use test UID `0x7F01`;
5. create hidden, then bind heroine resources;
6. detach the actor's native TCB updater;
7. PokéRun manually drives world position/facing/animation/visibility.

This path works, but research now shows it is probably unnecessarily complicated.

## Major native White 2 discovery

White 2 already contains `src/ov036/field_comm_actor.c`, explicitly for:

> The actors of the other players in a field communication.

The native system creates remote hero/heroine FieldActors using:

- UID `0xFC`;
- `MOVE_CODE_COMM_ACTOR = 0x44`;
- a live native updater TCB;
- persistent pointers to direction, `VecFx32` position, hidden state, and a comm entry;
- collision disabled;
- height calculation disabled;
- map attributes disabled;
- persistent actor flag enabled;
- ignore-disable-all enabled;
- terrain/move-bit effects disabled.

`FieldCommActor_Move` reads those pointers every frame and performs facing, position, stopped/walk/run draw status, and visibility itself.

## RESOLVED: Orange-model bug

The orange character was not the injected remote model.

Probe 3 found two actors at the exact same coordinates:

- native map Youngster: UID `1`, model `11`, material `6`;
- PokéRun remote heroine: UID `0x7F01`, model `240`, material `13`.

Moving fake P2 exposed the heroine underneath while the Youngster stayed put. Renderer/model binding was correct.

## Probe history

### Probe 1 — resource graph

P1 and PokéRun remote matched on heroine resource identity:

- model `240` (`OBJ_CODE_HEROINE`);
- same embedded `FieldActorConfig`;
- same scene-node vtable;
- material / texMat `13`;
- same animation table `0x021CF13C`.

The apparent visual mismatch was later explained by the overlapping Youngster.

### Probe 2 — moveCode 2 -> 0

Changing only the custom remote's moveCode from `2` to `0` made its move-code vtable match P1, but the apparent orange figure remained.

Conclusion: move code was not the model problem. The orange figure was a different actor.

The developer may still have this Probe-2 edit locally and uncommitted in `White2NativeActor.ts`; do not assume GitHub contains it.

### Probe 3 — actor/billboard census

Commit `aa5e613`.

Resolved the orange-model mystery by identifying the overlapping Youngster and heroine as separate actors.

### Probe 4 — native comm parity

Compared the current custom remote actor with White 2's native communication actor recipe.

Result: current custom remote matched essentially none of the native-comm-specific setup. It is a generic FieldActor with its updater detached and manually controlled by PokéRun.

### Probe 5 — overlay/native symbol residency

Commit `01d29ab`.

Verified on normal map 427 that White 2's native communication functions are resident and callable, and that the live `MOVE_CODE_COMM_ACTOR` table at `0x021CC418` matches the decomp.

Key functions validated resident:

- `FldCommActSys_Create` `0x0218AE78`
- `FldCommActSys_CreateActor` `0x0218AEF4`
- `FieldCommActor_Add` `0x0218AFFC`
- `FieldCommActor_MoveInit` `0x0218B084`
- `FieldCommActor_MoveDelete` `0x0218B090`
- `FieldCommActor_Move` `0x0218B0A0`
- `FieldCommActor_SetMoveWork` `0x0218B150`

### Probe 6 — native comm system lifetime

Commit `5a6539f`.

Successfully called `FldCommActSys_Create(count=1)` against the live actor system, verified structure layout and zeroed entry state, then freed it normally.

Result: `allocatorLifetimeValidated = true`.

### Probe 7 — native comm actor control — SUCCESS

Commit `bef6964`.

This is the major architecture result.

A temporary hidden actor was created through White 2's actual `FldCommActSys_CreateActor` path while the existing custom fake-P2 actor remained untouched.

Observed native actor:

- UID `0xFC`;
- model `240` heroine;
- moveCode `0x44`;
- move-code vtable `0x021CC418`;
- native updater TCB remained attached;
- native comm flags all present;
- position work block held the four expected live pointers.

PokéRun changed only the backing remote-state memory.

White 2 itself then:

- consumed the initial position;
- moved the actor when the backing `VecFx32` changed;
- set draw status `10` for the large move;
- changed actor facing when only the backing direction value changed.

Every Probe-7 check passed:

- native identity;
- model identity;
- native updater attached;
- persistence/collision/height/map flags;
- ignore-disable-all / terrain-effect flags;
- work pointers;
- initial position consumption;
- native movement consumption;
- native direction consumption.

Cleanup succeeded: actor deletion and comm-system free both returned normally.

**Conclusion:** PokéRun has proven it can feed remote state to White 2's built-in multiplayer actor path and let White 2 own the remote actor's native movement/facing lifecycle.

### Probe 8 — visible native comm renderer test — CURRENT

Current branch HEAD includes:

- `5bbcfd5` — visible native communication actor probe
- `a57fae6` — route research panel to Probe 8

Probe 8 keeps the existing custom fake-P2 actor untouched and creates a second, temporary native comm heroine nearby with `hidden = 0`.

It is designed to prove the visible side of the native path:

1. native heroine billboard binds;
2. native comm actor is visible;
3. PokéRun streams small position changes only into the backing state;
4. White 2 drives movement/draw animation state;
5. backing direction change drives facing;
6. backing hidden change drives visibility;
7. actor and comm system are deleted/freed safely.

Expected log marker:

`[PokéRun resdiag] NATIVE COMM VISUAL CONTROL`

Success field:

`nativeCommVisualPathValidated: true`

## Current architecture direction

If Probe 8 succeeds, the likely next major implementation step is to replace the old detached generic fake-P2 actor with a persistent `FldCommActSys`-backed remote actor.

The intended architecture would become:

- keep existing network/fake-peer protocol;
- keep remote world-state production;
- store remote direction/position/hidden in a persistent native backing block;
- let White 2's own `FieldCommActor_Move` own position/facing/draw status/visibility;
- remove manual TCB detachment;
- remove manual billboard animation playback where no longer needed.

Do not jump straight to doors/transitions until this native actor replacement is proven stable.

## Guardrails

Avoid unrelated changes to:

- network protocol;
- fake-peer packet semantics;
- map transition implementation;
- door behavior;
- arbitrary renderer fields.

Prefer one-variable native/decomp-backed experiments and safe cleanup.

## New chat handoff

Use:

> Continue PokéRun multiplayer. First read `docs/POKERUN_MULTIPLAYER_STATE.md` and `docs/WHITE2_RESEARCH.md` on branch `mp/map-transition-recovery-v2`. The current harness has ONE real White 2 emulator plus a headless fake P2 peer. Probe 7 successfully proved White 2 native comm actor control; check the docs for the current probe before making changes.
