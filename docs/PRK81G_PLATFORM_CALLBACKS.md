# PRK81G — real native Platform MP callback mailbox transport

PRK81F user-confirmed PASS: 20/20 native C++ futex replies, one rejected
mismatched sequence, one bounded timeout, 109 browser heartbeats.

PRK81G adds *opt-in* shared WASM TX/RX slots to native
Platform::MP_SendCmd / Platform::MP_RecvReplies. The original PRK79
queue and read behavior remains the default when prk81gEnabled=false.

The isolated worker calls the real platform callbacks through
prk81gTestPlatformRoundTrip, without loading any ROM or saved game.
The browser extracts the actual C++ command from a 2048-byte bounded
shared TX slot and returns a synthetic test reply through a 1024-byte
bounded RX slot; no reentrant WASM calls and no fake native ACKs.

Three test cases: correct sequence (native AID mask 2), mismatched
sequence (native 0 and rejection count), and withheld reply (native 0
and timeout count). Only the smoke-test method turns on the new
callback transport. Future integration must add genuine peer packets
and proper session/command association before enabling it for gameplay.

Build and run:
- cd /workspaces/pokerun-browser
- git pull --ff-only origin mp/prk81-reply-scheduling
- git submodule update --init --recursive
- npm run build:melonds
- npm run build
- npm run dev:multiplayer

Open /prk81g-platform-callbacks.html on the Vite 5173 preview.
Do not start Pokémon for this test. Send complete results. First native
compiler/linker error is needed if the build does not pass.
