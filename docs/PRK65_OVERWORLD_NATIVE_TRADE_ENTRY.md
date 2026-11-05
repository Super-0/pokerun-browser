# PRK65 — Overworld-initiated, game-native White 2 trade

## Intended player experience

1. **PokeRun overworld**: walk next to a nearby real player's native trainer
   (same map, near enough, controllable) and press **A**.
2. **Native White 2 text**: the request uses the already researched native
   dialogue/Yes–No system. PokeRun's room/start/peer-bound request protocol
   synchronizes accept/decline on both players, with timeout/cancel handling.
3. **Both accept**: verify two *real* running DS emulators have the same
   verified White 2 ROM and a functioning native wireless association.
   Both pause the overworld interactions; a two-party launch barrier resolves
   before either side begins the fade/field-close sequence.
4. **Native in-game interface**: queue the real **overlay 194** trade procedure
   on *both* emulators so the original party + PC box selection, game trade
   restrictions, confirmation and animation execute inside White 2.
5. **Exit**: the original game transitions back to the field, including the
   evolution subprocedure if triggered, and PokeRun restores overworld input.

This is the target design, **not currently implemented**. PRK65 only measures
native wireless frame categories. The PRK60 simulated P2 is NOT a DS endpoint.

## Original White 2 trade procedure: source-grounded facts

In the public `fuddlesworth/pokebw2` decompilation:

- `src/ov028/union_subproc.c`, `UnionCommand_Trade`:
  `CallFieldMapEntranceOutTransitionDefault` →
  `CreateFieldCloseEvent` →
  `GSYS_QueueProc(gsys, OVERLAY_POKEMONTRADE,
  &POKEMONTRADE_UNION_PROC_FUNCTIONS, trade)` →
  `GSYS_GetProcMgrState` wait →
  evolution branch where applicable →
  `EventFieldOpen_CreateHeadless` → fade in.
- `include/app/pokemon_trade.h`: `OVERLAY_POKEMONTRADE` is overlay ID
  **194** and `PokemonTradeParam` contains game data, buffers, party/box
  location, and other state needed by the procedure.
- `src/ov194/pokemontrade_proc.c`, `PokemonTrade_StartRequest1`:
  initializes the Union trade using
  `GameData_GetPlayerInfoByNetID(trade->gameData, 1 - NetSystem_GetNetId())`.
  `PokemonTrade_IsNetwork` depends on `GFL_NetIsInitialized()`, and the
  procedure sends commands and times synchronization points via `NetHandle`.
- `include/app/pokemon_trade_local.h` lists native commands, including
  `TRADE_NET_CMD_MON`, `TRADE_NET_CMD_CURSOR`,
  `TRADE_NET_CMD_READY`, `TRADE_NET_CMD_BOX_INFO`, and
  `TRADE_NET_CMD_CHECK_RESULT`. Its `TradeBoxColors` covers 24 boxes
  × 30 slots and six party slots; the original trade UI has box handling.

Therefore **we cannot just jump to overlay 194** in an unassociated
single-player overworld. It would miss peer identities and synchronized
network state, and an incorrect handoff could hang or corrupt field state.

## Results so far

PRK62: locally decoded White 2 party records with matching box checksums.

PRK60/61: request/accept/decline/cancel/timeout protocol and visual feedback,
but **no native trade entry or Pokémon exchange**.

PRK63 live toggle test (one actual DS, fake P2):
- Native Wi-Fi power on: +1; off: +1
- Local transmit attempts: +337; ordinary RX polls: +65,174
- Host/reply polls: +0; NetPlay TX: +0

These are callback attempts, **not packets delivered or connections**.

## PRK65 implementation and live test

The pinned build-time patch instruments native `MP_SendPacket`,
`MP_SendCmd`, `MP_SendReply`, and `MP_SendAck` without changing their
return values or moving any frames. For each outgoing callback, it counts:

- 802.11 management, control, or data frames by the first frame-control byte
  after melonDS's 12-byte host Wi-Fi header.
- Management beacon and probe request/response subtypes (nested subsets).
- Native multiplayer command, reply, and ACK callback attempts.
- Empty/invalid outgoing buffers (which can include valid zero-length
  reply requests).

It never exposes frame bytes, MAC addresses, trainer data, save contents,
or packet payloads. `MP_RecvPacket` / `MP_RecvHostPacket` still return
zero; **no second DS is connected**. The classified total must equal the
native MP TX attempt total.

The diagnostic is visible in the existing PRK63/65 panel when running
the exact supported White 2 ROM:

```bash
git pull --ff-only origin mp/map-transition-recovery-v2
npm run build:melonds
npm run build
npm run dev:multiplayer
```

Test in **one tab** with the known working C-Gear *test copy*, not the
original save. Capture baseline, toggle C-Gear wireless off/on or open
Wireless, capture after. Report all counters plus the frame accounting
MATCH/MISMATCH result. ROM and save must be backed up; never use the
earlier broken C-Gear .sav.

## Remaining gates

1. After PRK65 classifications validate, create **two independent**
   emulated DS endpoints. Each needs its own save/ROM, native clock and
   wireless state. Do not treat the simulated remote trainer as a DS.
2. Implement bounded, opt-in raw radio queues in the WASM host platform
   (length/channel/timestamp limits, RX filtering, reset and teardown).
   Bridge peers through an explicit room-scoped transport with sequence
   numbers, backpressure, version checks and disconnect semantics.
3. Observe actual local wireless association in both games; verify native
   NetSystem/NetHandle identities and synchronization under real frames.
4. Add a two-sided, idempotent **trade launch barrier** after the existing
   PokeRun request/accept protocol. Abort/restore on mismatch,
   disconnected peer, unsupported map state or failed native association.
5. Research safe `GameEvent`/field-close/overlay-194 scheduling for the
   exact supported White 2 build. Test only with disposable save copies.
6. Run a full original trade with a pair of backed-up throwaway saves,
   compare both complete saves and Pokémon records, and validate rollback
   behavior before allowing production saves.

**Never** patch Pokémon ownership by guessing save bytes, open overlay 194
in an uninitialized net state, or run the native trade/Union procedure
via an unscheduled direct ARM9 call.
