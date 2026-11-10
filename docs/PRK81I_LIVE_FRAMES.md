# PRK81I — DS frame execution around verified cross-tab native transport

PRK81H-A user-confirmed PASS: both independent native instances exchanged
four peer-originated test replies; three matched, one mismatched sequence
was rejected, and the missing response timed out. Native TX drops = 0.

PRK81I combines real ROM-based DS frame execution (previous PRK81E)
with PRK81H-A's proven two-way-ready / cross-tab callback transport.
Each tab boots a local user-provided Nintendo DS ROM in a separate WASM
worker, applies an in-memory PRK71 firmware identity (role 1/2),
executes 30 DS frames and verifies 30 video callbacks. After both
tabs confirm real frame execution and mutual readiness, the host
runs five native radio callback tests: three valid, one wrong sequence,
and one withheld reply. On success, both workers disable the test
radio transport and execute 30 further real frames each.

PASS requires 60/60 native frames and callbacks from **both** workers
in addition to the complete callback counter checks. All saved data
is limited to temporary Emscripten MEMFS; no previous battery saves
are loaded and no persistent filesystem writes occur. A 512MB game
file and a 1GB WASM heap in each tab can consume substantial memory.

Important: the replies between those game executions are still
controlled native-callback test packets, NOT genuine messages generated
by the Pokémon games. Actual DS WLAN state, ACK behavior, association,
and Union Room trading remain unproven.

## Run commands

    cd /workspaces/pokerun-browser
    git pull --ff-only origin mp/prk81-reply-scheduling
    git rev-parse --short HEAD
    npm run build
    npm run dev:multiplayer

No native rebuild: reuse 0x50524B4B. Start the host at
/prk81i-live-frames.html on the Vite preview and open its peer link.
Choose the same legal local .nds ROM **separately in both tabs**,
then click Boot 30 frames once per tab. Both must finish initial
frames before cross-tab tests start. Copy host and peer logs.

This isolated experiment does not change the production launcher,
game saves, native ACK injection or radio handshake.
