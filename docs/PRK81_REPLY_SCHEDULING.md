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
