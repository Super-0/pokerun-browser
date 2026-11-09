# PokéRun handoff

The tooling branch starts from `origin/mp/map-transition-recovery-v2` PRK80 `bf2c494`. Use [AGENTS.md](AGENTS.md) for the iteration rules, [DEVELOPMENT.md](DEVELOPMENT.md) for commands and [the PRK80 runbook](docs/PRK80_GREETING_RUNBOOK.md) for the paired capture. `main` is the older launcher. The Mac checkout had no local or remote tooling ref, so the tooling here was reconstructed from the desktop handoff in a new worktree. The desktop branch and private fixtures were unavailable here.

## Known PRK80 baseline from the desktop handoff

The [earlier PRK80 experiment](docs/PRK79_NATIVE_UNION_ROOM_ACCEPTANCE.md#prk80--read-only-native-reply-timing-vs-ack-failures) reached the Trade menu before stalling. The later two-emulator runs stalled at the normal greeting. Both used PRK75 isolation, separate disposable batteries, and 5 ms radio polling.

- The first follow-up showed “Talking to Memory...” and “Hello!” with no pre-greeting baseline. The peer sent 320 replies; the host queued 320, matched 0 in 794 polls, discarded 299 as stale and counted 794 failed-client ACKs. After the stall the DS cores ran at about 29 frames/s with no more reply or ACK activity.
- The healthier follow-up had native association and a pre-greeting 60.1/56.2 DS frames/s baseline at 1×. P2 briefly fell to 46/s. P1 showed “Memory did not reply...” and P2 showed “Communication error.” P2 sent 5,892 replies and P1 queued 5,892, with 736 matched, 5,110 empty polls, 46 queued-but-unmatched polls, 226 stale replies, 728 future matches, 5,156 failed-client ACKs and 736 ACKs without client failure. Neither player reached the Trade menu or a confirmation. Both radio links were stopped after capture.
- Desktop Windows used Node.js 24. The build and four browser tests passed there. That separate checkout's 512 MB Blob persistence fix and ROM hash guard were described in the handoff and are represented here with ROM-free compatibility coverage. The previous WSL/Linux runtime build used Emscripten 3.1.74. Its Windows-mounted equivalent failed on the first native patch.

## Next experiment

Prepare both saved Union Room checkpoints with verified distinct trainer IDs and a fresh local browser profile on the target machine. Run one trace-off and one trace-on attempt using the private runner. Record both pre-greeting frame rates, native association, outcome on each screen, trace loss and whether the first observed empty host polls preceded peer emission, delivery or enqueue. Run the timing summary and inspect representative stale and matched rows before proposing a transport edit. The aggregate desktop counters alone cannot identify the cause.

## Verification for this worktree

On macOS with Node.js 24.13.0, `npm ci` and `npm run verify` passed (2 unit tests, production build with the bundle-size warning, and 4 Chromium tests). A second `npm run test:browser` passed on the same port. The clean pinned melonDS build passed with Emscripten 3.1.74, and `npm run test:native` verified stamp `0x50524B47`, queue observation and monotonic clock alignment in Chromium. The updated branch was not run on Windows or WSL. The real White 2 scenario and hosted CI remain unverified here.
