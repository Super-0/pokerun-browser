# PokéRun agent workflow

Read [DEVELOPMENT.md](DEVELOPMENT.md), [HANDOFF.md](HANDOFF.md) and the feature's research notes before changing emulator, save or multiplayer behavior. For PRK80 use the [greeting runbook](docs/PRK80_GREETING_RUNBOOK.md). The tooling baseline is `bf2c494` on `origin/mp/map-transition-recovery-v2`; `main` is an older launcher.

## One bounded iteration

1. Record branch, SHA, working-tree status, platform, tool versions and the expected behavior. Preserve unrelated work. Use a separate worktree if the active checkout is dirty. Confirm the required assets, runtime stamp, origin, browser and saved checkpoints are available before selecting a test tier.
2. Pick one falsifiable hypothesis. Reproduce once on the baseline with one positive and one negative observable assertion. If it fails to reproduce, verify setup and make at most one controlled repeat. Label missing prerequisites and inconclusive runs separately from regressions.
3. Add a test at the lowest layer that can reproduce the fault faithfully. Use a unit test for deterministic logic, browser coverage for UI, cross-tab transport and IndexedDB, and real two-DS gameplay for native RF or game acceptance. Write the assertion against the user-visible outcome plus the boundary where it breaks. Verify that a regression test fails for the intended reason before editing when feasible. An observability-only change needs a test for the observation and proof that enabling it preserves the radio path.
4. Use temporary or opt-in bounded instrumentation first when the cause is unknown. Record expected event order and collect timestamps, counters and correlated events. Keep protocol payloads and private IDs out of logs. For PRK80, establish delivery timing, poll ordering and effective clock offsets before editing transport logic.
5. Make the smallest justified edit. Run the targeted reproducer, then `npm run verify`. Native changes also need a clean targeted build and `npm run test:native`; gameplay claims require the private scenario and paired evidence. Rerun once with fresh state if the result could depend on leftovers or scheduling.
6. Review the diff and staged paths. Commit atomic changes and update the handoff with exact commands, observed results, artifact location by relative directory only, remaining uncertainty and the next single experiment. Distinguish local results from hosted CI.

Stop after two implementation iterations without new discriminating evidence, a second inconclusive reproduction, or a missing prerequisite that prevents the next useful check. For a private attempt, stop after one invitation, a timeout, degraded health, wrong identities or missing association. Preserve evidence and report the stopping point. A pass, failing assertion, setup blocker and flaky result each get a distinct label. Keep the strongest negative result in the handoff.

## Data and claim boundaries

- Use synthetic fixtures in CI. Keep ROMs, saves, browser profiles, private drivers, screenshots, traces and console dumps under ignored `local-test-assets/`. Keep original saves out of disposable browser slots. Never stage private assets, add them to Vite's public directory, upload them to CI or paste them into chat.
- Distinguish lobby pairing, browser radio link, native association, native greeting, Trade menu and trade confirmation. Assert each stage separately. A fake peer and advancing DS frames do not demonstrate native trading.
- Use pinned native source and the build wrapper. The wrapper modifies and resets its submodule during the build. Run it only in a clean disposable submodule checkout.
