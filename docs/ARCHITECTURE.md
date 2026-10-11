# PokéRun core architecture

PokéRun is intentionally split so the UI never needs to know how a Pokémon game stores data in RAM.

## Data flow

```text
User ROM
   ↓
RandomizerService (optional, deterministic seed)
   ↓
EmulatorBridge (mGBA or melonDS)
   ↓ raw memory
GameStateAdapter (game-family-specific parser)
   ↓ GameSnapshot
RunEngine
   ↓ RunState + RunEvents
React UI / Nuzlocke HUD
   ↓
RunRepository
```

The development simulator already follows this exact path. It uses `MockEmulatorBridge` and `MockGameStateAdapter`, so replacing the mocks later should not require rewriting the Active Run screen.

## Main boundaries

### `core/emulator`

`EmulatorBridge` is the contract for browser emulators. Production implementations will wrap mGBA WASM for GB/GBC/GBA and melonDS WASM for NDS.

Responsibilities:

- load a user-provided ROM
- start/pause/resume/reset emulation
- expose raw memory reads to adapters
- import/export canonical battery saves
- own emulator lifecycle

It should **not** understand Nuzlocke rules or Pokémon memory layouts.

### `core/game`

`GameStateAdapter` translates emulator memory into a normalized `GameSnapshot`.

PokéRun currently plans eight adapter families rather than twenty unrelated parsers:

1. Red / Blue / Yellow
2. Gold / Silver / Crystal
3. Ruby / Sapphire / Emerald
4. FireRed / LeafGreen
5. Diamond / Pearl / Platinum
6. HeartGold / SoulSilver
7. Black / White
8. Black 2 / White 2

A real adapter owns ROM-specific addresses, structures, encryption/decoding, map IDs, battle flags, party parsing, badge flags, and similar details.

### `core/run`

`RunEngine` compares consecutive `GameSnapshot`s and converts them into Nuzlocke behavior.

Current automatic events include:

- map changes
- party changes
- Pokémon faints
- badge changes
- wild encounter starts
- battle ends

This is where automatic encounter/death tracking grows. Game adapters report what the game is doing; `RunEngine` decides what that means for a Nuzlocke.

### `core/randomizer`

`RandomizerService` is separate from emulation. Given a ROM, seed, and settings, it returns deterministic randomized ROM bytes. The emulator only receives the result.

The current `PassthroughRandomizerService` is a placeholder contract, not a real randomizer.

### `core/storage`

`RunRepository` keeps persistence out of React components. The prototype implementation uses localStorage and the existing `pokerun:runs:v1` key.

Planned replacement: IndexedDB for runs, battery saves, run bundles, and optional save states. Cloud sync can later sit behind the same repository boundary without storing ROM files.

## Development simulator

The Active Run screen's simulator now mutates `MockGameStateAdapter`, then calls `RunEngine.sync()`. It no longer manually edits death counts, party HP, badges, route state, or encounters in the UI.

That is deliberate: when a real Black 2 adapter exists, the simulator can be removed and the HUD can consume the same normalized pipeline.

## Next implementation milestones

### Milestone 1 — emulator proof

Start with one GBA game (Emerald):

- embed mGBA WASM
- load a local ROM through `EmulatorBridge`
- render video/audio/input
- import/export `.sav`
- prove raw memory reads work

### Milestone 2 — first live adapter

Implement `gen3-rse` enough to read:

- current map
- party species/nickname/level/HP/status
- badges
- current battle type/opponent

Once those values drive the existing HUD, the architectural path is validated.

### Milestone 3 — Nuzlocke automation

Add:

- encounter history
- caught/missed outcome detection
- graveyard records
- level-cap rules
- boss progression
- run event log

### Milestone 4 — DS proof

Add melonDS and Black 2. This validates dual-screen rendering and the Gen 5 adapter family before expanding to every title.

## Rules

- ROMs remain user-provided and local.
- UI components never read emulator memory directly.
- Game adapters never contain presentation logic.
- Emulator bridges never contain Nuzlocke rules.
- RunEngine is the only layer that turns game-state changes into Nuzlocke events.
- Persistence is accessed through `RunRepository` rather than directly from screens.
