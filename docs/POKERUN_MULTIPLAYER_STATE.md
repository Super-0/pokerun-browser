# PokéRun Multiplayer State

Last updated: 2026-11-02
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

PokéRun has proven this path end-to-end with the fake multiplayer peer. The actual DEV P2 now uses a native FieldCommActor rather than the old detached/manual mirror actor.

## Resolved orange ghost actor

The orange sprite was not the remote trainer and was not a legitimate Aspertia City spawn.

It was a stale persisted actor with the exact signature:

- UID `1`;
- model `11` (Youngster);
- moveCode `2`;
- zone `0`;
- tile `(54, 713)`.

White 2's actual Aspertia event data does not define that actor. A one-time DEV scrubber deleted only that exact signature, the game was saved normally, and a full reload later logged `GHOST ACTOR SCRUBBER CLEAN`. The contaminated save entry is repaired. The temporary scrubber was then removed from the runtime.

The fake peer bootstrap was also corrected to start south of the host rather than one tile east, which had originally placed P2 directly on the ghost's tile.

## Native shadow result

White 2's native `FieldCommActor_Add` disables the movement-bit terrain-effect path, so a remote communication actor does not automatically receive the normal floor shadow.

PokéRun now starts White 2's native `FldeffShadow` task once for UID `0xFC` and sets the normal shadow-active movement bit `0x4000`. The shadow follows P2 natively and disappears with the actor.

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

### Probe 10 — actual DEV P2 cutover — PASS

Probe 10 replaced the old detached/manual remote actor **only in DEV**.

Validated same-map behavior:

- one persistent native P2 only;
- model `240`;
- UID `0xFC`;
- moveCode `0x44`;
- move-code vtable `0x021CC418`;
- attached native TCB;
- native movement/facing/animation;
- native shadow;
- correct fake-peer spawn;
- no clone leak.

Important fixes during Probe 10:

1. wait for normal player model `231/240` so temporary model `244` is never captured as P2's permanent model;
2. latch the gate so React cannot repeatedly remount and spawn duplicate heroines;
3. start White 2's native shadow task for P2;
4. repair and remove the stale orange ghost actor from the save.

### Probe 11 — P1 map transition lifecycle — FULL PASS

Commit `f0d8249` introduced a transition-aware native comm lifecycle gate based on White 2's own multiplayer pattern.

White 2's native `CommPlayer_HideActors` / `CommPlayer_RestoreActors` behavior was mirrored:

- detect `FLD_STATUS_BUSY_LOADING = 2` before field teardown;
- unmount the native P2 runtime while the old field is still valid;
- delete P2 through `FldCommActSys_DeleteActor`;
- free the old `FldCommActSys`;
- wait while the new field is unavailable/unstable;
- recreate P2 only when the new field is stable and P1/P2 are on the same map.

Validated with map `427 -> 433 -> 427`. Cleanup was safe before field destruction and P2 recreated once after the stable return.

### Probe 12 — fake P2 remote door enter/exit — FULL PASS

The existing `FakeRemoteDoorPeerPanel` captured a real P1 door transition and replayed it for fake P2.

Captured door:

- map `427` -> map `433`;
- exterior door tile `(59, 723)` facing north;
- interior destination `(6, 11)`;
- native door prop handle matched correctly.

Forward and reverse remote door transitions both passed. P2 is removed when maps diverge and recreated at the authoritative destination when the maps match again.

### Probe 13 — cross-map rendezvous — FULL PASS

The missing rendezvous matrix was validated:

1. P2 leaves P1's map;
2. P2 waits on another map;
3. P1 joins P2;
4. a native P2 is created at the remote authoritative position;
5. the native shadow is restored;
6. P2 continues moving normally;
7. P1 can leave first and P2 is safely destroyed again.

Important observed field identities:

- actorSystem remained `0x0223D968` across several maps, so actorSystem alone is **not** a field identity;
- outside map 427 P1 actor: `0x0223E1E4`;
- inside map 433 P1 actor: `0x0223DCE4`;
- outside TCB manager: `0x02309EEC`;
- inside TCB manager: `0x022FDDEC`;
- outside fieldEffects: `0x0230B768`;
- inside fieldEffects: `0x022FF668`.

### Probe 14 — remote arrival polish — FULL PASS

Door arrivals were changed from visible pop-in to staged native movement.

Final proven behavior:

- remote door transition is recognized while fresh;
- native P2 is created hidden at the doorway staging point;
- the actor begins native walking toward the authoritative destination;
- P2 is revealed on the first native walking frame (`drawStatus !== 0`), with a small fallback only if needed;
- the door opens before P2 becomes visibly established;
- P2 completes the step with correct position, shadow, facing, and health.

Representative successful reveal used `trigger: "native-walk-frame"`, `drawStatus: 3`, and occurred about 34 ms into the staged motion.

Door-arrival staging remains door-specific. Seamless map edges now use preservation instead of recreation.

### Probe 15 — remote departure presentation — FULL PASS

Remote door departures now present as a complete doorway traversal before the fake peer publishes the destination map.

Final sequence:

1. approach door;
2. keep P2 on the source map;
3. publish short departure intent;
4. walk one full world tile through the doorway over about 240 ms;
5. only after the actor is behind the doorway geometry, publish the destination map;
6. Probe 11 then performs the ordinary map-mismatch cleanup.

This removed the premature disappearance at the door while preserving safe lifecycle semantics.

### Probe 16 — seamless map edges — FULL PASS

Probe 16 established that seamless overworld boundaries are a fundamentally different lifecycle from doors, buildings, and gates.

#### Gate/tunnel discovery

A first candidate path from map 427 toward map 437 actually traversed:

`427 -> 438 -> 437`

and reverse:

`437 -> 438 -> 427`

Those transitions have huge grid/world jumps and field teardown/loading behavior. Map 438 is the Aspertia Gate. Therefore static matrix adjacency alone cannot prove direct gameplay traversal.

The relevant White 2 identities are:

- `427` = Aspertia City;
- `438` = Aspertia Gate;
- `437` = Route 19;
- `439` = Floccesy Town.

#### True seamless edge: 437 <-> 439

`437 <-> 439` was proven to be a real seamless same-matrix boundary:

- P1 actor stays `0x0223DFE4` across the transition;
- actorSystem stays `0x0223D968`;
- billboard binding survives;
- no field-busy-loading teardown occurs;
- grid/world coordinates remain globally continuous;
- observed world deltas included sub-tile steps such as 8192 and 16384;
- a zero-delta moving boundary sample can occur when the map ID flips before the next position sample.

The map-change classifier therefore accepts either:

1. a small directional continuous world step that matches movement direction; or
2. a zero-delta boundary sample where the direction is unchanged and at least one sample is moving.

Large gate/warp jumps remain `unclassified` and use ordinary lifecycle handling.

#### Native actor preservation

The first implementation recreated P2 after a map-edge rendezvous. That worked technically but caused visible pop-in.

The final implementation instead latches a verified map pair such as `437<->439` and keeps the **same native P2 actor alive** while the players temporarily report different map IDs.

During the latched pair:

- same FieldCommActor remains alive;
- same `FldCommActSys` remains alive;
- same native TCB remains attached;
- same native shadow remains active;
- P2 stays visible;
- transition metadata may expire without forcing teardown;
- the latch clears when players reunite, leave the pair, or White 2 enters real field loading.

Both directions passed visually and technically. P2 remained continuously visible while P1 stayed behind for several seconds, then P1 crossed later with no actor deletion/recreation.

Representative preserved actor on 437/439 tests:

- P2 actor `0x0223E0E4`;
- TCB `0x02309E74`;
- `hidden: false`;
- `actorError: 0` after settling.

#### Static boundary registry filtering

The ROM matrix extractor originally produced 182 same-matrix directional triggers. That was too permissive because some geometric neighbors are intercepted by route gates/tunnels.

`runtime-boundary-export.mjs` now combines:

- static matrix adjacency;
- zone header matrix validation;
- native warp topology.

A geometric `A <-> B` edge is quarantined when a reciprocal native warp bridge exists through a third zone `G`:

`A <-> G <-> B`

This detects gate/tunnel interception without hardcoding Aspertia.

Current generated runtime registry:

- **140 traversable directional triggers**;
- **44 quarantined directional triggers** total;
- of those, 42 are gate/tunnel warp-bridge triggers and 2 are matrix/header mismatches;
- schema version 2;
- `traversableOnly: true`.

Validation anchors enforce:

- `427 <-> 437` must be quarantined through `438`;
- `437 <-> 439` must remain traversable.

Runtime validation passed:

- map 427 reports zero usable candidates and quarantines `427 -> 437` via 438;
- pressing fake P2 north at the old geometric 427 boundary does **not** emit a fake map-edge transition;
- map 437 exposes `437 -> 439 east` as a usable edge and quarantines `437 -> 427 south` via 438;
- pressing fake P2 east at `(95, 696)` emits `FAKE P2 MAP EDGE 437 -> 439` and immediately enters the native map-edge preservation path.

## Current transition architecture

The current DEV transition behavior is:

```text
SAME MAP
  -> one native P2 FieldCommActor + native shadow

REAL FIELD LOAD / DOOR / BUILDING / GATE
  -> White 2 busy/loading or ordinary non-seamless map mismatch
  -> withdraw P2 before unsafe teardown
  -> delete actor + free comm system safely
  -> wait for stable destination field
  -> recreate P2 only when local/remote maps match

VERIFIED SEAMLESS SAME-MATRIX EDGE
  -> classify as kind=map-edge
  -> latch the verified map pair
  -> DO NOT delete P2 when map IDs temporarily differ
  -> keep same actor + comm system + TCB + shadow visible
  -> continue authoritative world-position updates
  -> clear latch when players reunite or leave the pair
```

Door presentation and seamless-edge presentation intentionally use different lifecycle rules:

- doors/warps require cleanup/recreation because fields can teardown;
- true seamless edges preserve the live native actor because the field remains intact.

## Static boundary tooling

Useful commands:

```bash
npm run white2:extract -- /path/to/PokemonWhite2.nds
npm run white2:runtime-boundaries
```

`white2:runtime-boundaries` rebuilds only the filtered runtime registry from existing `generated/white2` extraction data.

The runtime refuses stale schema-v1 boundary registries so old geometric-only candidates cannot silently reappear.

## Known diagnostic noise

A recurring idle diagnostic may log:

`Probe 10 timed out waiting for 1 emulated frames.`

If surrounding native cutover status remains healthy, treat this as diagnostic noise rather than a multiplayer failure.

Early cold-start `GameSystem pointer is invalid` / `GameData pointer is invalid` messages are also expected while White 2 is still initializing.

## Guardrails

- Keep the one-emulator + headless fake-P2 harness model in mind.
- Never carry a FieldActor/FldCommActSys pointer across actual White 2 field teardown.
- Do not use actorSystem alone as field identity; it can remain stable across field changes.
- Prefer White 2's own busy/loading signal and native actor lifecycle over map-ID-only heuristics.
- Treat only `kind: "map-edge"` plus verified traversable boundaries as eligible for same-actor preservation.
- `safeOnly` / same-matrix geometry is not sufficient to prove direct gameplay traversal.
- Do not reintroduce the ghost scrubber; the save is repaired and the temporary repair runtime was removed.
- Avoid disturbing the proven door arrival/departure timings unless a targeted regression is demonstrated.
- Leave unrelated dirty `third_party/ds-anywhere` worktree/submodule state alone.

## Current checkpoint

Probes 10 through 16 are now functionally validated for the current development scope:

- native same-map P2 rendering and movement;
- native shadow;
- safe P1 field teardown/recovery;
- remote P2 door enter/exit;
- cross-map rendezvous;
- polished remote door arrival;
- polished remote door departure;
- true seamless edge classification;
- same-native-actor preservation across seamless edges;
- ROM-derived gate/tunnel filtering for static edge candidates.

`437 <-> 439` should now be treated as the canonical proven seamless-edge test pair. `427 <-> 437` must never be treated as direct; normal gameplay goes through map 438.

## New chat handoff

Use:

> Continue PokéRun multiplayer. First read `docs/POKERUN_MULTIPLAYER_STATE.md` and `docs/WHITE2_RESEARCH.md` on branch `mp/map-transition-recovery-v2`. The harness has ONE real White 2 emulator plus a headless fake P2 peer. Probes 10-16 have passed: native P2 same-map rendering/shadow, safe field teardown, remote door enter/exit, cross-map rendezvous, door arrival/departure polish, and seamless map-edge preservation. True seamless pair `437 <-> 439` keeps the SAME native FieldCommActor/comm system/TCB/shadow alive while map IDs temporarily differ. Geometric `427 <-> 437` is quarantined because gameplay is intercepted by gate map 438. The filtered ROM registry is schema v2 with 140 traversable and 44 quarantined directional triggers. Treat these docs and the current branch as canonical before proposing the next change.
