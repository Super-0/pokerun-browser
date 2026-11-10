# PokéRun handoff

The tooling branch starts from `origin/mp/map-transition-recovery-v2` PRK80 `bf2c494`. Use [AGENTS.md](AGENTS.md) for the iteration rules, [DEVELOPMENT.md](DEVELOPMENT.md) for commands and [the PRK80 runbook](docs/PRK80_GREETING_RUNBOOK.md) for the paired capture. `main` is the older launcher. The Mac checkout had no local or remote tooling ref, so the tooling here was reconstructed from the desktop handoff in a new worktree. The desktop branch and private fixtures were unavailable here.

## Known PRK80 baseline from the desktop handoff

The [earlier PRK80 experiment](docs/PRK79_NATIVE_UNION_ROOM_ACCEPTANCE.md#prk80--read-only-native-reply-timing-vs-ack-failures) reached the Trade menu before stalling. The later two-emulator runs stalled at the normal greeting. Both used PRK75 isolation, separate disposable batteries, and 5 ms radio polling.

- The first follow-up showed “Talking to Memory...” and “Hello!” with no pre-greeting baseline. The peer sent 320 replies; the host queued 320, matched 0 in 794 polls, discarded 299 as stale and counted 794 failed-client ACKs. After the stall the DS cores ran at about 29 frames/s with no more reply or ACK activity.
- The healthier follow-up had native association and a pre-greeting 60.1/56.2 DS frames/s baseline at 1×. P2 briefly fell to 46/s. P1 showed “Memory did not reply...” and P2 showed “Communication error.” P2 sent 5,892 replies and P1 queued 5,892, with 736 matched, 5,110 empty polls, 46 queued-but-unmatched polls, 226 stale replies, 728 future matches, 5,156 failed-client ACKs and 736 ACKs without client failure. Neither player reached the Trade menu or a confirmation. Both radio links were stopped after capture.
- Desktop Windows used Node.js 24. The build and four browser tests passed there. That separate checkout's 512 MB Blob persistence fix and ROM hash guard were described in the handoff and are represented here with ROM-free compatibility coverage. The previous WSL/Linux runtime build used Emscripten 3.1.74. Its Windows-mounted equivalent failed on the first native patch.

## Local paired greeting capture

- On macOS, imported two valid disposable batteries through the lobby and verified distinct in-game Trainer IDs. The first browser reload could not restore the 512 MiB cartridge. Launcher reattachment durably restored it. Both players then saved normally at their Union Room counters. Each attempt used a fresh copy of that private checkpoint, 1× speed, PRK75 isolation, 5 ms radio and C-Gear off. The first two setup runs timed out before any invitation; automating room entry got both players into position.
- Trace off, `POKERUN_GREETING_TRACE=0 npm run test:white2`. Pre-greeting health after room entry was 60.05/59.94 DS frames/s. Both screens showed “Hello!” and P1 advanced to the Trainer Card response. The runner later timed out waiting for classification. No trade was confirmed. The private control evidence is under `local-test-assets/white2-run-5X41Gu/`.
- Trace on, `npm run test:white2`. Pre-greeting health after entry was 59.94/60.04 DS frames/s. After a positioning correction and one actual greeting, the last observed screens were P1 “Talking to…” and P2 “Hello!” before the runner timed out. Neither screen was observed reaching Trade or confirmation. Both links were stopped after capture. The complete, loss-free timing trace and screenshots are under `local-test-assets/white2-run-kyCGnw/`. Run `node scripts/summarize-greeting-trace.mjs local-test-assets/white2-run-kyCGnw`.
- Of 4,240 empty first host polls, 4,236 preceded the corresponding browser command send, two followed send but preceded peer arrival, and two followed peer arrival. Median native command to first poll was 0.070 ms. Median native TX to browser send was 8.04 ms across commands and replies. Median command and reply browser delivery was 6.74 ms and 4.08 ms respectively; every observed command or reply browser send had a matching arrival. Median reply arrival to native enqueue was below the clock's resolution. Native recorded 378 stale and 497 matched reply decisions. Stale versus matched reply timestamps also differed, but timestamp skew cannot explain a poll before the command left the host browser.

## Deterministic native reproduction

In Chromium with the opt-in test-hook WASM build, `npm run test:native:schedule` exercised the real command queue and native reply collector. With the same synthetic delivery and DS timestamps, polling before send or while the command was in flight produced an empty poll. Polling after enqueue matched the reply. At fixed late ordering, a 32 µs timestamp deficit matched and a 33 µs deficit was stale. This reproduces both mechanisms independently of ROMs, browser timers and live Wi-Fi.

## Deferred poll experiment

The opt-in `POKERUN_DEFER_HOST_POLL=1 npm run test:white2` trial added a 32 ms emulated delivery window ahead of host TX completion. The reply collector still used the original emulated timestamp and existing stale rule. At 59.97/59.98 DS frames/s before greeting, native association occurred and every first poll followed browser command send and peer arrival. The host matched 415 of 454 polls, with 39 empty polls, five stale dispositions, and 39 failed-client ACKs. The host reported that the peer did not reply while the peer displayed “Hello!” Neither reached Trade. The trace was complete and is under `local-test-assets/white2-run-bvZa1G/`.

The adaptive `POKERUN_DEFER_HOST_POLL=adaptive npm run test:white2` trial used the same saved checkpoints. Both DS instances sustained about 60 frames/s. Native association occurred, then the host displayed “did not reply” while the peer displayed “Hello.” All 503 replies arrived, queued, matched, finished hardware RX as normal MP data, entered the RX ring, and were retired by host cursor advances. The peer likewise committed and retired all 503 ACKs. The native ACKs reported no failed clients, but the host command counter was zero for every ACK. The loss-free trace is under `local-test-assets/white2-run-STl9hV/`. This rules out an empty host reply queue, default replies and missing peer ACKs in that capture. It does not establish that the game accepted the response contents.

PRK81I at `5815918` shows a dedicated worker can service cross-tab callbacks with shared memory while separate WASM workers boot and render ROM frames. Its probe exchanges controlled packets between game frame runs. It provides a path to avoid advancing emulated time while waiting for a browser reply, but the probe itself does not exercise the Union Room.

The `POKERUN_DEFER_HOST_POLL=preserve-counter npm run test:white2` trial held the command countdown only during the added adaptive wait. Both emulators stayed near 60 frames/s. All 520 replies matched and reached the host software cursor; the peer retired all 520 ACKs. None had an expired command counter. The host still reported that the peer did not reply. This rules out counter expiry as a sufficient explanation. The loss-free trace is under `local-test-assets/white2-run-oXVMdn/`.

## Next experiment

Test the guest’s normal dialogue input while the host is waiting, keeping the same checkpoints and adaptive scheduling. If neither screen advances, prioritize PRK81I’s worker design to preserve the full emulated RF timing window. Keep the native collector, original reply timestamps, and ACK success criteria intact.

## Verification for this worktree

On macOS with Node.js 24.13.0, `npm ci` and `npm run verify` passed (2 unit tests, production build with the bundle-size warning, and 4 Chromium tests). A second `npm run test:browser` passed on the same port. The clean pinned melonDS build passed with Emscripten 3.1.74, and `npm run test:native` verified stamp `0x50524B47`, queue observation and monotonic clock alignment in Chromium. The updated branch was not run on Windows or WSL. The real White 2 greeting captures are described above. Hosted CI remains unverified.
