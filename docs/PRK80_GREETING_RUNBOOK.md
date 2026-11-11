# PRK80 native Union Room greeting

The immediate experiment is a read-only paired capture. Preserve the 5 ms radio pump, PRK75 isolation, checkpoint positions, game speed, and browser mode while comparing trace off and trace on. The test asserts the known failure and exits nonzero on another outcome so it can be classified from the paired evidence.

## Prepare private checkpoints

1. Build and verify the paired JS/WASM from the same commit with `npm run test:native`. Use an ignored `local-test-assets/` folder for the verified user-owned White 2 cartridge, two valid progressed 512 KiB battery saves with distinct in-game Trainer IDs, any driver, the profile and the evidence. Confirm `git check-ignore local-test-assets/check.nds local-test-assets/check.sav local-test-assets/check.png`.
2. Run `npm.cmd run test:white2:prepare` on Windows or `npm run test:white2:prepare` on macOS/Linux. Use only `http://127.0.0.1:4181` in the launched browser. Open Player 1 from the launcher, create a lobby and use **SELECT WHITE 2 ROM**. In the saved-game card use the import-test-copy action for each battery image. Import exercises the existing progressed-save validator and preserves the source. Wait for persistence before reloading. If the cartridge is missing after a reload, use the launcher's reattach action with the same verified ROM.
3. Return to the launcher and choose two different imported slots explicitly. Launch both with PRK75 isolation. Verify both Trainer IDs in-game, go to the same respective Union Room entrances, and save normally in-game. Close all checkpoint Chromium windows to flush the profile. The runner clones the browser storage holding the checkpoints and slot selections into a new private run directory before every attempt. Keep the checkpoint directory closed while copying it. Avoid reusing the live run directory as a checkpoint.
4. For a guided first run in Windows PowerShell:

   ```powershell
   $env:POKERUN_MANUAL = '1'
   npm.cmd run test:white2
   Remove-Item Env:POKERUN_MANUAL
   ```

   On macOS/Linux use `POKERUN_MANUAL=1 npm run test:white2`. The runner opens two headed pages and prompts for the checkpoint and one attempt. Slow headed emulation is a setup failure. For the repeatable headless run use an input driver.

## Automate the scenario

Create `local-test-assets/white2-greeting-driver.mjs` with two required exports and an optional staging export. Use Playwright keyboard and touchscreen controls against the saved checkpoint, record visual confirmation for each game stage, and keep any reference screenshots private. Use a stable frame or screen-state check before each input sequence. Record the driver revision in sanitized notes. A real driver depends on the supplied checkpoint positions and trainer state.

```js
export async function prepareGreeting({ pages: [p1, p2] }) {
  // Observe both trainer cards and move both to the recorded starting position.
  // Report true only after checking each screen against the private fixture.
  return { distinctTrainerIds: false, atGreetingCheckpoint: false }
}

export async function stageGreeting({ pages: [p1, p2] }) {
  // Optional. After radio starts, enter both Union Rooms, verify peer
  // discovery, and position the host. Leave the invitation for the next step.
}

export async function attemptGreeting({ pages: [p1, p2] }) {
  // Walk into the Union Room, verify native association, and try one normal
  // invitation. Observe both screens. Return booleans derived from the outcome.
  return { association: false, greetingFailed: false, tradeMenu: false, tradeConfirmed: false }
}
```

Run `npm.cmd run test:white2` or `npm run test:white2`. The script verifies the selected slots, waits for two running DS instances, checks 1× speed and 5 ms linked radio status, and measures a pre-greeting window of at least five seconds at 55–65 DS frames/s per page around the 60 FPS target. The driver has up to 120 seconds to prepare, up to 90 seconds for optional Union Room staging, and 45 seconds for one greeting attempt, or 180 seconds when explicitly checking trade confirmation. A staged run also measures both frame rates for five seconds after entry. An optional `dispose()` export can close driver-owned resources after success or timeout. Screenshots, rendered panel counters, trace batches and stage status stay under `local-test-assets/white2-run-*/`. A link-level `LINKED` badge only confirms the browser handshake. The runner checks for a native association-response frame received by hardware. Use that evidence and both game screens to classify the attempt.

Set `$env:POKERUN_GREETING_TRACE = '0'` in Windows or prefix `POKERUN_GREETING_TRACE=0` on macOS/Linux for the control run. Then remove the variable or set it to 1 and repeat once on a fresh profile copy. Compare DS health, counter deltas and both dialogs. Degraded health or trace overflow invalidates timing conclusions.

## Exercise a proposed fix

The runner defaults to reproducing the historical greeting failure. Set `POKERUN_EXPECT_WHITE2=trade-menu` or `POKERUN_EXPECT_WHITE2=trade-confirmed` for a positive test. A confirmed trade requires both game screens and the driver's explicit confirmation. A native association response is required independently.

For the bounded scheduling experiments, set `POKERUN_DEFER_HOST_POLL=1` for a fixed 32 ms emulated wait or `POKERUN_DEFER_HOST_POLL=adaptive` for readiness checks roughly every 1 ms up to 48 ms. Use `preserve-counter` to run the adaptive wait while holding the hardware command countdown only during that added wait. All variants retain the original DS poll timestamp for the existing reply rules. Unset the variable for the standard poll path. In PowerShell set the same variables through `$env:POKERUN_DEFER_HOST_POLL` and `$env:POKERUN_EXPECT_WHITE2` before running `npm.cmd run test:white2`.

## Run the opt-in frame worker

Build the worker-enabled runtime in the clean native checkout. The ARM9 option also records what the guest firmware and host game receive.

```bash
POKERUN_NATIVE_WORKER_RADIO=1 POKERUN_TRACE_ARM9_GFL=1 npm run build:melonds
POKERUN_WORKER_RADIO=1 npm run test:native
POKERUN_WORKER_RADIO=1 POKERUN_TRACE_GAME_NEGOTIATION=1 POKERUN_EXPECT_WHITE2=trade-menu npm run test:white2
```

On Windows, build the JS/WASM pair in WSL, copy it into the Windows checkout's ignored `public/emulators/melonds/`, set `$env:POKERUN_WORKER_RADIO = '1'`, `$env:POKERUN_TRACE_GAME_NEGOTIATION = '1'` and `$env:POKERUN_EXPECT_WHITE2 = 'trade-menu'`, then run `npm.cmd run test:native` and `npm.cmd run test:white2`. Clear `POKERUN_DEFER_HOST_POLL` before the worker experiment. The regular runtime and the regular browser path remain available with the worker option unset.

The frame pthread pauses emulated execution at the native host reply poll and the guest's next host-frame receive after transmitting a reply. The existing same-origin link relays the exact frames. Its native output notification wakes the browser relay without waiting for the periodic tick. The wait is bounded in wall time and releases when the link stops. Compare pre-greeting frame health, guest ACK indications, host datasets and both screens.

## Use local wireless in the normal PokéRun interface

The feature defaults off. Build the worker-enabled runtime and enable the browser feature when starting Vite.

```bash
POKERUN_NATIVE_WORKER_RADIO=1 npm run build:melonds
VITE_POKERUN_WHITE2_LOCAL_MULTIPLAYER=1 npm run dev
```

On Windows build the worker runtime in WSL and copy the generated JS/WASM pair into the ignored emulator directory. Set `$env:VITE_POKERUN_WHITE2_LOCAL_MULTIPLAYER = '1'` and run `npm.cmd run dev`. A production bundle uses the same flag at `npm run build` time and requires the cross-origin isolation headers used by the local server.

Open two tabs in the same browser profile. In each tab open **Multiplayer** and choose White 2. Create the room in the first tab and join with its code in the second. Continue a different verified save in each tab, ready both players, and start the game. Choose **Connect Local Wireless** on both tabs and enter the Union Room in the game. Use the in-game menus for the trade. Keep the saves in their own slots and allow the game save to finish before leaving.

The private normal-interface regression uses those same controls and checks both persisted parties.

```bash
VITE_POKERUN_WHITE2_LOCAL_MULTIPLAYER=1 POKERUN_WHITE2_NORMAL_UI=1 \
POKERUN_WHITE2_UNATTENDED=1 POKERUN_WORKER_RADIO=1 \
POKERUN_TRACE_GAME_NEGOTIATION=1 POKERUN_EXPECT_WHITE2=trade-confirmed npm run test:white2
```

Set `POKERUN_WHITE2_RECONNECT=1` to stop and rejoin local wireless before entering the Union Room. Set `POKERUN_WHITE2_INVITING_PLAYER=2` to reverse the in-game invitation, and `POKERUN_WHITE2_TRADES_PER_SESSION=2` to verify a second persisted exchange in the same session. The private driver supplies both invitation orientations and an `attemptAnotherTrade` callback for the second exchange.

## Repeat fresh-session trades

The local streak command starts a new Chromium profile from the same disposable checkpoint for each attempt. It uses the private driver in unattended mode. The driver must throw when it cannot complete a step without intervention. It returns `exchangeSubmitted: true` only after both normal in-game confirmations. The runner verifies the resulting exchange from the saved batteries. The batch keeps a private result ledger and per-attempt logs. A failed attempt resets the streak. Two consecutive failures at the same stage end the batch so that stage can be diagnosed.

```bash
npm run test:white2:streak -- 10 16
```

On Windows use `npm.cmd run test:white2:streak -- 10 16` with the worker JS/WASM installed. The two numbers are the required consecutive successes and the overall attempt limit. Keep the original checkpoint closed while the batch runs.

A pass requires the normal in-game confirmations, a reciprocal exchange in both disposable IndexedDB batteries, 55–65 DS frames/s on both consoles, and two complete timing traces. The verifier checks the save footer and CRC table, the referenced party block CRC, and each party member’s checksum. It compares species and levels as a multiset so party reordering does not cause a failure. Rebooting the ROM to verify the new parties in-game is a separate scenario. [White 2 save block directory](https://github.com/kwsch/PKHeX/blob/master/PKHeX.Core/Saves/Access/SaveBlockAccessor5B2W2.cs) · [Game save copy selection](https://github.com/fuddlesworth/pokebw2/blob/588c0b937229f5c5cb7abad9bf8070dd2c7d97eb/src/gfl/backup_system.c)

## Reproduce the ordering without a ROM

From the clean native build checkout with Emscripten 3.1.74 active, run:

```bash
POKERUN_NATIVE_TEST_HOOKS=1 npm run build:melonds
npm run test:native:schedule
npm run build:melonds
```

The first build adds two synthetic command and poll hooks for this test. The last build restores the normal runtime. For Windows Chromium verification, copy the test JS/WASM pair from WSL, run `npm.cmd run test:native:schedule`, then replace both files with the normal pair. Keep both generated versions out of Git.

The test uses the actual native command queue and reply collector in Chromium. Virtual events are fixed at 8.0 ms for browser send, 14.7 ms for peer command arrival, and 26.8 ms for native reply enqueue. With the same valid reply, polling at 0.070 ms or 10 ms yields an empty poll; polling at 27 ms matches the reply. At that same late poll, a reply 32 DS microseconds behind matches, while 33 behind is stale. These cases isolate ordering from the timestamp rule. The virtual fixture does not simulate the game's ACK and dialogue state machine.

## Interpret the timing evidence

```powershell
node .\scripts\summarize-greeting-trace.mjs .\local-test-assets\white2-run-REPLACE_ME
```

The raw timing files contain only scalars. Browser events use role and wire sequence. Native TX uses role and local TX ID; the browser send carries that local ID in its trace only. Native host polls include a poll ID and the last host command TX ID. Native reply injection and disposition include the originating wire sequence. Each native row has seven fields: kind, monotonic milliseconds, DS microseconds, reply DS microseconds, ID, AID or expected AID mask, and poll ID. Kinds 1–10 represent command TX, reply TX, empty poll, queued poll, stale, wrong AID retained, matched, blank, duplicate AID, and reply queued. IDs are scoped to one uninterrupted paired link. Browser timestamps and the pinned pthread runtime use `performance.timeOrigin + performance.now()`; each drain brackets a native reading in browser time as a clock-domain check.

- **Delivery latency.** Measure native TX to browser send, browser send to peer arrival, and arrival to native enqueue. A reply already emitted by the peer whose arrival and enqueue occur after the first host poll supports a scheduling or delivery hypothesis. Use exact send/arrival sequence matches and inspect both command and reply legs.
- **Poll ordering.** Use `emptyFirstPolls` to split exact command joins by whether the first empty poll preceded browser send or peer arrival. Compare native command TX to its host poll and peer reply TX to host enqueue. If the poll precedes peer emission with short wire delivery, browser delivery alone cannot account for that ordering. If a reply was queued before the poll, inspect the disposition and expected AID mask. A later reply near an empty poll may belong to another command. The current protocol has no echoed host command ID on peer replies, so leave overlapping cycles unassigned.
- **Emulated clock offset.** For queued replies compute reply DS time minus host poll DS time. The collector's stale test discards a reply more than 32 emulated microseconds behind the poll argument. The argument is the host Wi-Fi clock at poll and can be later than command TX. The analyzer also subtracts elapsed monotonic time at a nominal 1× clock rate to estimate an effective offset. This estimate includes emulation batching, drift and timer precision. Compare distributions for stale versus matched, then inspect specific timelines before concluding which factor dominated.

Hardware trace kinds 11–18 cover dispatch to Wi-Fi RX, RX start, RX finish, reply ring commit, overflow, software read-cursor writes, ACK emission, and peer ACK ring commit. The analyzer separates normal MP data replies from default reply frames using the DS RX flags. Read-cursor movement over a committed entry is evidence at the DS driver boundary. Use the two game screens to determine whether the application acted on it.

With `POKERUN_TRACE_GAME_NEGOTIATION=1`, the verified White 2 US probe also reads the GFL network handle states, received negotiation bitmask, sent bitmask, connection bitmask, and current state routine. It records changes only and does not read or export trainer identities or addresses from negotiation payloads. The game counts handles in state 5 as negotiated. Its ask loop can show “did not reply” when the negotiated count fails to exceed one, or when a negotiated session has too many connected players. Use the exact handle transitions to distinguish those branches. [Union Room ask loop](https://github.com/fuddlesworth/pokebw2/blob/588c0b937229f5c5cb7abad9bf8070dd2c7d97eb/src/ov034/union_oneself.c) · [GFL negotiation implementation](https://github.com/fuddlesworth/pokebw2/blob/588c0b937229f5c5cb7abad9bf8070dd2c7d97eb/src/gfl/net_handle.c) · [White 2 US symbol map](https://github.com/fuddlesworth/pokebw2/blob/588c0b937229f5c5cb7abad9bf8070dd2c7d97eb/config/w2_us/arm9/symbols.txt)

For exact GFL callback counts, build with `POKERUN_TRACE_ARM9_GFL=1 npm run build:melonds`, then run the same scenario with game negotiation tracing on. Trace kinds 19 and 20 mark entry into the White 2 receive and negotiation routines and boolean returns from the packet callbacks. The summaries classify idle/data packets and report game error-line numbers. They also record NitroSDK parent and child port callbacks by state, error, AID and length, data-sharing step results and received-AID masks, and ARM7-to-ARM9 FIFO indications by API, state and error. The capture contains no payload bytes. In the paired summary, compare the guest SDK ACK indication with the first ACK ring write in each reply interval. An SDK error before ring arrival and a host ACK without failed-client bits can occur in the same exchange. Use the regular build for routine gameplay and performance comparisons.

Reject captures with loss, unverified clock domain, link restarts, hidden browser throttling or mixed settings. Stop after the one attempt and clear both radio links. Keep the original checkpoints and write only sanitized aggregate results into Git. Changes to receive deadlines, packet order, clock conversion or ACK behavior require a separately justified hypothesis and a test that can distinguish it.
