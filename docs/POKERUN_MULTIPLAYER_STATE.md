# PokéRun Multiplayer State

Last updated: 2026-10-30
Branch: `mp/map-transition-recovery-v2`

## Purpose

This file is the canonical handoff for the current multiplayer implementation/debugging state. New chats should read this file before making implementation decisions.

## Architecture

PokéRun multiplayer currently uses two independent Pokémon White 2 emulator/game instances.

Each instance contains:

- the real local White 2 player actor;
- one PokéRun-created native `FieldActor` that visually represents the remote human player;
- state transport that broadcasts the real local player's map/position/facing/movement state to the other instance;
- PokéRun-owned control of the injected remote actor's position, facing, animation playback, visibility, and transition behavior.

The remote representation is therefore not the second emulator itself. It is a dedicated native White 2 actor inside the current local game.

### Current PokéRun remote actor lifecycle

1. Read the local White 2 player and current field actor system.
2. Build a `ZoneNPC` payload for the remote actor.
3. Create the actor through White 2's own field scheduler so normal resource loading/scheduler machinery runs.
4. Create it hidden to avoid exposing bootstrap frames.
5. Use PokéRun test UID `0x7F01`.
6. Detach the actor's native update TCB so PokéRun can drive it remotely.
7. Rebind/swap the actor to the remote trainer object code using White 2's native resource path.
8. Drive position/facing/animation/visibility from remote player state.

This is the CURRENT PokéRun implementation, not necessarily the final design.

## Major White 2 Decomp Discovery

A public White 2 decomp/reconstruction (`fuddlesworth/pokebw2`) contains the exact functions/structs being reverse-engineered, including the same White 2 US addresses PokéRun already uses.

Most importantly, White 2 already contains `src/ov036/field_comm_actor.c`, explicitly described as:

> The actors of the other players in a field communication.

White 2's native remote-player system:

- creates a normal `FieldActor` for each remote player;
- supplies that player's hero/heroine object code directly as `modelId`;
- uses `MOVE_CODE_COMM_ACTOR`;
- stores pointers to live direction, world position, hidden state, and a communication entry in the actor's position work block;
- lets White 2's own movement callback set facing, position, walking/running draw status, and visibility;
- configures the actor with height calculation disabled, map attributes disabled, collision disabled, persistence flag enabled, ignore-disable-all enabled, and movement-bit terrain effects disabled.

This is extremely close to PokéRun's intended architecture. Future implementation should strongly consider adapting White 2's own field-communication actor path instead of permanently maintaining a detached generic actor plus manual billboard playback.

Do not immediately rewrite to this architecture while the current orange-model investigation is in progress; use it as the primary reference for controlled experiments.

## Current Branch / Local State

Important remote commits:

- `4868fc5` — read-only P1/P2 render resource graph probe
- `aa5e613` — read-only census of every active FieldActor and billboard

The developer currently has one local, uncommitted experimental edit in `src/multiplayer/games/White2NativeActor.ts`:

- `ZoneNPC.moveCode` changed from `2` to `0` for Probe 2.

Do not assume that local experiment exists on GitHub until explicitly committed.

## Proven Working Pieces

- Two independent White 2 instances can exchange multiplayer presence/state.
- PokéRun can locate White 2's field actor system and player actor.
- Native remote `FieldActor` creation works.
- Native actor creation can be scheduled safely through White 2's field scheduler.
- The remote actor can be created hidden.
- The remote actor receives UID `0x7F01`.
- The remote actor can be found and deleted/reacquired by PokéRun.
- The remote actor's native updater TCB can be detached.
- PokéRun can directly drive the remote actor's world position.
- PokéRun can resolve the actor's scene node, BLAct index, BLAct, renderer handle, and animation table.
- Static White 2 map/warp/boundary extraction is already substantially complete for future transition work.

## Current Blocking Bug: Orange Remote Trainer

The injected remote `FieldActor` visibly renders as an orange/Hugh-like trainer even when its reported trainer/render identity matches the real protagonist.

The test condition is:

- P1: visibly correct protagonist;
- injected remote P2: visibly orange trainer;
- both stationary;
- same map.

Implementation work on doors/transitions remains paused until this contradiction is understood.

## Probe 1 Results: Resource Graph

Stable orange-P2 capture:

### Local P1

- actor: `0x0223E1E4`
- UID: `0x00FF`
- modelId: `240` (`OBJ_CODE_HEROINE`)
- TCB: `0x0230A104`
- scene-node vtable: `0x021CF974`
- BLAct index: `9`
- BLAct: `0x02268094`
- renderer handle: `0x0226919C`
- material / texMat: `13`
- animation table: `0x021CF13C`

### Remote P2

- actor: `0x0223E3E4`
- UID: `0x7F01`
- modelId: `240` (`OBJ_CODE_HEROINE`)
- TCB: `0x00000000` after PokéRun detaches it
- scene-node vtable: `0x021CF974`
- BLAct index: `10`
- BLAct: `0x022680B0`
- renderer handle: `0x022691C4`
- material / texMat: `13`
- animation table: `0x021CF13C`

The actor's embedded `FieldActorConfig` (`+0xE4` onward) is also byte-for-byte identical between P1 and P2.

### Probe 1 conclusion

The visible orange-vs-protagonist difference is NOT explained by any of the following alone:

- object/model code;
- `FieldActorConfig`;
- scene-node vtable;
- BLAct material;
- BLAct geometry/material flags;
- renderer texMat;
- animation table pointer;
- animation table contents;
- White 2's native object-code resource swap.

## Probe 2 Results: moveCode 2 -> 0

Hypothesis: the remote actor's previous move code `2` selected a different actor family.

Experiment:

- changed only remote `ZoneNPC.moveCode` from `2` to `0`;
- fresh remote spawn;
- no movement before capture.

Result:

- P2 is still orange;
- P1 and P2 now both use move-code vtable `0x021CC5D0`;
- model/config/material/animation state still matches.

Therefore generic move code `2` was not the cause.

## Billboard Struct Reality

The decomp identifies the structures PokéRun had inferred:

- BLAct is `BillboardActor`;
- the handle is `BillboardActorHandle`;
- handle `+0x04` is `texMat`;
- handle `+0x08` is the animation-table pointer;
- handle `+0x0C/+0x0E` are animation count/current animation;
- BLAct `+0x00` contains the actual scene material and billboard type.

P1 and P2 both use scene material `13` and texMat `13` while the screenshot still appears different.

This creates a strong identity question: either the visible orange sprite is not the BLAct currently attributed to P2, another actor overlaps it, or some lower-level state not yet captured changes the pixels despite the same scene material.

## Probe 3: Actor/Billboard Census

Commit `aa5e613` adds a read-only census emitted as:

`[PokéRun resdiag] ACTOR/BILLBOARD CENSUS`

For every allocated FieldActor owned by the active actor system it records:

- slot/address/state;
- UID/zone/model/move code;
- actor and movement flags;
- grid/world position;
- TCB and vtables;
- BLAct index/address;
- actual scene material/type;
- BLAct world position;
- face and packed render flags;
- texMat and animation state.

Purpose: identify which actual actor/billboard owns the visible orange sprite and detect overlapping/misidentified actors before more renderer writes are attempted.

## Current Research Direction

1. Run Probe 3 without moving either player.
2. Compare the orange sprite's world position against every active BLAct.
3. Establish whether BLAct 10 is truly the orange figure.
4. If identity is confirmed, use White 2's decomp to trace material/palette/resource state below the current diagnostics.
5. If identity is not confirmed, fix actor/billboard ownership before touching resource logic.
6. In parallel, continue studying White 2's native `field_comm_actor.c` as the likely long-term remote-player architecture.

## Guardrails

Until the orange-model identity is understood, avoid unrelated changes to:

- network protocol;
- movement smoothing;
- map transition implementation;
- door behavior;
- render-profile cache design;
- random P1-to-P2 pointer copying.

Prefer read-only probes and one-variable experiments.

## New Chat Handoff

Start future chats with:

> Continue PokéRun multiplayer. First read `docs/POKERUN_MULTIPLAYER_STATE.md` and `docs/WHITE2_RESEARCH.md` on branch `mp/map-transition-recovery-v2`. Treat those files and the current Git branch as canonical before proposing changes.
