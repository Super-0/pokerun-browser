# PRK81H — two independently running native WASM workers

User-confirmed PRK81G PASS: actual Platform::MP_SendCmd published its command
before Platform::MP_RecvReplies blocked. The native path handled a valid
response in 12.8 ms, rejected a wrong sequence in 11.3 ms, and timed out
after about 125 ms when the response was deliberately withheld.

PRK81H moves the reply source from the host's own JavaScript test packet
to a **second independent melonDS instance in a second browser tab**.
The host's real native MP_SendCmd writes its shared TX slot. The host
page sends the captured frame across a room-specific BroadcastChannel.
The peer's worker passes those bytes into prk66InjectIncoming, invokes
the real Platform::MP_RecvHostPacket and Platform::MP_SendReply callbacks
through the dev-only prk81hPeerReplyFromQueue method, and drains the native
outgoing reply frame. That native peer-produced packet is relayed to the
host and committed to the host's shared RX slot during a bounded native
MP_RecvReplies wait.

The host performs five tests: 3 valid remote replies, 1 intentionally
mismatched mailbox sequence, and 1 missing reply. It checks that native
matched/rejected/timedOut counters are respectively 3/1/1, that native
TX publication drops are zero, and that 4 actual peer-native reply
frames were delivered. Each tab owns a distinct WASM worker and native
emulator object. The peer marks test replies with byte 15 = A7, which
the host verifies before publishing into native shared memory.

No ROM, save, DS frame, natural peer-game reply, or actual player
handshake occurs in this experiment. A PASS confirms cross-tab transport
through native callbacks, not successful Pokémon multiplayer.

## Build and run

\`\`\`bash
cd /workspaces/pokerun-browser
git pull --ff-only origin mp/prk81-reply-scheduling
git rev-parse --short HEAD
git submodule update --init --recursive
npm run build:melonds
npm run build
npm run dev:multiplayer
\`\`\`

Open /prk81h-cross-tab.html on the Codespaces 5173 preview, then click
"Open the peer tab (Player 2)". Keep both tabs open until the HOST
reports PASS or FAIL, and copy the HOST output. If the peer logs an
error, copy its output too. No ROM or save selection is needed.

Potential future work: full worker-backed game-frame execution with
render, input, save I/O and verified native DS wireless packets. Do not
enable opt-in test callback routing in normal gameplay.


## PRK81H-A — two-way readiness race fix (JS only)

First user run: host discovered peer but first native valid reply returned 0;
peer had not yet logged discovery of host. Hello interval 400 ms exceeds the
native reply timeout of 120 ms. The host must wait until the peer explicitly
acknowledges knowing its identity and having an initialized native worker.

New approach: targeted ready response on hello, immediate reciprocal hello
on first discovery, and gate host test on explicit peer readiness. Poll native
shared TX slot before triggering worker native call. Add timestamps and
native-state counters in failure reports. This does not alter radio,
ACK generation, game ROMs, or saves.

Run (no native rebuild):

    cd /workspaces/pokerun-browser
    git pull --ff-only origin mp/prk81-reply-scheduling
    git rev-parse --short HEAD
    npm run dev:multiplayer

Refresh the host page and open a NEW peer tab from the updated host link.
Do not reuse the old peer link or old room ID. Send full host log and any
peer errors.
