# PRK81A — Asyncify capability spike

**Status: experimental, not a multiplayer fix.** Based on PRK80
`bf2c494`, on `mp/prk81-reply-scheduling`.

## Hypothesis

During a synchronous `WasmEmulator::processFrame()`, the host calls
`MP_RecvReplies()` before the browser can drain the outgoing command
queue and deliver the actual client response. In PRK80's controlled test,
4,934 of 5,810 polls saw no reply waiting at the instant of the check.
This is not proof that scheduling is the only issue.

Asyncify may permit suspending the native call long enough for real
`BroadcastChannel` delivery without blocking JavaScript. It must be
validated separately from gameplay because the existing emulator uses
pthreads and Embind, and Asyncify has reentrancy/performance costs.

## What this commit does

- Enables `-sASYNCIFY` for this experimental branch's WASM build.
- Adds a native Embind export `prk81AsyncifyProbe(delayMs)` which only
  sleeps for 1–100 ms then returns `0x81`.
- Adds an isolated browser page at `/prk81-asyncify-probe.html`.
- Validates a Promise return, JavaScript timer activity, native resume,
  and runtime stamp `0x50524B47`.
- Leaves PokeRun's PRK79/PRK80 native radio, ACK logic, emulation frame
  scheduler, battery saves, and ROM data unchanged.

## Test in Codespaces

```bash
cd /workspaces/pokerun-browser
git fetch origin
git pull --ff-only origin mp/prk81-reply-scheduling
git branch --set-upstream-to=origin/mp/prk81-reply-scheduling
git submodule update --init --recursive
npm run build:melonds
npm run build
npm run dev:multiplayer
```

Open the dev origin at `/prk81-asyncify-probe.html`, not the multiplayer
launcher. The page should print a **PASS** if an actual native Embind
call yielded to JavaScript and resumed. This page does not need a ROM,
firmware setup or a saved game.

If the build fails, paste the first compiler/linker error and the last
20 lines. Do not clear build caches or reset the local branch. If it
passes, PRK81B can attempt a **bounded** real-host reply wait with a
single active frame and reentrancy checks, then measure ACK failure
rates before testing the Union Room again.

Do not implement synthetic replies, fake success ACKs, forced menu
transitions, or Pokémon save edits.


## PRK81B — synchronous WASM radio reentry (no rebuild)

PRK81A passed on the Codespace: browser cross-origin isolation true;
stamp `0x50524B47`; JS timer ran during native suspension; Embind
resumed after 32 ms. Emscripten warns that reentering a suspended
module can violate invariants, so a capability test is necessary.

Open `/prk81b-reentry-probe.html` on the **same origin as Vite** with
the existing PRK81A runtime. No ROM, saves, player pairing, or WAsm
rebuild is required. The page suspends `prk81AsyncifyProbe(80)`,
then calls the real PRK79 reply injector and outgoing-queue reader
from a JavaScript timer after 10 ms. Native radio is enabled only for
the test and cleared afterward; no packet is broadcast.

Expected: native reply injection accepted; outgoing queue remains empty;
native test resumes; PASS.

If the page reports FAIL, copy all its output before trying any changes.
This test is designed to establish whether synchronous WASM entry
points work while an Asyncify call is suspended. It does not prove
that `processFrame()` or the actual radio handshake can safely yield.
Do not assume full emulator reentrancy from a passing result.

## PRK81B revision — interpreting Asyncify return types

The first PRK81B browser run reported:
```
Attempting synchronous WASM radio calls at +12.3 ms
FAIL: RX counter did not advance: 0 -> [object Promise]
```
This is a **test expectation failure**: while Asyncify is active, the
otherwise synchronous Embind radio getter returned a Promise. It does
not yet show that `prk79InjectReply` failed or that concurrent native
access is safe.

The revised page awaits the native injection, counter read and outgoing
queue read, timestamps Promise resolution, and compares it against the
original 80 ms native suspension. A result that settles only after the
native call resumes is *not* evidence of usable reentrant access.
A result that settles beforehand is a promising signal, not a guarantee
that full `processFrame()` suspension is safe.

There is **no native WASM code change and no new build stamp** in this
revision. Pull the JS-only commit, refresh
`/prk81b-reentry-probe.html`, and copy every result line.


## PRK81C — switch to worker/shared-memory architecture

PRK81A established that a native Asyncify Embind call can suspend and
resume. PRK81B discovered that while such a call is suspended, injected
radio calls return Promises and their results only settle after the
original 80 ms sleep window. The original sleep did not settle within
5 seconds. This invalidates the assumption that we can reenter the
same WASM module synchronously from its main thread to inject replies.

PRK81C tests the alternative topology *without changing melonDS*:
- A dedicated Worker posts a command and blocks on an
  `Atomics.wait` mailbox with a bounded timeout.
- The browser main thread stays responsive, simulates delivery of a
  correctly framed 36-byte packet, writes it to shared memory and
  wakes the worker with `Atomics.notify`.
- Twenty successive rounds validate association ID, frame length,
  payload marker, order and browser responsiveness.

Test page: `/prk81c-worker-mailbox.html` on the Codespaces Vite
origin. This uses only native browser Web Workers/SharedArrayBuffer,
so no `npm run build:melonds` is needed.

```bash
cd /workspaces/pokerun-browser
git pull --ff-only origin mp/prk81-reply-scheduling
npm run dev:multiplayer
```

A PASS proves the host thread can block while the browser delivers a
packet through shared memory. It does *not* prove native melonDS can
run inside the worker: the current runtime loader uses `window` and
`document`, so porting is a separate step. Actual native integration
must publish host commands before sleeping and share the same queue
memory with browser delivery; `postMessage` to the blocked worker
cannot itself deliver the reply. Do not fabricate ACKs or bypass
native client-failure checks.
