# PRK80 native Union Room greeting

The immediate experiment is a read-only paired capture. Preserve the 5 ms radio pump, PRK75 isolation, checkpoint positions, game speed, and browser mode while comparing trace off and trace on. The test asserts the known failure and exits nonzero on another outcome so it can be classified from the paired evidence.

## Prepare private checkpoints

1. Build and verify the paired JS/WASM from the same commit with `npm run test:native`. Use an ignored `local-test-assets/` folder for the verified user-owned White 2 cartridge, two valid progressed 512 KiB battery saves with distinct in-game Trainer IDs, any driver, the profile and the evidence. Confirm `git check-ignore local-test-assets/check.nds local-test-assets/check.sav local-test-assets/check.png`.
2. Run `npm.cmd run test:white2:prepare` on Windows or `npm run test:white2:prepare` on macOS/Linux. Use only `http://127.0.0.1:4181` in the launched browser. Open Player 1 from the launcher, create a lobby and use **SELECT WHITE 2 ROM**. In the saved-game card use the import-test-copy action for each battery image. Import exercises the existing progressed-save validator and preserves the source. Wait for persistence before reloading. If the cartridge is missing after a reload, use the launcher's reattach action with the same verified ROM.
3. Return to the launcher and choose two different imported slots explicitly. Launch both with PRK75 isolation. Verify both Trainer IDs in-game, go to the same respective Union Room entrances, and save normally in-game. Close all checkpoint Chromium windows to flush the profile. The runner copies this profile into a new private run directory before every attempt. Keep the checkpoint directory closed while copying it. Avoid reusing the live run directory as a checkpoint.
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

Run `npm.cmd run test:white2` or `npm run test:white2`. The script verifies the selected slots, waits for two running DS instances, checks 1× speed and 5 ms linked radio status, and measures a pre-greeting window of at least five seconds at 55–65 DS frames/s per page around the 60 FPS target. The driver has up to 120 seconds to prepare, up to 90 seconds for optional Union Room staging, and 45 seconds for one greeting attempt. A staged run also measures both frame rates for five seconds after entry. An optional `dispose()` export can close driver-owned resources after success or timeout. Screenshots, rendered panel counters, trace batches and stage status stay under `local-test-assets/white2-run-*/`. A link-level `LINKED` badge only confirms the browser handshake. The runner checks for a native association-response frame received by hardware. Use that evidence and both game screens to classify the attempt.

Set `$env:POKERUN_GREETING_TRACE = '0'` in Windows or prefix `POKERUN_GREETING_TRACE=0` on macOS/Linux for the control run. Then remove the variable or set it to 1 and repeat once on a fresh profile copy. Compare DS health, counter deltas and both dialogs. Degraded health or trace overflow invalidates timing conclusions.

## Interpret the timing evidence

```powershell
node .\scripts\summarize-greeting-trace.mjs .\local-test-assets\white2-run-REPLACE_ME
```

The raw timing files contain only scalars. Browser events use role and wire sequence. Native TX uses role and local TX ID; the browser send carries that local ID in its trace only. Native host polls include a poll ID and the last host command TX ID. Native reply injection and disposition include the originating wire sequence. Each native row has seven fields: kind, monotonic milliseconds, DS microseconds, reply DS microseconds, ID, AID or expected AID mask, and poll ID. Kinds 1–10 represent command TX, reply TX, empty poll, queued poll, stale, wrong AID retained, matched, blank, duplicate AID, and reply queued. IDs are scoped to one uninterrupted paired link. Browser timestamps and the pinned pthread runtime use `performance.timeOrigin + performance.now()`; each drain brackets a native reading in browser time as a clock-domain check.

- **Delivery latency.** Measure native TX to browser send, browser send to peer arrival, and arrival to native enqueue. A reply already emitted by the peer whose arrival and enqueue occur after the first host poll supports a scheduling or delivery hypothesis. Use exact send/arrival sequence matches and inspect both command and reply legs.
- **Poll ordering.** Use `emptyFirstPolls` to split exact command joins by whether the first empty poll preceded browser send or peer arrival. Compare native command TX to its host poll and peer reply TX to host enqueue. If the poll precedes peer emission with short wire delivery, browser delivery alone cannot account for that ordering. If a reply was queued before the poll, inspect the disposition and expected AID mask. A later reply near an empty poll may belong to another command. The current protocol has no echoed host command ID on peer replies, so leave overlapping cycles unassigned.
- **Emulated clock offset.** For queued replies compute reply DS time minus host poll DS time. The collector's stale test discards a reply more than 32 emulated microseconds behind the poll argument. The argument is the host Wi-Fi clock at poll and can be later than command TX. The analyzer also subtracts elapsed monotonic time at a nominal 1× clock rate to estimate an effective offset. This estimate includes emulation batching, drift and timer precision. Compare distributions for stale versus matched, then inspect specific timelines before concluding which factor dominated.

Reject captures with loss, unverified clock domain, link restarts, hidden browser throttling or mixed settings. Stop after the one attempt and clear both radio links. Keep the original checkpoints and write only sanitized aggregate results into Git. Changes to receive deadlines, packet order, clock conversion or ACK behavior require a separately justified hypothesis and a test that can distinguish it.
