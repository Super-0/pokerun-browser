# Pokémon White 2 Reverse-Engineering Notes

Last updated: 2026-11-03
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

## Native BG2 interaction-window reverse engineering (2026-11-03)

This section records **research-only** injected native calls for the White 2 US field message window in the one-real-emulator / headless-fake-P2 harness. No functional yes/no menu, text stream, input choice, or close lifecycle is established by these probes. Preserve the proven P2 native comm actor and keep each subsequent phase isolated.

### FieldMsgBG / native window offsets

On stable normal field map 427, `FldAct_GetFieldEffects(actor) -> FieldEffects_GetField -> Field_GetMsgBGSys(field)` resolves the live field message background. Validated `FieldMsgBG` fields:

| Offset | Type | Meaning |
| --- | --- | --- |
| `+0x00` | `HeapID` / `u16` | heap ID |
| `+0x02` | `u16` | primary BG |
| `+0x04` | `u16` | secondary BG |
| `+0x06` | `u16` | palette |

Stable values in tested field: `heapId=21`, `bg=1`, `bg2=2`, `palette=14`; text BG mode `0`, 4bpp BG color mode `0`, 32 bytes/tile. Cold startup may transiently report `bg2=255` or invalid GameSystem/GameData pointers, so fail fast until valid rather than patching those fields.

`BmpWin` at US address `0x020480EC` (`BmpWin_CreateDynamic`) accepts seven arguments `(bg,x,y,width,height,palette,fromEnd)`. The test uses `(2,18,2,12,5,14,1)`, with the final three arguments supplied on the injected ARM9 stack. `BmpWin` layout:

| Offset | Data |
| --- | --- |
| `+0x00` | `magic=0x7fb2` (15 bits), color mode (1 bit) |
| `+0x02` | BG byte |
| `+0x03/+0x04` | x/y bytes |
| `+0x05/+0x06` | sizeX/sizeY bytes |
| `+0x07/+0x08` | width/height bytes |
| `+0x09` | palette byte |
| `+0x0A` | character tile position (`u16`) |
| `+0x0C` | `GFLBitmap*` |

`GFLBitmap` fields: pixel pointer `+0x00`; width/height in pixels `+0x04/+0x06`; tile size `+0x08`; storage `+0x0A`. A valid 12×5 window has 96×40 pixels, tile size 32, storage 0, and 1,920 bytes of character pixels.

### Native window creation and allocation

The decompiled `FieldMsgBG_CreateBmpWin` sequence is:

1. `BmpWin_CreateDynamic`
2. `GFL_BitmapFill` color `0xff`
3. `BmpWin_FlushMap`
4. `BmpWin_FlushChar`
5. `GFL_BGSysLoadScr(bg)`
6. `BmpWin_DrawFrame(window, WINFRAME_TRANSFER_NOW, 1, palette==14 ? 13 : 10)`

`GFL_BGSysAllocChar(bg=2,size=1920,fromEnd=1)` can return `AREAMAN_FAIL=0xffffffff` when space is unavailable. An exact preflight allocation followed by `GFL_BGSysFreeCharMemory` often returns `charPos=964`, and the subsequent native CreateDynamic also uses `964`, occupying BG2 character indices 964..1023. Do not assume allocator state remains usable indefinitely; another run created a window at `charPos=4` despite a preflight result of `964`.

**Unresolved anomaly:** two earlier runs returned `preflightCharPos=964` but `BmpWin.charPos=1` or `4`, with much larger instruction counts (e.g. create `27063`, fill `24513`, flushMap `19048`). These figures are consistent with an unexpectedly larger allocation, but this is *not proven to be bad stack arguments*; no window-geometry readout was taken in those anomalous runs. PRK22 and later introduced a read-only guard on the actual native `BmpWin` and bitmap geometry and fail **before any fill/VRAM upload** if dimensions or charPos differ from the exact preflight. Normal validated counts: create `2943`, fill `1473`, flushMap `2888`.

### DMA boundary is the synchronous injected-call wait, not necessarily the transfer

The PRK11 scheduler-aware atomic runtime (`callArm9Thumb8Atomic`, up to eight arguments, 1M instruction cap) advances emulator scheduling yet **cannot reliably exit synchronous Nitro DMA completion waits** once a native call requests DMA. White 2's normal game DMA is not shown to be broken.

- `BmpWin_FlushChar` `0x02048270` attempts BG2 `GFL_BGSysLoadChar -> GX_LoadBG2Char -> GXi_DmaCopy32` with 1,920 bytes. PRK16 hung at `MIi_DmaCopy32` `0x02078108/0x0207810A` after 1M instructions.
- PRK17 passed a **32-byte** (one 4bpp tile) `GFL_BGSysLoadChar` call in **116 instructions**. Nitro's `GXi_DmaCopy32` uses CPU copy for sizes <=48 bytes.
- PRK18 attempted **64 bytes**, the smallest two-tile payload above that threshold, and stalled at `0x0207810A`.
- The PRK20 full `GFL_BGSysLoadScr(bg2)` used `GX_LoadBG2Scr -> GXi_DmaCopy16`, stalled in `MIi_DmaCopy16` near `0x0207816C` at 1M instructions. A visible 12×5 black rectangle nevertheless appeared in the screenshot, indicating at least the relevant window map entries reached VRAM before timeout. Do **not** infer that every DMA transfer itself fails; the injected *waiting code* is the established problem.

### Proven DMA-free character and tilemap upload

- **PRK19:** `60 × GFL_BGSysLoadChar(bg2,pixelData+32*i,32,charPos+i)` uploaded all **1,920 character bytes** in **6,960 instructions**, 116 each.
- **PRK21/PRK22:** for a 32-tile-wide text BG, construct each `BmpWin_FlushMap` map entry as `(palette << 12) | (charPos + row*12 + col)`. Upload **five 24-byte rows** using `GFL_BGSysLoadScrCore(bg2,scratch,24,(y+row)*32+x)` at `0x02044FDC`. `GXi_DmaCopy16` uses CPU copy for sizes <=28 bytes. Five uploads took **675 instructions total**, 135 each. The first 24 bytes of the bitmap RAM were used as temporary scratch and restored afterward.
- On PRK22 the geometry guard reported expected and actual `12×5`, `96×40`, `charPos=964`; create/fill/flushMap instruction counts returned to 2943/1473/2888. P2 remained healthy.

The program's BG2 character upload uses physical tile offsets; `GFL_BGSysLoadChar` accepts tile indices, while `GFL_BGSysLoadScrCore` accepts **screen entry offsets** and multiplies them by two bytes internally.

### Native frame draw and screen transfer

White 2 US frame routine `BmpWin_DrawFrame` is at **`0x02024EAC`**. Decomp source: `src/system/bmp_winframe.c`. It writes eight border segment types using `GFL_BGSysFillScrArea`; `WINFRAME_TRANSFER_NONE=2` skips its dangerous immediate `GFL_BGSysLoadScr`. Normal BG2 frame is **character 1, palette 13**. For test window interior `(18,2,12,5)`, frame occupies the surrounding rectangle `(17,1,14,7)` with 38 border entries.

- **PRK23:** `BmpWin_DrawFrame(win,2,1,13)` succeeded in **1,681 instructions**, modifying the BG2 RAM screen map only. No frame VRAM upload occurred.
- **PRK24:** reconstruct the eight segment types exactly as `BmpWin_DrawFrameCore` does, then upload **two 28-byte full rows** (top and bottom) and **ten 2-byte side entries** (`GFL_BGSysLoadScrCore`), **12 calls / 38 entries / 76 bytes**. All remain on the <=28-byte CPU path, total **1,040 instructions**.
- Screenshot and PRK24 log independently confirmed a clean native White 2 black interior with its usual gray/white/black border at the expected BG2 screen position; frame graphics and palette are already available in this field state. P2 remained healthy at 6, 8 and 10 seconds after the probe.

**Validated research pipeline:** exact allocator preflight -> geometry guard -> native BmpWin create -> bitmap fill -> native RAM map flush -> 60 CPU-sized character uploads -> 5 CPU-sized interior map uploads -> native RAM frame draw (transfer NONE) -> 12 CPU-sized border uploads. The one-shot diagnostic intentionally leaves its native window allocated until a fresh emulator session. It is not a production ownership/cleanup pattern.

### Native text staging and streamed glyph I/O (PRK25–30)

**PRK25 succeeded:** the live `FieldMsgBG.font` pointer at `+0x08` was `0x02271E58`; its `loadType=0` and `getGlyph=0x02023191` indicate **streamed** glyph access (`GFL_FontGetGlyphStreamed` at `0x02023190`, Thumb). Native `GFL_StrBufCreate(8,21)` -> `GFL_StrBufAppend(U+0041)` -> `GFL_StrBufFree` succeeded with correct magic `0xB6F8D2EC`, length 1, terminator `0xffff`, and instruction counts `320/15/172`. No text drawing occurred.

**PRK26 failed at the next stage:** `GFL_TextRendererDrawToBitmap(bitmap,8,8,strbuf,font)` (`0x02021D28`, five ARM9 arguments) did **not** return: `status=3`, `PC=0xFFFF0104`, `LR=0x0207A9E2`, `CPSR=0x00000097`, 1,000,000 instructions. The CPSR mode bits indicate ARM9 **abort mode**; this is not the previously observed DMA busy-wait. The log never reached the after-render bitmap comparison, so it does not establish whether any pixels changed. P2 remained healthy afterward. The experimental StrBuf cleanup was inside `finally`; a separate free success line was not logged because the preceding native glyph call raised.

**Source-grounded explanation, not yet conclusively proven:** `GFL_FontGetGlyphStreamed` seeks the font's NARC and calls `GFL_ArcToolReadRaw -> FS_ReadFile`, potentially involving CARD tasks and thread scheduling. The failure's LR points inside `OS_SetThreadPriority` (White 2 US `0x0207A9C4`, LR + `0x1e`), which is used by Nitro CARD async tasks. This strongly suggests that the injected atomic call context is unsafe for the streamed glyph I/O / scheduler path, not necessarily for glyph rasterization itself. Do not generalize this to native gameplay's normally scheduled filesystem operations.

**PRK27 succeeded:** `GFL_FontGetCharWidth(font,'A')` at `0x02023208` returned **6 pixels in 145 instructions**, with the native StrBuf subsequently freed in 172 instructions. Window geometry, character VRAM upload, screen-map upload, and frame upload remained clean; P2 stayed healthy. The cached font-map/width-table path works independently of streamed glyph file access.

**PRK28 failed and destabilized the field:** `GFL_FontGetGlyph(font,'A',dest,info)` (`0x020230A0`), bypassing TextRenderer, hit the 1M instruction cap with `status=3`, `PC=0x0207AC38`, `LR=0x0207AC2C`, `CPSR=0x000000D3`. The PC and LR are **inside `OS_LoadContext`** (White 2 US `0x0207ABE8`, ARM, size 0x68), the Nitro routine that restores another thread's saved CPU context; `0xD3` is the SVC mode plus masked interrupts used by this routine. This is more specific than the PRK26 abort: the streamed glyph operation appears to have entered a true thread context switch that the injected atomic-call stop mechanism does not safely manage. The 128-byte glyph destination and four-byte GlyphInfo stayed unchanged (**0 changed bytes**); the 132-byte borrowed bitmap scratch was restored, but this does not restore CPU/thread/scheduler state. **Subsequent GameData_GetFieldStatus failed with status 2 and native P2 cleanup was unsafe**; the game must be restarted after this probe. Do not run further injected native glyph fetches, FS_ReadFile, or functions that can initiate thread scheduling until that execution context is understood. This is not evidence of a broken normal-game ROM reader.

**PRK29 succeeded:** the first `FontMap` contains characters `32–126`, method `0` (direct), first glyph index `0`. Native `GFL_FontGetCharIndex(font,'A')` returned **33 in 13 instructions**. The live streamed font (`0x02271E58`) has `ArcTool*=0x02271F18`, NARC member `fileId=0`, `fileOffset=116`, `glyphsOffset=60`, `cellSize=48`, `glyph width=12`, `height=15`, `bpp=2`. Thus glyph 'A' begins at `116 + 60 + 33×48 = 1760` bytes into the **open NARC archive file**. Font map/width and bitmap metadata validated, StrBuf freed normally, P2 healthy. No ROM bytes fetched.

**PRK30 targeted range inspection (awaiting run):** `ArcTool` begins with Nitro `FSFile`; in `FSFile`, `FSFileProperty` begins at offset `+0x20` and contains `FSFileRange { fileId, top, bottom, position }`. Read-only probe logs `ArcTool+0x04` property pointer, `+0x08` FSArchive, `+0x0c` status, and `+0x20/+0x24/+0x28/+0x2c` as range file ID/start/end/current position. If pointers, bounds, and the 1760-byte glyph location validate, calculate **candidate** physical ROM offset `FSFile.body.file.top + 1760`. This remains a candidate until independently compared to the user's locally loaded NDS FAT entry and glyph data; no native FS calls or access to raw ROM bytes in PRK30. Do not conflate `Font.fileId=0` (member inside NARC) with `FSFileRange.fileId` (archive file in the DS ROM filesystem).

### PRK30 missing-window regression and PRK31 isolation (2026-11-03)

The PRK30 user run **did not execute the new FSFile-range inspection**. Two early attempts hit field-init races: `FldAct_GetFieldEffects(0x02194F18)` called while the local actor was still `modelId=244` reached BIOS `0xFFFF0104` after 1M instructions, and a subsequent attempt rejected `FieldMsgBG.bg2=255`. Later, with native P2 healthy and local model `240`, the injected seven-argument `BmpWin_CreateDynamic(2,18,2,12,5,14,1)` returned a malformed window: actual `sizeY=height=0`, `palette=0`, `charPos=1024` although preflight returned `964`; actual x/y/width still matched. The PRK22 geometry guard stopped safely **before fill or VRAM upload**, so the framed window never appeared. The old guard also assigned `stateRef.window` and thereby consumed the one-shot probe, producing `HOLD` on later X. P2 actor continued healthy. The precise cause of the seven-argument corruption remains **unproven**; the register-vs-stack split strongly suggests an injected stack-argument hazard rather than a font/graphics regression.

**PRK31:** gate all injected field getters on stable local player model `240` and split font archive range measurement entirely from window allocation. After field/bg2 pointer checks, read `FieldMsgBG.font` / CMAP / `ArcTool.FSFile` directly from emulator RAM and calculate `ROM file top + 1760` as a **candidate** absolute ROM offset. Do **not** call `BmpWin_CreateDynamic`, `BmpWin_DrawFrame`, character/screen VRAM uploads, `GFL_StrBuf`, streamed glyph retrieval, or the guest filesystem. The PRK31 test should deliberately **not show a framed window**; this avoids the known stack-arg creation hazard while collecting archival data. Guarded invalid BmpWin no longer advertises the window as a successful one-shot result, but because allocations might already have happened, do not blindly retry a malformed window in the same emulator session.

### PRK31 success and PRK32 return to visible native windows (2026-11-03)

The PRK31 **window-free** probe succeeded on a fully initialized field: the existing `FieldMsgBG.font` (`0x02271E58`) / `ArcTool` (`0x02271F18`) reported a Nitro `FSFileRange` with **root ROM file ID 370**, start `0x0A796200`, end `0x0A834D88`, length **650120 bytes**, and file position `0x0A797390`. With the validated glyph 'A' internal NARC offset `1760` (`0x6E0`), the **candidate cartridge offset** is `0x0A7968E0` through `0x0A796910` (48 bytes). `FSFile.prop` pointed to `ArcTool+0x20`, open-file status `0x10`, and all range validations passed. P2 remained healthy. Candidate still needs verification against the user's browser-held NDS FAT before production use. **PRK31 deliberately did not draw the window**, so its absence was expected, not a regression.

The intermittent PRK30 window creation anomaly has a plausible underlying cause in `third_party/patches/0005-atomic-arm9-stack-args.patch` / `0006-scheduler-aware-arm9-stack-args.patch`: `callArm9Thumb8Atomic` placed arguments 5–8 at the game's live **original ARM9 SP**, despite backing up a 0x800-byte reserve. `RunFrame()` can use that original stack while scheduling game threads; this could overwrite the stack-passed `height=5` and `palette=14`. This is an **inference awaiting experimental validation**, not a proven cause.

**PRK32 targeted hypothesis test:** `third_party/patches/0007-isolate-arm9-injected-stack.patch` moves the injected callee's `SP` down by `stackReserve/4` (with 0x800 reserve, this is 512 bytes), writes arguments 5–8 at the new SP, and leaves 1536 bytes below it for nested calls. The game stack contents are backed up/restored as previously. The new wasm stamp is `0x50524B3C`, with enforced version checking in `runtime.ts` and `build-melonds.mjs`. **Rebuild melonDS using `npm run build:melonds`**, then `npm run build`; pulling TypeScript changes alone will fail the new runtime check.

PRK32 re-enables the 12×5 native bitmap window and border uploads through the verified CPU copy path, keeps the geometry/allocator preflight guard and the stable model-240 field gate, and then repeats PRK29/PRK30 font/ROM metadata logging. It never invokes the unsafe streamed glyph getter or text renderer. Failed geometry still stops before any graphics upload; do not blindly retry a malformed allocation in the same emulator session. This is a research probe, **not** a production window lifecycle.

### PRK32 stack relocation failure; PRK33 four-argument BG2 visual isolation (2026-11-03)

**PRK32 failed:** The runtime version guard accepted the rebuilt `0x50524B3C` melonDS binary; stable local model `240`, P2 actor health, BG2 mode, heap ID `21`, and 1,920-byte BG character allocation preflight (charPos `964`) all passed. The call to seven-argument `BmpWin_CreateDynamic(2,18,2,12,5,14,1)` nevertheless **never returned**: `status=3`, `PC=0xFFFF0104`, `LR=0x01FF8D64`, `CPSR=0x200000D7`, at 1M instructions. This is abort mode; the lower SP relocation from PRK32 is **not validated as a fix** and may have contributed. No geometry or BG uploads followed, so the framed window did not appear. P2 remained healthy afterward. Avoid concluding from this one failure that `BmpWin_CreateDynamic` or the underlying bitmap graphics code itself is broken; injected call-context and stack/exception interactions remain open research questions.

**PRK33 experiment, awaiting user test:** No new melonDS rebuild. Bypass all guest functions requiring more than four bridge arguments. After stable field/BG checks, call `GFL_BGSysAllocChar(2,1920,TRUE)` (three arguments; require `charPos=964`), then **`GFL_BitmapCreate(12,5,32,21)` at `0x02046E54` (four arguments)**. The decomp confirms `GFLBitmap { pixels, u16 width, u16 height, u16 tileSize, u16 storage }` and that native creation makes the 1920-byte pixel allocation. Verify bitmap geometry and native `GFL_BitmapFill(bitmap,0xFF)` before any VRAM writes. Upload 60 tiles through 32-byte `GFL_BGSysLoadChar` calls, five 24-byte BG2 interior `GFL_BGSysLoadScrCore` row calls, and 12 `<=28`-byte border map segments, using palette 14 for the interior and palette 13 with validated native border tiles 1–9. Save/restore the 28-byte temporary map scratch. This is the same **game-native BG2 graphics content** as the PRK24 visible frame, **but it deliberately does not create a `BmpWin` structure or call `BmpWin_DrawFrame`**. It cannot validate the native BmpWin constructor/ownership contract. The direct bitmap and 3/4-argument helper path, visual appearance, and P2 health must be evaluated from the next log and screenshot; no text renderer, streamed glyph I/O, or production menu lifecycle is included.

### PRK33 failure reveals a concrete injected-stack collision; PRK34 isolates the Thumb4 bridge

**PRK33 failed before drawing anything:** the field and P2 were stable, BG2 4bpp mode validated, and `GFL_BGSysAllocChar(2,1920,1)` returned the expected char position 964. The **four-argument** `GFL_BitmapCreate(12,5,32,21)` then failed after the 1M instruction limit with `status=3`, `PC=0xFFFF0104`, `LR=0x02070010`, `CPSR=0x00000097`. The latter LR is **inside `CARDi_CheckPulledOutCore`** (`0x0206FFF8` to `0x02070028`); the PC/CPSR indicate an ARM9 abort exception. It never reached bitmap geometry checks, character uploads, or the 17 screen-map upload calls, so no new framed window appeared. P2 stayed healthy in the observed follow-up.

**Critical symbol evidence:** the PRK33 log captured `originalArm9Sp=0x0214C470`, and the PRK32 native bridge `callArm9Thumb8Atomic` computes `injectedSp = originalSp - stackReserve/4 = 0x0214C270` (reserve `0x800`). The White 2 US symbol table maps `OSi_ThreadInfo` to **`0x0214C26C`**, `OSi_IdleThread` to **`0x0214C27C`**, and `OSi_IdleThreadStack` to **`0x0214C3FC`**. This means the relocated SP is **inside global Nitro thread-manager state**, not reserved stack memory. `callArm9Thumb8Atomic` writes four arguments at `injectedSp + 0/4/8/12` even for zero-argument calls; its call itself and guest function prologues can therefore overwrite `OSi_ThreadInfo` and adjacent OS structures. The collision is established by address arithmetic; the causal link to the abort is a strong hypothesis, not proven by a traced store. **Do not invoke the relocated Thumb8 path in this runtime.** Reboot the guest after any previous PRK32/33 failed run.

**PRK34 test awaiting user run:** retain the current `0x50524B3C` binary, but change only the TypeScript probe's native call dispatcher to use the **separate, already employed scheduler-aware `MelonDsBridge.callArm9Thumb4`** for every 0–4 argument field, BG2, bitmap, and map helper. Explicitly reject calls requiring arguments 5–8; the PRK32 and PRK33 experimental branches involving the unsafe `BmpWin_CreateDynamic` remain unreachable in this test. Try the same PRK33 graphics sequence to distinguish bridge-induced corruption from native bitmap/VRAM problems. No recompile of melonDS is necessary. This still uses the guest's original SP (observed near its idle-thread stack), so heap-allocating calls are **not guaranteed safe**, and a failure must be treated as a research outcome rather than retried in the same guest.

### PRK34 native BG2 window recovery and PRK35 ROM-only font validation (2026-11-03)

**PRK34 succeeded visibly:** the screenshot confirms a fully rendered black dialogue window with White 2's black/white/gray border at BG2 tile coordinates `x=18,y=2,width=12,height=5`. The bridge used exclusively `callArm9Thumb4`, not the unsafe relocated `callArm9Thumb8Atomic`. Native `GFL_BitmapCreate(12,5,32,21)` returned a valid `GFLBitmap=0x023369B8` with pixels `0x023369F0`, `width=96px,height=40px,tileSize=32,storage=0` in **2268 instructions**; `GFL_BitmapFill` succeeded in 1479 instructions. 60×32-byte `GFL_BGSysLoadChar` uploads totaled 8940 instructions; the BG2 map interior used 5 calls and the border used 12 CPU-sized screen calls (combined 2089 instructions). Character allocation position was correctly `964`. The subsequent P2 native actor remained `modelId=240,actorError=0,healthy=true`. This establishes a reproducible game-native **BG2 visual** using ≤4-argument guest functions without a `BmpWin` object, streamed glyph reads, or a native menu implementation.

**ARM9 stack observation:** in PRK34, the separate Thumb4 call path captured `ARM9 SP=0x02FE33C8` (DTCM region), whereas the prior unsafe Thumb8 call path was observed with SP near `0x0214C470` and moved it into `OSi_ThreadInfo`. Avoid calling `callArm9Thumb8Atomic` from this probe until the native bridge has an audited independent, valid stack allocation and scheduler/context lifecycle. The PRK34 window bitmap/character allocation remains intentionally allocated for this one-shot diagnostic; future production interaction lifecycle needs ownership, cleanup, and game-safe map-transition handling.

**PRK35 queued, ROM-only data research:** `MelonDsPlayer` already holds `LoadedRom.bytes: Uint8Array` locally, so the verified cartridge is passed through the White 2 runtime **only in memory**, never over multiplayer network. After successful PRK34 visual upload, read existing `FieldMsgBG.font`/in-RAM CMAP/`ArcTool.FSFile` fields (no injected native call), parse the NDS header FAT at offsets `0x48/0x4C`, locate the archive by live `rootRomFileId`, verify its FAT start/end against Nitro's `FSFileRange`, parse the NARC `BTAF / BTNF / GMIF` sections, and verify that the font member start matches `Font.fileOffset`. Check the selected 48-byte glyph cell's bounds within that member, and log only its first eight bytes and a noncryptographic FNV-1a checksum. **No guest FS/CARD work, no new VRAM changes, and no content sent to other players.** This is intended to validate the prior candidate `0x0A7968E0` glyph location independently of native filesystem scheduling, before researching safe offline glyph decompression. An inspector validation failure will be logged independently without invalidating the visible PRK34 window.

### PRK35 intermittent bitmap failure; PRK36 CPU stack guard (2026-11-03)

**PRK35 test failed before the ROM verifier:** A fresh same-map field and P2 were healthy and BG2 preflight passed, but `GFL_BitmapCreate(12,5,32,21)` via `callArm9Thumb4` exceeded its 1,000,000-instruction budget with `PC=0xFFFF0104`, `LR=0x01FF8D00`, `CPSR=0x200000D7` (ARM9 abort mode). No bitmap/character uploads or glyph-ROM inspection followed. The log captured **ARM9 SP=0x0214C470**, versus **SP=0x02FE33C8** in the immediately preceding, fully successful PRK34 window test. Both native bridges can therefore start from different interrupted CPU/thread contexts; using Thumb4 removes the PRK32 relocation hazard but does not guarantee guest heap allocation is safe when interrupted in an OS idle-thread stack. This is a strong correlation, not a proven diagnosis of every abort. P2 remained `actorError=0`, healthy in the observed aftermath.

**PRK36 succeeded (2026-11-04 log):** with P2 healthy (actor error 0), pressing X first ran the now-independent `PRK35 ROM FAT NARC GLYPH VERIFIED` successfully: NDS FAT `0x00363A00`, root ROM file ID **370**, archive FAT range `0x0A796200–0x0A834D88`, NARC size **650120**, three sections, eight members, member 0 begins at archive offset **116** and is **264360** bytes long, font member magic `RTFN`. Character `A` maps to index **33**, cell length **48**, archive offset **1760**, physical ROM byte range **`0x0A7968E0–0x0A796910`**, preview `00 06 06 00 00 00 00 00`, FNV-1a `0x54a96e03`. The field native call gate first saw SP `0x0214C470` and then `0x02FE3F28` after **one frame poll**. `GFL_BitmapCreate` returned a valid 96x40/32-byte-tile bitmap in **2268 instructions**; 60 character tiles, 5 interior screen segments, 12 border segments all uploaded successfully, exactly as in PRK34. P2 stayed `modelId=240`, `actorError=0`, `healthy=true` in subsequent logs. This is strong positive evidence that choosing the active DTCM stack avoids the specific idle-thread-context abort in this session, **not** proof that the guard is universally sufficient. No native glyph fetch or ARM9 Thumb8 call occurred.

**PRK37 succeeded (2026-11-04 second log):** `PRK35 ROM FAT NARC GLYPH VERIFIED` repeated across attempts. `PRK37 OFFLINE FONT GLYPHS DECODED` reported all **five** characters with coherent row-by-row native bitmaps and correct metrics. A: x0/width6/advance6, source pixel counts 130 transparent, 24 ink, 26 shadow, 0 background; its 16×16 4bpp tile hash was `0x577c4437`. B: x0/6/6, counts 126/26/28/0 and hash `0xfafec3b3`. Digit 0: x0/6/6, counts 132/22/26/0, hash `0xba3013d1`. Question mark: x0/6/6, counts 146/13/21/0, hash `0x8b17458d`. Space: x4/width0/advance4, all 180 source pixels zero; its 128 all-zero output tile hash was `0xa7b537c5`. All five raster shapes were readable in the logs, confirming the in-browser MSB-first 2bpp decoder and character mapping without guest ROM reads. **The first three drawing attempts** skipped on transient `FieldMsgBG.bg2=255` after reaching the DTCM stack; later, `bg2=2` and the standard 60 character/5 interior/12 border uploads succeeded. The only logged post-render P2 statuses remained healthy with `actorError=0`. No font glyph was yet placed in bitmap RAM or VRAM.

**PRK38 test awaiting user run:** keep the PRK36 active-DTCM stack gate and PRK34 native window visual unchanged. After `PRK35` validates the ROM source and `PRK37` independently verifies glyph decoding, and **after** the complete window has already been uploaded successfully, copy only four untouched 32-byte tiles at bitmap-relative pixel `(8,8)` (tile indices `[13,14,25,26]`) into a host-side snapshot. Compose the glyph `A` into these 128 bytes using the 12×15 source bitmap (ink palette index 1, shadow index 2), preserving black fill `0xFF` for transparent pixels. An independent calculation over the PRK37 ASCII rows predicts **26 changed bytes** distributed as **[15,0,11,0]** across the four tiles (24 ink pixels, 26 shadow pixels); the probe verifies this exact-ROM layout before any temporary RAM write. Only two left-hand tiles actually contain non-background pixels, suggesting two 32-byte CPU uploads will suffice for the later visual experiment. Temporarily write the four 32-byte tiles into **the allocated `GFLBitmap` backing RAM only**, read back byte-for-byte and compare the exact number of changed bytes against offline composition, then restore all 128 bytes in a `finally` block and independently verify restoration. New logs: `PRK38 GLYPH BITMAP RAM CALL`, `PRK38 GLYPH BITMAP RAM VERIFIED`, `PRK38 GLYPH BITMAP RAM RESTORE`. A PRK38 error is logged without claiming a frame failure. **No extra native guest call, no streamed font fetch, no BG2 VRAM transfer, no visible text, and no menu logic**. This research test isolates bitmap RAM address/tile packing and reversible ownership before considering a minimal CPU tile upload.

### PRK38 verified RAM glyph composition; PRK39 two-tile visible glyph experiment (2026-11-04)

**PRK38 passed:** The 2026-11-04 test log (Pasted text 023254) first encountered a transient `FieldMsgBG.bg2=255` during field startup, which skipped allocation safely; a later X press after P2's native comm actor initialized recovered `bg2=2`. `PRK35` validated the local NDS FAT/NARC font, `PRK37` decoded all five sample glyphs, and the PRK36 DTCM gate switched to `SP=0x02FE33D8` after one frame poll. The original PRK34 window successfully allocated a 96×40 bitmap at `0x023369B8` (pixel buffer `0x023369F0`), char position `964`; 60 character tiles, 5 interior map segments and 12 border segments uploaded successfully. **PRK38** temporarily modified the four bitmap tiles `[13,14,25,26]` at RAM addresses `0x02336B90, 0x02336BB0, 0x02336D10, 0x02336D30`. The verified `A` glyph had **24 ink + 26 shadow pixels**, exactly **26 changed bytes**, distributed `[15,0,11,0]` among those tiles. `PRK38 GLYPH BITMAP RAM VERIFIED` confirmed a 128-byte readback, then `PRK38 GLYPH BITMAP RAM RESTORE` reported `verified=true, restored=true, bytesRestored=128`. P2 remained `modelId=240, actorError=0, healthy=true`. The PRK38 glyph never entered VRAM, so its absence from the visible window was expected.

**PRK39 targeted visual probe (awaiting user run):** Keep the PRK35/37 offline ROM validation, DTCM stack gate, proven PRK34 window and full PRK38 reversible round-trip **unchanged**. Only if PRK38 succeeds and all four bitmap RAM tiles are restored to `0xff`, recompose the same verified glyph `A` at bitmap pixel `(8,8)`. Change **only tile 13** (15 modified bytes) and **tile 25** (11 modified bytes) of the allocated `GFLBitmap`, check their 32-byte RAM readbacks, and transfer **exactly two 32-byte tiles** through the previously validated `GFL_BGSysLoadChar(2, ramTile, 32, charPos+tileIndex)` Thumb4 CPU path. With char position `964`, targets are **977** and **989**; BG2 tilemap itself is left intact. No new FS/CARD calls, streamed font renderer, Thumb8 calls, DMA transfer, or actor mutation. On success, leave bitmap RAM and BG2 tile graphics **consistent and letter visible** for manual screenshot verification; no teardown is implemented. Logs are `PRK39 GLYPH A BG2 TILE UPLOAD CALL`, `PRK39 BG2 SINGLE TILE UPLOADED` (twice), and `PRK39 GLYPH A BG2 TILE UPLOAD SUCCESS`. Expected location within the bordered text window is `(8,8)`, corresponding to screen pixel `(152,24)`. The raster should use palette 14, with font indices 1 and 2 (ink and shadow). Any failed native tile transfer requires restarting the emulator before another attempt; don't assume the window and backing buffer remained consistent after partial failure. This tests a **single glyph display**, not native `BmpWin` ownership, text printing, menu state, or long-term lifecycle.

### Next isolated research topics

1. Investigate native font/glyph/StrBuf to render a *single fixed string* in an existing bitmap, with **no native scheduled PrintStream** and no immediate DMA. Inspect changes to bitmap RAM before uploading anything, then test the smallest CPU-sized character refresh. Fonts should use the live `FieldMsgBG.font` pointer at `+0x08` (do not overwrite).
2. Establish reversible teardown: clear the exact interior+border tilemap using CPU-sized calls, `BmpWin_Free` allocation lifetime, field teardown and map warp invalidation.
3. Only after these are validated, research native choice selection, cursor movement, input, and interaction task lifecycle. Preserve the existing fake-P2/native-comm actor implementation.

### Sources for symbols and behavior

- `fuddlesworth/pokebw2` at commit `41f42ca1afe6291f00b0ba0ec3f6099b9ff1346c`, notably `src/gfl/bmp_win.c`, `src/gfl/bg_sys.c`, `src/gfl/bmp.c`, `src/system/bmp_winframe.c`, `src/ov036/field_msgbg.c`, and `config/w2_us/arm9/symbols.txt`.
- Probe implementation: `src/multiplayer/games/White2NativeYesNoInteractionProbe.tsx` on `mp/map-transition-recovery-v2`.
- Representative log: PRK24 (2026-11-03 18:31 uploaded snapshot) with geometry at 877–913, frame RAM at 996–1022, border upload at 1024–1047 and healthy P2 through 1146.

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
