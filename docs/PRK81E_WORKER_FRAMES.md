# PRK81E — real melonDS frames in a Web Worker

User-confirmed PRK81D PASS (November 9, 2026): worker initialized WASM
runtime 0x50524B47 in 494.6ms with 49 browser heartbeat events.

This experiment changes only the five native WebMelon callbacks from
`window.WebMelon` to `globalThis.WebMelon` in the pinned WASM source.
It bumps the runtime stamp to 0x50524B48. No RF protocol, native ACK,
game-memory, or save changes are introduced.

A separate classic Worker loads a user-selected local .nds ROM into
a private in-memory Emscripten filesystem, boots it directly, and runs
60 genuine emulated frames without rendering or multiplayer. It uses
an ephemeral save path and never calls syncfs or opens IDBFS.
The Worker is terminated when the test finishes. No ROM bytes are
sent to GitHub, ChatGPT, or the Codespace server.

## Run

```bash
cd /workspaces/pokerun-browser
git pull --ff-only origin mp/prk81-reply-scheduling
git submodule update --init --recursive
npm run build:melonds
npm run build
npm run dev:multiplayer
```

Open `/prk81e-worker-frames.html` on the Vite preview, select a local
legitimate .nds file, and click Run 60 frames. Copy full PASS/FAIL.
This verifies native frame execution only, not worker-host radio timing.

Next PRK81F would add a *real*, bounded native reply mailbox and
tests for matched commands, without synthetic ACKs.
