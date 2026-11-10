# PRK81F — native C++ futex mailbox test

PRK81E passed: 60 real melonDS frames in a dedicated worker, 60 frame callbacks,
0 save writes, and 984 browser event-loop heartbeats.

PRK81F tests a new isolated native C++ wait in melonDS. The browser obtains
the actual WASM heap SharedArrayBuffer and writes a valid 36-byte framed
test reply into a 96-byte mailbox located inside the C++ emulator object.
The worker blocks in emscripten_futex_wait until main JS sets the state
to 2 and calls Atomics.notify. No same-module WASM reentry occurs.

The harness tests 20 matching replies, a wrong sequence (native -2), and
a missing reply with a bounded timeout (native 0). It verifies browser
responsiveness and the real native return values.

This does not modify actual MP_RecvReplies, Wifi.cpp, radio ACK formation
or game saves. A passing result is a prerequisite, not the actual
wireless multiplayer fix. The test operates without a ROM or two-player
connection.

The PRK81F build changes the native version stamp to 0x50524B49.

## Run (melonDS rebuild required)

1. cd /workspaces/pokerun-browser
2. git pull --ff-only origin mp/prk81-reply-scheduling
3. git submodule update --init --recursive
4. npm run build:melonds
5. npm run build
6. npm run dev:multiplayer

Open /prk81f-native-mailbox.html on the Vite preview origin, and copy
the entire PASS/FAIL log. If native compilation fails, provide the
first compiler error and the last 25 lines of build output.
