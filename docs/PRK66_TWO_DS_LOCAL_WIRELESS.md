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


## PRK69 actual two-DS channel data — November 4, 2026

Two independently running games, cumulative counters:

| Measurement | Player 1 | Player 2 |
|---|---:|---:|
| Current RF channel | 7 | 1 |
| RF channel changes | 419 | 387 |
| TX channels | ch7:36, ch13:35 | ch1:19, ch7:15, ch13:12 |
| Accepted RX | ch7:15 | none in this capture |
| Wrong-channel RX | ch1:14 | ch7:33, ch13:1 |
| RF tuned to | ch?:209, ch1:67, ch7:73, ch13:70 | ch?:193, ch1:62, ch7:67, ch13:65 |

RF-tuning rows are attributed by their sum (419 for Player 1 and 387 for Player 2), since the pasted snippets interleaved the two blocks. The RF hardware cycles repeatedly through channels **1, 7, 13**.
The large channel-0 / invalid entries likely reflect intermediate tuning
register writes; do not assume the radios are permanently misconfigured.
The captures are from different points in time and must not be treated
as matched packet-loss accounting. A checkRX-accepted beacon is not
proof that the emulated game received an RX interrupt or discovered a
real player. We should not override channels based on this evidence.

## PRK70 downstream receive audit

PRK70 instruments the *pinned melonDS Wi-Fi implementation* without
changing the game's radio tuning, packet contents or save data.

1. For incoming PRK66 beacons, after checking frame length but **before
   channel filtering**, it tests whether the beacon transmitter's
   802.11 source address equals the local Wi-Fi MAC. Only same/different
   aggregate counters are exposed. The raw six bytes are never exported.
2. For actual PRK66 frames that pass CheckRX, a temporary, emulator-local
   provenance bit marks the asynchronous `Wifi::FinishRX` path.
   It counts completed hardware receive operations, destination filtering,
   WEP filtering, BSSID matches on beacons, beacon receive-filter drops,
   and IRQ 0 after successfully committing the frame to the Wi-Fi RX ring.
   The bit is cleared on reset and at FinishRX.
3. The exact pinned-source rewrite sequence PRK63 → PRK65 → PRK66 →
   PRK67 → PRK69 → PRK70 passed unique-anchor validation against
   upstream files. The new runtime stamp is `0x50524B42`. Compilation
   and actual White 2 behavior are **not verified yet**.

### How to interpret PRK70

- **Beacon same MAC > 0**: at least one incoming beacon appears to use
  this DS's *own* MAC as its transmitter address. That is strong evidence
  of a duplicate MAC configuration when paired with two actual DSs.
  We must investigate distinct per-emulator firmware/MAC identities
  **before** allowing any native trade.
- **Different MAC > 0**: some incoming beacons carry a different
  source address; does not by itself prove native association.
- **Wi-Fi accepted > 0 but native RX finished = 0**: a later receive
  pipeline step did not complete; examine timing/teardown before making
  changes.
- **Native RX finished > 0 but RX ring/IRQ = 0**: downstream receiver
  filtering or no valid ring commit likely prevented delivery.
- **RX ring/IRQ > 0**: emulated Wi-Fi hardware notified the DS of
  a frame, but does not prove White 2 understood the beacon or
  began its trade networking protocol.
- **Association accepted = 0** remains a hard limitation on claiming
  the game has discovered and associated with a remote DS.

Test with two *different disposable* battery save slots and a verified
matching White 2 ROM. Stop radio before leaving the page, rebuild WASM,
restart dev server, and enable PRK66 on both tabs. Compare PRK70 counters
with PRK67 and PRK69, and **do not invoke overlay 194 or trade**.


## PRK70 live result — duplicate firmware wireless identities found

Two independently running genuine White 2 emulator tabs, in the same
PRK66 browser-local room:

| PRK70 counter | Player 1 | Player 2 |
|---|---:|---:|
| Incoming beacon sender = own MAC | 34 | 76 |
| Incoming beacon sender differs | 0 | 0 |
| Native Wi-Fi RX completed | 24 | 25 |
| Native RX ring interrupt | 24 | 25 |
| Destination filtered | 0 | 0 |
| WEP filtered | 0 | 0 |
| Beacon BSSID matched | 0 | 24 |
| Beacon RX-filter rejected | 0 | 0 |

Both native receive paths delivered frames through IRQ 0, but **every**
incoming beacon compared equal to the receiver's own MAC. This strongly
indicates both emulator instances generated the same DS wireless identity,
rather than behaving like two independent consoles. BSSID matches alone
do not imply peer association.

The upstream default firmware includes a static
`Firmware::FirmwareHeader::MacAddr` (its default constant is in
`SPI_Firmware.h`). `WasmFirmwareSettings::toFirmware()` constructs that
firmware separately for every `WasmEmulator`, but did not distinguish
players. `WasmEmulator::loadFreeBIOS()` installs it before ROM boot.

## PRK71 — per-DS firmware identity fix (next live test)

PRK71 changes the **in-memory generated firmware only**. The new
`WasmEmulator::prk71SetFirmwareMacRole(role)` is called **before**
`loadFreeBIOS()`, and its `genFirmware()` assigns two distinct
unicast locally administered MAC addresses for roles 1 and 2, updating
the Wi-Fi firmware checksum via `Firmware::UpdateChecksums()`.

- Applied only by the real P1/P2 dev launcher with the verified White 2
  ROM. Never applied to the simulated fake player or normal single-player
  browsing.
- Never writes back a firmware file, battery save, game ROM or Pokémon.
- Immutable once the current emulator generated its firmware.
- The radio bridge refuses to start unless the local applied firmware
  role matches its actual P1/P2 tab, and its peer advertises the opposite
  role. MAC bytes are not logged or sent via the protocol.
- The PRK71 UI shows **firmware role applied** plus the existing PRK70
  *actual wireless frame MAC-equality* diagnostic. The role is an
  initialization acknowledgement, not proof of on-air correctness.
- Existing RF channel and receive instrumentation remains in place.

**Expected test:** after a fresh native WASM rebuild and full restart,
launch two independent disposable saves, then start PRK66 on both game
tabs and activate C-Gear Wireless. Both should show PRK71 role P1/P2.
The PRK70 readings should switch toward **same MAC = 0** and
**different MAC > 0** as each receives the other console's beacons.
An unchanged same-MAC result would indicate firmware identities did not
reach the in-game Wi-Fi transmitter correctly; stop and investigate.
Check PRK67 accepted beacons, PRK70 downstream IRQ and association
responses as before. **Do not attempt a native trade yet**.

Pinned source patch-chain rewrite for PRK63 → PRK65 → PRK66 → PRK67
→ PRK69 → PRK70 → PRK71 passes all exact-source context guards.
The resulting firmware identity build stamp is `0x50524B43`.
The C++ compile and in-game PRK71 behavior remain **unverified**
until tested in the user's Codespace.
