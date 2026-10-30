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

### Current remote actor lifecycle

1. Read the local White 2 player and current field actor system.
2. Build a `ZoneNPC` payload for the remote actor.
3. Create the actor through White 2's own field scheduler so normal resource loading/scheduler machinery runs.
4. Create it hidden to avoid exposing bootstrap frames.
5. Use PokéRun test UID `0x7F01`.
6. Detach the actor's native update TCB so PokéRun can drive it remotely.
7. Rebind/swap the actor to the remote trainer object code using White 2's native resource path.
8. Drive position/facing/animation/visibility from remote player state.

## Current branch / known code state

Remote branch head before the current local experiment:

- `4868fc5` — `Add read-only White 2 render resource graph probe`

Important: the developer currently has one local, uncommitted experimental edit in `src/multiplayer/games/White2NativeActor.ts`:

- `ZoneNPC.moveCode` changed from `2` to `0` for Probe 2.

Do not assume that local experiment exists on GitHub until it is explicitly committed.

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

The injected remote `FieldActor` still visibly renders as an orange/Hugh-like trainer even when its reported trainer/render identity matches the real protagonist.

The screenshot test condition is:

- P1: visibly correct protagonist;
- P2 remote actor: visibly orange trainer;
- both stationary;
- same map.

This is currently the highest-priority reverse-engineering problem. Implementation work on doors/transitions is paused until the actual visual identity path is understood.

## Probe 1 Results: Resource Graph

Read-only probe added in commit `4868fc5`.

A stable orange-P2 capture showed:

### Local P1

- actor: `0x0223E1E4`
- UID: `0x00FF`
- modelId: `240`
- TCB: `0x0230A104`
- scene-node vtable: `0x021CF974`
- BLAct index: `9`
- BLAct: `0x02268094`
- renderer handle: `0x0226919C`
- matEntry: `13`
- anim table: `0x021CF13C`

### Remote P2

- actor: `0x0223E3E4`
- UID: `0x7F01`
- modelId: `240`
- TCB: `0x00000000` after PokéRun detaches it
- scene-node vtable: `0x021CF974`
- BLAct index: `10`
- BLAct: `0x022680B0`
- renderer handle: `0x022691C4`
- matEntry: `13`
- anim table: `0x021CF13C`

### Important Probe 1 conclusion

The visible orange-vs-protagonist difference is NOT explained by any of the following alone:

- `modelId`
- `matEntry`
- BLAct geometry flags
- BLAct material flags
- scene-node vtable
- renderer animation-table pointer
- the animation-table contents dumped by the probe
- use of White 2's native object-code resource swap

P1 and P2 can match at all of those layers while still visibly rendering differently.

## Probe 2 Results: moveCode 2 -> 0

Hypothesis: the remote actor was originally created with `ZoneNPC.moveCode = 2`, giving it a different movement-code vtable from the real player. Perhaps that move family selected hidden visual state.

Experiment:

- changed only remote `ZoneNPC.moveCode` from `2` to `0`;
- fresh remote spawn;
- no movement before capture.

Result:

- P2 is still orange.
- P2 now has the SAME move-code vtable as P1: `0x021CC5D0`.
- P2 modelId is still `240`.
- P2 scene-node vtable is still `0x021CF974`.
- P2 matEntry is still `13`.
- P2 anim table is still `0x021CF13C`.

Therefore move code is NOT the cause of the orange trainer identity.

## Remaining Notable Differences After Probe 2

The largest known differences that remain are ordinary actor/runtime state plus one renderer-handle word:

### FieldActor

Expected differences include:

- flags/state in the early actor header;
- UID (`0x00FF` vs `0x7F01`);
- coordinates;
- local player TCB present vs remote TCB detached;
- BLAct index (`9` vs `10`);
- other player-vs-NPC state bytes.

After Probe 2, the move-code vtable difference is gone.

### Renderer handle

The only non-index handle difference in the stable comparison is at `handle + 0x0C`:

- P1: `0x00010030`
- P2: `0x00000030`

Known code defines:

- `HANDLE_ANIM_COUNT = 0x0C`
- `HANDLE_ANIM = 0x0E`

Interpreted as two u16 fields, both have animation count `0x0030` (48), while P1 has current animation index `1` and P2 has current animation index `0`.

This may explain pose/frame selection but is not yet proven to explain the completely different orange character art.

## Current Research Direction

Do not resume door/transition implementation yet.

The next reverse-engineering work should determine where the actual per-actor character/texture/palette/model resource selection lives, because the currently mapped BLAct/handle animation path is insufficient to explain the pixels on screen.

Promising targets:

1. Inspect the global field-model/model-manager object referenced by the shared renderer structures (the observed data contains the ASCII prefix `fldmmdl_`).
2. Trace the native object-code swap/resource loader to identify which per-actor object stores character/texture/palette resource identity.
3. Determine whether `matEntry=13` is only a material-table slot while another per-actor selector chooses the actual resource family.
4. Verify whether the orange sprite is truly the injected P2 actor by performing a controlled visibility/position identity test before writing more renderer state.

## Guardrails

Until the orange-model identity is understood, avoid unrelated changes to:

- network protocol;
- movement smoothing;
- map transition implementation;
- door behavior;
- render-profile cache design;
- actor creation architecture;
- random P1-to-P2 pointer copying.

Prefer read-only probes and one-variable experiments.

## New Chat Handoff

Start future chats with:

> Continue PokéRun multiplayer. First read `docs/POKERUN_MULTIPLAYER_STATE.md` and `docs/WHITE2_RESEARCH.md` on branch `mp/map-transition-recovery-v2`. Treat those files and the current Git branch as canonical before proposing changes.
