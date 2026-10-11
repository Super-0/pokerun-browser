# PokéRun — browser Nuzlocke prototype

PokéRun is an early browser-first prototype for a Pokémon Nuzlocke/randomizer companion. The long-term idea is that a user supplies their own ROM locally, plays it in the browser, and PokéRun reads the emulator's game state to keep a live Nuzlocke HUD synchronized automatically.

> **Important:** this repository does not contain ROMs, copyrighted game assets, BIOS files, or Nintendo code. ROM loading/emulation is intentionally not implemented yet.

## What is implemented

- Gen 1–5 game launcher with all 20 mainline versions represented individually.
- Exact-game visual themes (e.g. Black 2 is distinct from White 2, Emerald from Sapphire, etc.).
- New Run setup screen with run type, seed, ruleset, and randomizer summary.
- Active Run UI with support for single-screen and dual-screen layouts.
- Live-style Nuzlocke HUD for badges, deaths, cap, next boss, party HP, current area, and encounter status.
- Local persistence using `localStorage` so prototype runs survive refreshes.
- Core emulator / game-adapter / run-engine / storage / randomizer boundaries.
- Developer game-state simulator routed through the same adapter + run-engine pipeline planned for real emulators.

## Run it locally

```bash
npm install
npm run dev
```

Then open the localhost URL Vite prints.

## Prototype flow

1. Choose a game on Home.
2. If that game has no saved run, New Run opens.
3. Choose Vanilla/Randomized, seed, and ruleset.
4. Start the run.
5. Active Run opens with an emulator placeholder and live HUD.
6. Open **DEV GAME STATE SIMULATOR** at the bottom to simulate route changes, encounters, damage, deaths, and badges.

## Core architecture

The UI does not know emulator memory addresses or ROM structures. The intended pipeline is:

```text
User ROM
    ↓
RandomizerService (optional)
    ↓
EmulatorBridge (mGBA / melonDS)
    ↓ raw memory
GameStateAdapter
    ↓ GameSnapshot
RunEngine
    ↓ RunState + RunEvents
React UI + RunRepository
```

The current simulator already follows this architecture using `MockEmulatorBridge` and `MockGameStateAdapter`.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the boundaries, game-family plan, and implementation roadmap.

## Recommended next milestones

1. Embed an mGBA WASM build behind `EmulatorBridge`.
2. Load a user-selected Emerald ROM locally and render/input the game.
3. Prove battery-save import/export.
4. Prove raw memory reads from the emulator.
5. Implement the first read-only `gen3-rse` adapter for party/map/badges/battle state.
6. Let those real snapshots drive the existing HUD automatically.
7. Expand encounter/death tracking and move persistence to IndexedDB.
8. Validate the same architecture with melonDS + Black 2.

## Product/design notes

Figma concept file:
https://www.figma.com/design/sCNUOpXiMSUPofrqYEzKLK

The current visual direction uses a readable pixel UI, square borders, game-specific background themes, and a game-first Active Run layout.
