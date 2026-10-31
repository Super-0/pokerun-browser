# PokéRun Multiplayer State

Last updated: 2026-10-30
Branch: `mp/map-transition-recovery-v2`

## Purpose

Canonical handoff for the current White 2 multiplayer implementation and reverse-engineering state. New chats should read this file and `docs/WHITE2_RESEARCH.md` before proposing changes.

## CURRENT HARNESS — IMPORTANT

The debugging setup has **ONE real White 2 emulator/game/tab** plus a **headless fake P2 peer**.

- P1 is the real local White 2 player.
- fake P2 publishes normal multiplayer remote state through PokéRun's protocol path.
- White 2 renders a native FieldActor representing fake P2.

There is no second Player 2 emulator/tab in this harness.

## Major architecture result

White 2 already contains `field_comm_actor.c`, its own system for other players' overworld actors.

Native communication actors use:

- UID `0xFC`;
- `MOVE_CODE_COMM_ACTOR = 0x44`;
- an attached native updater TCB;
- live pointers to direction, world position, hidden state, and a comm entry;
- native facing, movement draw status, billboard animation, and visibility handling.

PokéRun has now proven this path works end-to-end with the fake multiplayer peer.

## Resolved orange-model bug

The orange sprite was a native Youngster (model 11) occupying the exact same coordinates as the injected heroine. The remote heroine resource path was correct.

## Probe history

### Probe 1 — resource graph

P1 and the injected heroine matched on object code 240, FieldActorConfig, material 13, texMat 13, scene-node family, and animation table.

### Probe 2 — moveCode 2 -> 0

Changing the old custom actor moveCode did not change the orange sprite. Hypothesis falsified.

A local uncommitted `moveCode = 0` edit may still exist in `White2NativeActor.ts`; do not assume GitHub contains it.

### Probe 3 — actor/billboard census

Commit `aa5e613`.

Found the Youngster and heroine as separate actors stacked at the same position.

### Probe 4 — native comm parity

The old custom remote matched essentially none of White 2's native communication-actor setup. It was a generic actor with its updater detached and manually driven by PokéRun.

### Probe 5 — native comm code residency

Commit `01d29ab`.

Verified White 2's communication functions are resident on ordinary map 427 and the live move-code table at `0x021CC418` matches the decomp.

### Probe 6 — comm-system lifetime

Commit `5a6539f`.

`FldCommActSys_Create` and `FldCommActSys_Free` both worked against the live field actor system.

Result: `allocatorLifetimeValidated = true`.

### Probe 7 — native comm actor control — PASS

Commit `bef6964`.

Created a hidden actor through `FldCommActSys_CreateActor` and changed only its backing state. White 2 itself consumed position and direction, changed facing, produced movement draw state, kept the native updater attached, and cleaned up safely.

Result: `nativeCommActorControlValidated = true`.

### Probe 8 — visible native comm renderer — EFFECTIVE PASS

A visible temporary native comm heroine successfully:

- bound heroine material 13;
- rendered visibly;
- reached streamed target positions;
- turned its billboard renderer when backing direction changed;
- hid when backing hidden changed;
- deleted/freed safely.

The only false check was a transient movement-animation sample taken too late; Probe 7 had already observed native movement drawStatus 10.

### Probe 9 — live fake-peer mirror — FULL PASS

The native comm heroine was driven from the actual fake-P2 multiplayer presence stream for 15 seconds.

Observed:

- 242 backing-state writes;
- 80 distinct remote positions;
- native movement draw status observed;
- final actor position exactly matched the final expected position;
- final direction exactly matched;
- native updater remained attached;
- cleanup succeeded.

Results:

- `liveFakePeerToNativeCommValidated = true`
- `userMovementObserved = true`

This proves the full chain:

`fake P2 controls -> GAME_STATE -> multiplayerPresence -> native backing state -> White 2 FieldCommActor`.

### Probe 10 — actual DEV P2 cutover — CURRENT

Probe 10 replaces the old detached/manual remote actor **only in DEV**.

Current DEV path:

1. fake P2 publishes ordinary multiplayer state;
2. `White2NativeCommCutoverRuntime` allocates a persistent `FldCommActSys`;
3. it creates the actual visible P2 through `FldCommActSys_CreateActor`;
4. PokéRun writes only direction/position/hidden backing state;
5. White 2 owns the actor updater, facing, draw status, billboard animation, and visibility.

The old `White2DedicatedTrainerRuntime` remains the non-DEV fallback and is not mounted during Probe 10.

Probe 9's research panel is retired so no duplicate mirror actor is created.

Important log markers:

- `[PokéRun lifecycle] NATIVE COMM CUTOVER READY`
- `[PokéRun resdiag] NATIVE COMM CUTOVER STATUS`
- `[PokéRun lifecycle] NATIVE COMM CUTOVER CLEANUP`

A healthy status should show:

- UID `0xFC`;
- moveCode `0x44`;
- move-code vtable `0x021CC418`;
- nonzero native TCB;
- actor position/facing following fake P2;
- `healthy: true`;
- movement draw status observed after moving fake P2.

## Current test scope

For the first Probe-10 run, stay on the current map and test ordinary movement/turning only. Do not deliberately enter doors or change maps yet. Map-transition lifecycle integration comes after the same-map cutover is proven stable.

## Guardrails

Avoid unrelated changes to the network protocol, fake-peer packet semantics, doors, or map transitions while validating Probe 10.

Prefer one-variable native/decomp-backed experiments and explicit cleanup.

## New chat handoff

Use:

> Continue PokéRun multiplayer. First read `docs/POKERUN_MULTIPLAYER_STATE.md` and `docs/WHITE2_RESEARCH.md` on branch `mp/map-transition-recovery-v2`. The harness has ONE real White 2 emulator plus a headless fake P2 peer. Probe 9 fully validated the live fake-peer -> native FieldCommActor chain; Probe 10 is the current DEV cutover where the actual fake P2 uses the native comm runtime.
