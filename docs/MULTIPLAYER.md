# Multiplayer architecture

## Verified foundation

The browser-local White 2 lobby uses the versioned `BroadcastChannel` transport.
Two tabs can create/join a room, synchronize presence and readiness, and—after
local ROM validation—enter a common `GAME_START` session. ROM bytes never leave
the browser tab that selected them.

The melonDS boot and ARM9 bus boundary are documented in [`MELONDS.md`](MELONDS.md).
For the first manually tested White 2 fingerprint, PokéRun now has a
revision-specific live-state adapter for map, X, Y, and facing direction. The
multiplayer runtime publishes normalized state between tabs and displays local
and remote values in the debug panel. Remote overworld rendering is not yet
implemented.

## Identity and room lifecycle

Each `LocalMultiplayerSession` generates `localPlayerId` at construction with
`crypto.randomUUID()`. It deliberately does not read or write `sessionStorage`,
so duplicating a browser tab creates another multiplayer player instance.

1. Host creates a six-character room.
2. Guest joins. The host remains authoritative for `ROOM_STATE`.
3. Each player selects a local `.nds` file.
4. Only ROM identity metadata is advertised: game ID, filename, header title,
   game code, SHA-256, and validation status.
5. Both players must have verified White 2 headers and the exact same SHA-256
   before Ready is enabled.
6. The host alone can issue `GAME_START` after both players are ready.
7. Each tab boots its own local ROM while the multiplayer session remains alive.
8. For a supported live-state fingerprint, each tab polls normalized player
   state and publishes changed `GAME_STATE` packets.

The room is capped at two players. Host migration and reconnect recovery remain
future WebSocket-room work.

## Protocol version 2

Every packet includes `version`, `senderId`, and `sentAt`.

| Message | Purpose |
| --- | --- |
| `ROOM_CREATE`, `ROOM_JOIN`, `ROOM_STATE` | Room lifecycle and host-authoritative state |
| `PLAYER_ROM` | Guest ROM identity update; never contains bytes |
| `PLAYER_READY` | Ready request, accepted only by host for compatible ROMs |
| `GAME_START` | Host-authoritative start with random `startId` epoch |
| `GAME_STATE` | Normalized player state with `startId` and monotonic sequence |
| `PLAYER_LEAVE` | Explicit/page-close cleanup |

`GAME_STATE` messages are ignored unless their `startId` matches the live room
and their sequence is newer than the last state accepted for that remote player.
The White 2 runtime currently sends state only when map/X/Y/direction changes,
with a roughly 10 Hz polling loop.

## ROM policy

The first compatibility policy is intentionally strict: same game and exact
SHA-256. `white2Rom.ts` requires the NDS header title `POKEMON W2` and an
explicit known White 2 game-code whitelist (`IRDO`, `IRDJ`, `IRDS`, `IRDF`,
`IRDI`, `IRDD`, `IRDK`) before marking the local ROM as verified.

Header verification is separate from live-memory support. The first enabled
live-state fingerprint is:

```text
54bec4091ba3eb89f4e1ee4e2f3421005835804376a34e5e45f3157e1f55625a
```

Other verified White 2 ROMs may enter a room, but the revision-specific live
state reader remains disabled until their memory layout is independently
validated.

## Runtime handoff

After `GAME_START`, `MultiplayerScreen` remains mounted so its
`LocalMultiplayerSession`/transport remains alive. `MelonDsPlayer` receives the
tab's `LoadedRom` directly from local multiplayer state and boots that tab's
own bytes. It does not use the normal run store and does not send the ROM to
the other tab.

`White2LiveStateAdapter` owns the revision-specific ARM9 addresses and exposes
only generic `MultiplayerPlayerState` data to the multiplayer layer. The game
screen displays local and remote map/X/Y/direction values; if map IDs differ it
marks the remote player as being in a different location.

## Experimental isolated-process radio relay

The default native White 2 link remains an ephemeral, same-origin
`BroadcastChannel`. For a development-only proof of concept, the native frame
boundary can instead use Vite's existing HMR WebSocket relay:

```sh
VITE_POKERUN_REMOTE_MULTIPLAYER=1 npm run dev:multiplayer
```

Open each player from the same dev server with `?transport=network`. The relay
serializes radio bytes as base64 and forwards only the existing hello/bye/frame
envelopes; ROMs, saves, and player data are not transmitted. The server does
not persist packets or provide authentication, room authority, replay
protection, or reconnection recovery. Malformed payloads are discarded, and
the native link still enforces peer identity, nonce, sequence, frame-size, and
timestamp checks.

This is a transport proof of concept, not a remote-trade claim. Vite/HMR
WebSocket delivery can add latency and jitter, while the worker-radio runtime
waits only within its existing bounded local timing model. A genuine
two-computer White 2 trade requires measured latency/jitter evidence and a
dedicated authenticated relay/session service before this flag should be used
outside development.

`npm run test:remote:radio` verifies binary frame-envelope delivery between two
isolated Chromium processes and reports observed relay latency. Its synthetic
payloads exercise serialization and ordering only; passing it does not prove
native association or a remote trade.

The private checkpoint harness goes one stage further:

```sh
VITE_POKERUN_REMOTE_MULTIPLAYER=1 \
VITE_POKERUN_WHITE2_LOCAL_MULTIPLAYER=1 \
POKERUN_MULTIPLAYER_PORT=4181 \
npm run dev:multiplayer

VIRTUAL_ENV="$PWD/local-test-assets/.venv" \
PATH="$PWD/local-test-assets/.venv/bin:$PATH" \
npm run test:white2:remote-native
```

It uses two isolated Chromium profiles and the existing verified checkpoints.
The highest verified stage is native link/association setup with both emulators
at roughly 59–61 FPS and zero browser-frame rejection; the current bounded run
does not yet complete the in-game greeting or a trade. Evidence remains under
the ignored `local-test-assets/` directory.

When browser storage is intentionally isolated, pass the host's displayed room
code explicitly to the guest, for example
`?transport=network&player=2&room=ABC123`. This avoids relying on shared
`localStorage`; `npm run test:remote:pairing` automates room creation, joining,
and host/guest role assertions.

## Next milestone

Manually verify two-tab live state exchange in the Codespace, including movement
in both directions and a map transition. After that, keep remote-avatar
injection as a separate phase rather than mixing it with memory discovery or
room synchronization.
