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


## Actual first PRK66 two-DS result (November 4, 2026)

First successful same-browser real-DS link, with two distinct test slots:

| Counter | Player 1 | Player 2 |
|---|---:|---:|
| Browser sent | 39 | 32 |
| Browser accepted received | 14 | 37 |
| Browser rejected received | 0 | 8 |
| Native TX queued | 39 | 33 |
| Native RX queued | 14 | 37 |
| Native RX consumed | 14 | 37 |
| Native drops | 0 | 6 |

**Conclusion:** Two *actual* independent emulators transmitted frames
bidirectionally over the development bridge and returned native receive
callbacks with payload lengths above zero. No in-game wireless association,
peer discovery, or trade was established. Snapshots were not synchronous;
the counters are **not a packet-loss accounting identity**. Some rejected
browser frames and dropped native frames require diagnosis.

## PRK67 receiver audit (next milestone)

Adds a strictly source-matched, read-only hook to the pinned
`Wifi::CheckRX` execution path. Records only frames dequeued from PRK66
(the emulator's `WifiAP` fallback is not included):

- `Wi-Fi accepted`: passed length, channel and native pre-association
  MP-frame filtering and reached the normal StartRX/MP-state path.
- `Bad length`: too short or inconsistent radio frame length.
- `Wrong channel`: channel didn't match the Wi-Fi hardware's current
  channel, or hardware channel was zero.
- `MP filtered`: multiplayer-only destination discarded before
  establishing the native multiplayer session.
- `Beacons accepted`: 802.11 beacon subtype among accepted frames.
- `Association responses accepted`: the native Wi-Fi client received
  a positive AID from a valid-timestamp, destination-accepted association
  response and entered `IsMPClient` mode. This is **not** an end-to-end
  game trade or completed NetSystem handshake.

These are per-emulator counters only; no raw wireless contents, addresses,
or trainer/party/save bytes are exposed. PRK67 changes the runtime build
stamp to `0x50524B40` and **requires rebuilding melonDS** before
using the new panel. The pinned-source patch sequence was dry-run against
the exact DS Anywhere revision and verified to find each unique anchor.
The native C++ and game runtime have **not** yet been compiled/live-tested
with PRK67 in the user's Codespace.

Expected next test: reload two *different disposable* saves after the
rebuild; start PRK66 on both tabs, activate C-Gear on both, then compare
`PRK67 NATIVE WI-FI` acceptance and rejection counters. Do not initiate
a trade or modify either save. If accepted beacon counts rise but there
is no native association, investigate Wi-Fi MAC uniqueness, channel
alignment, timestamp synchronization and background-tab throttling before
queuing overlay 194.


## PRK67 live receiver results — November 4, 2026

Two real White 2 instances with PRK66 enabled:

| Native Wi-Fi metric | Player 1 | Player 2 |
|---|---:|---:|
| Passed CheckRX validation | 11 | 13 |
| Passed, beacon subtype | 11 | 13 |
| Rejected: wrong channel | 39 | 67 |
| Rejected: bad length | 0 | 0 |
| Filtered: pre-MP destination | 0 | 0 |
| Positive-AID association accepted | 0 | 0 |

**Interpretation:** Both receive paths reached native CheckRX acceptance
for beacon frames. Most received frames did not match the instantaneous
RF receive channel. Because `Wifi::ChangeChannel` is controlled by the
game's radio-register writes, this may represent normal channel scanning
or unsynchronized radio dwell. A CheckRX-accepted beacon is **not** proof
it was committed to the emulated hardware RX ring or that White 2's
higher-level discovery/association observed a peer. No association
responses were accepted, and no trade path is ready.

## PRK69 channel research (next test)

PRK69 adds source-matched, read-only per-DS channel histograms:
- **TX:** the 12-byte native-radio-header channel of outgoing packets
  successfully placed into the PRK66 transport queue.
- **Accepted RX:** source channel of each PRK66 native frame that passed
  CheckRX length, RF-channel and early MP filtering.
- **Wrong-channel RX:** source channel of each PRK66 native frame rejected
  because it differed from the emulator's instantaneous channel (or the
  current channel was invalid).
- **RF tuned to:** number of *actual channel changes* initiated by game
  writes to RF tuning registers, as observed by `Wifi::ChangeChannel`.
- **Current RF channel:** latest game-requested channel value.

No channel is forced, no timestamps are rewritten, and no wireless
payload, MAC address, trainer identity or save data is exposed.

The pinned build patch sequence now ends at PRK69 stamp `0x50524B41`.
The full source-rewrite chain PRK63 → PRK65 → PRK66 → PRK67 → PRK69
has passed strict unique-anchor simulation on pinned melonDS files.
A C++ compilation and game test are **not yet verified** here.

Run the normal fresh-WASM build, then launch two different disposable
save profiles, start PRK66 radio on both real tabs, and open the C-Gear
WIRELESS screen. Read PRK69 channel lines on each DS. Stop both bridges
before closing tabs. Do not attempt native trading or edit progress flags.

What we will learn:
- If RF tuned changes and both sides transmit over several channels,
  channel mismatch may be expected scanning.
- If both stay tuned to different fixed channels, investigate the game
  state and RF configuration.
- If channels overlap but White 2 cannot discover a peer, next inspect
  the downstream receive-ring commit, BSSID/MAC filtering, and native
  handshake prerequisites—not a forced channel override.
