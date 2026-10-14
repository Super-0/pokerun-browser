# Multiplayer architecture

## Current proof

As of this implementation, PokéRun has an experimental, browser-local lobby for **Pokémon White 2**. Two tabs under the same browser origin can create/join a six-character room, see presence, synchronize ready state, and observe a leave event. This is a lobby proof only; it does not boot a DS ROM or synchronize gameplay.

ROM bytes are never transmitted. The local transport only broadcasts typed room messages between browser contexts.

## Boundaries

```text
Game multiplayer adapter (future)
          ↓ normalized player state
Multiplayer core: room/session/protocol
          ↓ typed transport interface
BroadcastChannel (current) / WebSocket (future)
```

- `src/multiplayer/core`: game-independent room state, protocol, and transport contract.
- `src/multiplayer/games/registry.ts`: data-driven list of multiplayer-capable games. UI availability derives from this registry.
- `src/multiplayer/transports/BroadcastChannelTransport.ts`: local development transport for two tabs in one browser profile.
- `src/multiplayer/transports/WebSocketTransport.ts`: server transport boundary only. It is not configured until a room server exists.

No transport is allowed to know emulator memory offsets. A future `White2MultiplayerAdapter` should receive an emulator bridge and expose normalized player state such as map, coordinates, facing, and movement state.

## Protocol version 1

Every packet carries `version`, `senderId`, and `sentAt`. Current message types are `HELLO`, `ROOM_CREATE`, `ROOM_JOIN`, `ROOM_STATE`, `PLAYER_READY`, `PLAYER_LEAVE`, `PING`, `PONG`, and `ERROR`.

`BroadcastChannelTransport` ignores malformed payloads and messages with an unsupported version. The room host is authoritative for `ROOM_STATE`; the room is intentionally capped at two players for this first slice.

## Room lifecycle

1. Host creates a six-character room code.
2. Guest enters the code in another tab.
3. Host accepts one guest and broadcasts the authoritative room state.
4. Ready changes go to the host and are rebroadcast as room state.
5. `pagehide` and explicit Leave emit `PLAYER_LEAVE`; when the host leaves, the guest clears its room.

This local transport is intentionally ephemeral. Refreshing both tabs or closing the host does not preserve/recover a room; reconnect/session recovery belongs with a future WebSocket room service.

## White 2 / melonDS audit

The current repository has no melonDS dependency, WASM bundle, emulator bridge, DS memory bridge, or NDS player implementation. NDS runs currently render a `melonDS NOT CONNECTED` placeholder in `ActiveRunScreen`. Therefore the following are **not proven**:

- White 2 ROM boot in the browser
- JavaScript read/write access to DS memory
- a supported White 2 ROM revision or fingerprint
- local player map/x/y/direction reads
- remote overworld avatar injection

The mGBA/Emerald path is separate and remains in place: `MgbaPlayer` loads local GBA ROMs and `EmeraldLiveStateReader` reads live Emerald map/party state from the exposed mGBA WASM heap. It was not modified by the multiplayer work.

## Next milestone

Integrate and validate a specific browser-compatible melonDS WASM implementation behind `EmulatorBridge`, then document the exact supported White 2 ROM fingerprint before researching live player-state structures. Do not add memory offsets until they are repeatably verified for that fingerprint.
