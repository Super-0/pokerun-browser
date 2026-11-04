# PRK63 — Native White 2 trade feasibility (research gate)

## Decision being tested

Can PokéRun eventually reuse White 2's actual local-wireless trading interface
and trade game logic, instead of rewriting Pokémon ownership/save mutations?

**Status: diagnostic instrumentation implemented; live emulator test pending.**
No native trade, linked DS, packet delivery, or game-memory mutation exists yet.

## Evidence

- The pinned submodule is `brxxn/ds-anywhere` revision
  `53c7c6cb362560a9e362ae754a162f638fa3cd64`.
- `wasmelonDS/src/Wifi.cpp` calls `Platform::MP_Begin` and `MP_End`
  when the emulated Wi-Fi hardware powers on/off; it also calls
  `MP_SendPacket`, `MP_SendCmd`, `MP_SendReply`, `MP_SendAck`,
  `MP_RecvPacket`, `MP_RecvHostPacket`, and `MP_RecvReplies`.
- In the pinned WASM `WasmPlatform.cpp`, all those callbacks were empty
  stubs, and the nonvoid callbacks had no return statement. This means
  the current WebAssembly build has **no functioning DS-to-DS radio link**.
- PRK63 replaces those empty stubs with atomic, per-emulator counters
  and deterministic **zero** (no packet) returns. This is a small change
  from undefined nonvoid return behavior, but still does not route packets.
- The browser's existing PRK60/61 trade request and simulated P2 are a
  completely different protocol; they do not demonstrate native RF.
- White 2's native trading is gated behind the Basic Badge and C-Gear.
  Infrared trading and Union Room *local wireless* are different modes.
  PRK63 measures only the melonDS Wi-Fi callback boundary; it is not
  an infrared protocol implementation.

## What PRK63 changes

1. Build-time strict-source instrumentation: `scripts/build-melonds.mjs`
   inserts six atomic diagnostic counters into the pinned WASM
   `WasmEmulator` and instruments `Platform` callbacks.
   This transformation is checked against exact source strings and
   resets the submodule afterward, like the existing pinned patches.
2. The stamped and export-verified WASM runtime exposes:
   `prk63WifiStarts`, `prk63WifiStops`,
   `prk63MpTxCalls`, `prk63MpRxPolls`,
   `prk63MpHostRxPolls`, `prk63NetTxCalls`.
3. `MelonDsBridge.getNativeWirelessProbeCounters()` reads the six values
   without guest-memory reads/writes or calls into native game functions.
4. The **PRK63 • NATIVE WHITE 2 WIRELESS FEASIBILITY** panel in the
   existing multiplayer-dev view captures before/after values manually.

Privacy/safety boundaries: only counts are exposed, never packet payloads,
trainer IDs, Pokémon bytes, save blocks or game-memory writes. No actual
transport is enabled. A new melonDS build is required due to the stamp
change from `0x50524B3C` to `0x50524B3D`.

## Manual single-emulator test

```bash
cd /workspaces/pokerun-browser
git pull --ff-only origin mp/map-transition-recovery-v2
git submodule update --init --recursive
npm run build:melonds
npm run build
npm run dev:multiplayer
```

Load the same exact White 2 ROM and save as PRK62. Leave the P2 simulator
in place. Expand PRK63 below the emulator:

1. Click **CAPTURE BASELINE**.
2. If C-Gear/Union Room is already available on this save, use the game's
   normal local-wireless menus. Do **not** use the IR trade path as a
   proxy for Wi-Fi behavior.
3. Click **CAPTURE AFTER GAME ACTION**.
4. Share the panel counts or the console line
   `PRK63 NATIVE WIRELESS TELEMETRY`.

If the save hasn't earned the Basic Badge or C-Gear, do not alter the save
or trigger unsupported guest calls just to force wireless. Capture a
baseline/after in the overworld and label the result **not exercised**.

Interpretation:

- Wi-Fi power starts increment: DS Wi-Fi callback exercised.
- MP transmit attempts increment: the native game tried to emit radio
  frames, but our WASM port delivered **zero packets**.
- Receive polling increments: native Wi-Fi receive loop reached the
  stub, but no packet was delivered.
- Zero deltas: inconclusive when a wireless-enabled game action wasn't
  available or hardware was already on before baseline.
- Nonzero counters **never** mean a real multiplayer connection exists.

## Next research gates (not yet implemented)

1. Verify native MP callbacks live under actual White 2 local-wireless
   conditions using PRK63; confirm startup and normal game behavior.
2. Prototype a deterministic local frame queue between *two independent*
   emulator instances, with a bounded queue, timestamps and event traces
   (no live save-to-save transfers). Do this in a separate integration test.
3. Check discovery/association timing and the original Union Room menus.
   If the game cannot establish a reliable peer, stop rather than
   emulating a game-native trade by guessed save writes.
4. Only then test the native game's original offer/selection/confirmation
   flow with throwaway saves and rollback/backups; no production save
   transfer until both sides are validated.

Native wireless may be substantially more expensive than a controlled
PokéRun trade transaction. PRK63 is an evidence-gathering step, not a
commitment that native trading will be straightforward.
