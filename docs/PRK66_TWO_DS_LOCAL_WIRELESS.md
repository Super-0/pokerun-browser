# PRK66 — first two-real-DS, same-browser local wireless bridge

Status: **implemented in DEV-only code; uncompiled / not yet live tested**.

## Why this comes next

PRK63 (actual game): Wi-Fi power on/off occurred, +337 local TX attempts,
+65,174 ordinary RX polls, but no packet delivery. PRK65 found a clean
classification of 81/81 outgoing frames on another toggle: all 81 were
**802.11 management/beacon frames**; zero native MP commands, replies,
data frames, or other peer traffic. This proves that the actual DS advertises,
not that a second DS can discover it.

The intended product UX remains: walk up to a real friend's PokeRun trainer,
native White 2 Yes/No invitation, both accept, fade the field and launch the
real White 2 overlay-194 trade UI, then return to the overworld. **None of
the trade launch or save/party exchange is enabled by PRK66.**

## What PRK66 adds

- An opt-in, **disabled-by-default** radio queue in the pinned melonDS
  `WasmEmulator`. Per-DS buffers are guarded by a native mutex. Queue sizes
  are 32 TX + 32 RX frames; frame sizes are bounded at 36–2048 bytes,
  the native `Wifi::RXBuffer` size. Each frame's 12-byte radio header
  length is verified.
- When enabled, native `MP_SendPacket`, `MP_SendCmd`,
  `MP_SendReply`, `MP_SendAck` enqueue frames. Native
  `MP_RecvPacket` and `MP_RecvHostPacket` can consume received frames.
  `MP_RecvReplies` is **still stubbed to zero**. Native trade traffic,
  host reply aggregation and stable association are **not demonstrated**.
- Embind functions export frame copies (not pointers to temporary buffers)
  and let the owning emulator queue incoming frames.
- Browser-side `White2NativeRadioLink` creates a **same-origin
  BroadcastChannel**, scoped by room and game-start ID. Both actual DS
  player IDs and exact White 2 ROM SHA-256 must match. The two emulators
  must use **different battery-save profile IDs**.
- Handshakes every 750 ms, peer expires after 2500 ms, a maximum of
  32 frames processed per 50 ms tick, and bounded input-validation.
  No server, Internet relay, ROM upload, logging of payloads, IndexedDB
  storage of frames, native overlay calls or Pokémon mutation.
- A DEV diagnostic in the PRK63/65 panel requires **manual opt-in on
  both game tabs**. It distinguishes browser hello LINKED from real
  outgoing browser transmissions, incoming queue injection, and native
  incoming consumption. STOP clears native queues. An offline tab
  disables native transport.

## Launch safely

1. **Back up original working saves** before trying PRK66; don't run this
   experiment using an irreplaceable or active production save.
2. Use `/multiplayer-dev.html` on the **same browser origin** as both
   player tabs. Select **two distinct saved profiles** with the same
   verified White 2 ROM. The launcher blocks selecting the exact same
   save for both players. If the second save is not prepared, create
   another disposable test slot first.
3. Click `LAUNCH PLAYER 1 + PLAYER 2`, not the
   `LAUNCH PLAYER 1 + FAKE REMOTE` shortcut. The fake P2 does not have
   a real melonDS radio and cannot participate.
4. Confirm both real games are running and in the same PokeRun room,
   with each game's C-Gear enabled (if normally available).
5. On **both tabs**, expand `PRK63/65` and click
   `START LOCAL DS RADIO` under `PRK66`.
6. Verify both show **LINKED**, meaning only browser handshakes succeeded.
   Then toggle wireless C-Gear normally. Report per-side:
   browser TX, browser RX, native outgoing enqueued, incoming enqueued,
   incoming consumed, drops, and any visible in-game discovery.
7. Click `STOP & CLEAR RADIO QUEUES` on both tabs before leaving. Do not
   enter a native trade or write/force game flags.

Build commands:

```sh
git pull --ff-only origin mp/map-transition-recovery-v2
git rev-parse --short HEAD
npm run build:melonds
npm run build
npm run dev:multiplayer
```

The native build patch must be applied after PRK63/PRK65 and verifies a
new version stamp `0x50524B3F`. A failed C++ or TypeScript build is
**a failure**, not confirmation of working packet transport. A live
local test is required even after build succeeds.

## Interpretation

- **LINKED** alone = two browser control messages matched (not DS radio).
- Browser TX + RX >0 = browser-local frames were transferred between tabs
  (not necessarily consumed by emulated hardware).
- Native RX queued + consumed >0 = at least one emulator read a frame,
  still not proof it accepted it on the proper channel.
- In-game nearby-player discovery or a valid native NetSystem handshake
  would be the next much stronger milestone.
- Zero or dropped frames require targeted investigation; never jump to
  trade procedure overlay 194 based only on a linked status.

**Known limitations / future work**: host-reply aggregation, clock and
timestamp synchronization between independent emulators, channel matching
and RF contention, reliable queue scheduling, Internet transport/security,
both-player native NetSystem identities, safe fade/field-close/overlay
handoff, trade-evolution and rollback-aware save verification.

Source basis: pinned `brxxn/ds-anywhere` `Wifi.cpp`, `Wifi.h`,
`WasmPlatform.cpp` and `WasmEmulator`; public `fuddlesworth/pokebw2`
`src/ov028/union_subproc.c`, `src/ov194/pokemontrade_proc.c`.
