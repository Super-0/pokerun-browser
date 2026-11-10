# PRK81I-A — native TX and RX workers for background-tab scheduling

The first PRK81I run successfully booted both 512 MB ROMs, applied distinct
firmware roles, and executed 30 real DS frames per instance. The host's
first native callback timed out after 125.5 ms: TX state=1 (unconsumed),
RX state=0, forwarded=false, received=0, native timedOut=1.
The peer had no incoming-command log.

This isolates the immediate fault to the browser's JS transport polling,
not native CMD generation or the peer radio callback. The H-A test
succeeded using 1 ms browser setTimeout polling, but 512 MB ROMs and
background-tab scheduling can delay those timers past a 120 ms native wait.

PRK81I-A removes all timer-driven work from the critical native window:
- A dedicated TX observer Worker reads the host's already-shared WASM
  memory. It waits with Atomics.wait(state, 0/3, 2 ms), because PRK81G
  native writes do not yet call Atomics.notify on publish. This worker
  sends the unchanged native command directly via BroadcastChannel.
- A dedicated RX committer Worker listens for replies **from the other
  browser tab's native callback** and validates peer ID, role, marker,
  sequence, timestamp, AID and frame bounds. It commits the reply into
  the existing shared WASM RX slot and calls Atomics.notify.
- Both transport Workers must report ready; the TX observer must report
  armed before the host launches the first native command.
- Distinct in-memory firmware, ROM-loaded DS frames and temporary saves
  remain unchanged; no native code or PRK81G response logic is altered.
- A PASS still requires 3 real peer-callback test replies accepted, one
  wrong sequence rejected, one missing reply timed out, and 60 genuine
  frames + frame callbacks from BOTH DS instances.

The shared memory is passed by reference to each transport Worker,
not copied. No new ROM, battery save, or persistent data copy exists.
This is still controlled test traffic, not game-generated packets.

## Run commands (no melonDS rebuild)

    cd /workspaces/pokerun-browser
    git pull --ff-only origin mp/prk81-reply-scheduling
    git rev-parse --short HEAD
    npm run build
    npm run dev:multiplayer

Close the old host and peer tabs. Open /prk81i-live-frames.html and
use the new peer link. Select the legal local White 2 ROM in each tab,
click Boot 30 frames in both. Copy complete HOST/PEER logs. If a
transport worker reports FAIL, include its first error line.
