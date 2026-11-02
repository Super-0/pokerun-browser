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

PokéRun has now proven this path works end-to-end with the fake multiplayer peer.

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

Validated test:

1. P1 + P2 started outside on map 427;
2. P1 entered building map 433;
3. Probe 11 logged `PROBE 11 NATIVE COMM WITHDRAW` with reason `field-busy-loading`;
4. cleanup logged `safe: true` before the old billboard system disappeared;
5. P2 remained absent while P1 was on map 433 and fake P2 stayed on 427;
6. P1 returned to map 427;
7. a fresh native P2 was created exactly once;
8. native shadow was recreated;
9. the new P2 remained healthy and followed fake-peer state.

This validates the dangerous local-field teardown/rebuild lifecycle.

### Probe 12 — fake P2 remote door enter/exit — FULL PASS

No new code was required. The existing `FakeRemoteDoorPeerPanel` captured a real P1 door transition and replayed it for fake P2.

Captured door:

- map `427` -> map `433`;
- exterior door tile `(59, 723)` facing north;
- interior destination `(6, 11)`;
- native door prop handle matched correctly.

Forward remote transition validated:

1. P1 remained on map 427;
2. fake P2 walked into the captured door;
3. `REMOTE DEPARTURE`, `PLAY NEAREST DOOR`, `HANDLE AT POS MATCH`, and `DOOR RESULT matched: true` all fired;
4. fake P2 changed to map 433;
5. Probe 11 withdrew native P2 with reason `players-on-different-maps`;
6. native cutover cleanup completed with `safe: true`;
7. no remote actor remained on P1's map while P2 was inside.

Reverse remote transition validated:

1. fake P2 replayed the captured door from map 433 back to 427;
2. the exterior door on P1's live map opened again;
3. fake P2 changed back to map 427 at the expected outside destination;
4. after the same-map field was stable, Probe 11 emitted `PROBE 11 NATIVE COMM RESTORE READY`;
5. a fresh native comm P2 was created;
6. native shadow was restored;
7. P2 position/direction exactly matched the remote destination state and stayed healthy.

This validates remote-player departure/return through an actual door while P1 stays in place.

## Current transition architecture

The current DEV behavior is now:

```text
same map
  -> one native P2 FieldCommActor + native shadow

P1 begins field load
  -> busy/loading signal
  -> withdraw P2
  -> delete actor + free comm system safely
  -> wait for stable field

P1/P2 on different maps
  -> no P2 actor exists locally

same map becomes stable again
  -> create fresh native comm system
  -> create one native P2
  -> start native shadow
  -> resume live remote backing-state updates
```

Remote door visuals are driven by the captured transition metadata and the existing door runtime; P2's native actor lifecycle is owned by Probe 11's transition-aware gate.

## Next test — cross-map rendezvous

Before calling transition recovery complete, test the missing rendezvous case:

1. keep P1 outside on map 427;
2. send fake P2 through the captured door into map 433;
3. leave fake P2 inside;
4. then have real P1 enter that same building;
5. when P1 arrives on map 433, a native P2 should be created inside at fake P2's authoritative interior position;
6. P2 should have a native shadow and should continue moving normally inside;
7. then test the inverse: P1 leaves first while P2 stays inside, confirming P2 disappears locally when maps diverge again.

No code change is required for this test unless the rendezvous fails.

## Guardrails

- Keep the one-emulator + headless fake-P2 harness model in mind.
- Never carry a FieldActor/FldCommActSys pointer across White 2 field teardown.
- Prefer White 2's own busy/loading signal and native actor lifecycle over map-ID-only heuristics.
- Do not reintroduce the ghost scrubber; the save is repaired and the temporary repair runtime was removed.
- Avoid unrelated protocol changes while transition recovery is being validated.

## New chat handoff

Use:

> Continue PokéRun multiplayer. First read `docs/POKERUN_MULTIPLAYER_STATE.md` and `docs/WHITE2_RESEARCH.md` on branch `mp/map-transition-recovery-v2`. The harness has ONE real White 2 emulator plus a headless fake P2 peer. Native P2 same-map rendering, movement, shadow, P1 field transitions, and fake-P2 door enter/exit have all passed. Probe 11 uses White 2's busy/loading lifecycle to delete/free P2 before field teardown and recreate it only on a stable same-map field. Probe 12 validated fake P2 entering map 433 and returning to 427 through the captured door with safe cleanup/restoration. The next test is cross-map rendezvous: P2 goes inside first, then P1 enters the same map and should find P2 already there.
