# PokéRun — browser Nuzlocke prototype

PokéRun is an early browser-first prototype for a Pokémon Nuzlocke/randomizer companion. The long-term idea is that a user supplies their own ROM locally, plays it in the browser, and PokéRun reads the emulator's game state to keep a live Nuzlocke HUD synchronized automatically.

> **Important:** this repository does not contain ROMs, copyrighted game assets, BIOS files, or Nintendo code. ROM loading/emulation is intentionally not implemented in v0.0.1.

## What is implemented in v0.0.1

- Gen 1–5 game launcher with all 20 mainline versions represented individually.
- Exact-game visual themes (e.g. Black 2 is distinct from White 2, Emerald from Sapphire, etc.).
- New Run setup screen with run type, seed, ruleset, and randomizer summary.
- Active Run UI with support for single-screen and dual-screen layouts.
- Live-style Nuzlocke HUD for badges, deaths, cap, next boss, party HP, current area, and encounter status.
- Local persistence using `localStorage` so prototype runs survive refreshes.
- Developer game-state simulator to test the HUD before a real emulator adapter exists.

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

## Architecture direction

The UI is deliberately separated from the future emulator layer. Today the screen consumes a normal `RunState`. Later, an emulator adapter can produce the same shape from RAM without changing the UI.

```text
Emulator WASM
    ↓
Game-specific memory adapter
    ↓
Normalized GameState / events
    ↓
Nuzlocke rules engine
    ↓
React UI + persistence
```

Likely game-family adapters:

- Red / Blue / Yellow
- Gold / Silver / Crystal
- Ruby / Sapphire / Emerald
- FireRed / LeafGreen
- Diamond / Pearl / Platinum
- HeartGold / SoulSilver
- Black / White
- Black 2 / White 2

## Recommended next milestones

1. Replace `localStorage` with IndexedDB and versioned run storage.
2. Add a real ROM-file picker that keeps file bytes local only.
3. Integrate one GBA emulator path first (Emerald is a good test target).
4. Integrate one DS emulator path second (Black 2 is a good test target).
5. Define `GameStateAdapter` and wire the current DEV simulator through that interface.
6. Prove read-only party/map/badge extraction for one game.
7. Add encounter/death event detection.
8. Add deterministic randomizer settings and run bundles.

## Product/design notes

Figma concept file:
https://www.figma.com/design/sCNUOpXiMSUPofrqYEzKLK

The current visual direction uses a readable pixel UI, square borders, game-specific background themes, and a game-first Active Run layout.
