# Multiplayer architecture

## Verified foundation

The browser-local White 2 lobby uses the versioned `BroadcastChannel` transport.
Two tabs can create/join a room, synchronize presence and readiness, and—after
local ROM validation—enter a common `GAME_START` session. ROM bytes never leave
the browser tab that selected them.

The melonDS boot and ARM9 bus boundary are documented in [`MELONDS.md`](MELONDS.md).
This document does **not** claim White 2 map/position/direction reads or remote
state exchange are working; no tested ROM bytes or verified memory structures
are available in this worktree.

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
| `GAME_STATE` | Future normalized player state, carrying `startId` and monotonic sequence |
| `PLAYER_LEAVE` | Explicit/page-close cleanup |

`GAME_STATE` messages are ignored unless their `startId` matches the live room
and their sequence is newer than the last state accepted for that remote player.

## ROM policy

The first compatibility policy is intentionally strict: same game and exact
SHA-256. `white2Rom.ts` checks the NDS header title `POKEMON W2` and a Gen-5
`IR?D` game code before marking a local ROM as verified. This is a header sanity
check, not a claim of universal revision support. A specific tested hash must be
documented before a White 2 memory adapter is enabled.

## Runtime handoff

After `GAME_START`, `MultiplayerScreen` remains mounted so its
`LocalMultiplayerSession`/transport remains alive. `MelonDsPlayer` receives the
tab's `LoadedRom` directly from local multiplayer state and boots that tab's
own bytes. It does not use the normal run store and does not send the ROM to
the other tab.

## Next evidence gate

Use a legal local White 2 ROM to record its exact SHA-256, region/game code,
and repeatable ARM9 observations. Only then add `White2LiveStateAdapter` and
enable local/remote coordinates in the multiplayer debug panel.
