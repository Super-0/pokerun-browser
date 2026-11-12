# PokéRun — browser Nuzlocke prototype

PokéRun is an early browser-first prototype for a Pokémon Nuzlocke/randomizer companion. The long-term idea is that a user supplies their own ROM locally, plays it in the browser, and PokéRun reads the emulator's game state to keep a live Nuzlocke HUD synchronized automatically.

> **Important:** this repository does not contain ROMs, copyrighted game assets, BIOS files, or Nintendo code. Users provide ROMs locally; ROM bytes remain in local browser storage and are never committed or uploaded by PokéRun.

## What is implemented

- Gen 1–5 game launcher with all 20 mainline versions represented individually.
- Exact-game visual themes (e.g. Black 2 is distinct from White 2, Emerald from Sapphire, etc.).
- New Run setup screen with run type, seed, ruleset, and randomizer summary.
- Active Run UI with support for single-screen and dual-screen layouts.
- Live-style Nuzlocke HUD for badges, deaths, cap, next boss, party HP, current area, and encounter status.
- Local persistence using `localStorage` so prototype runs survive refreshes.
- Core emulator / game-adapter / run-engine / storage / randomizer boundaries.
- Developer game-state simulator routed through the same adapter + run-engine pipeline planned for real emulators.
- mGBA WASM can boot user-provided GB/GBC/GBA ROMs locally; Emerald additionally has an experimental live map/party reader through the mGBA WASM heap.
- An experimental, source-built melonDS bridge can load a locally stored `.nds` ROM into dual canvases with keyboard and touchscreen input. White 2 boot remains a manual verification item because no ROM is included here.
- An experimental local multiplayer lobby for Pokémon White 2: two tabs can create/join a room and synchronize player presence/ready state through `BroadcastChannel`. This is not DS gameplay synchronization.

## Run it locally

```bash
npm install
# Required only before running an NDS title; see docs/MELONDS.md for Emscripten setup.
npm run build:melonds
npm run dev
```

Then open the localhost URL Vite prints.

## Prototype flow

1. Home features the latest saved run and a compact list of other runs. Select **Continue** to resume one.
2. Select **New Run** to browse the generation-grouped game library, then choose a game.
3. Choose Vanilla/Randomized, seed, and ruleset, and provide your own ROM.
4. Start the run.
5. Active Run opens with mGBA for GB/GBC/GBA games and the experimental melonDS bridge for `.nds` games.
6. Open **DEV GAME STATE SIMULATOR** at the bottom to simulate route changes, encounters, damage, deaths, and badges.

## Save Editor (experimental: Generation I–V)

**SAVE EDITOR** is immediately left of **MULTIPLAYER** on Home. Import an exported battery save in the browser. The editor uses the PKHeX.Everywhere engine to detect the game and read its actual save layout; filename extensions alone are not trusted.

- **Generations 1–5:** the save editor auto-detects supported game saves and provides trainer name/money/Battle Points (where available), game-progress inspection, game-supported badge toggles, searchable bag pouches (including quantity edits and adding allowed items), and party/PC Pokémon editing. Pokémon fields now include nickname, level, friendship, held item, nature, ability, four moves, IVs and EVs when the game and SDK permit them. The editor disables locked fields and uses per-Pokémon game-specific choices; unknown or invalid formats fail closed.
- **Safety:** original uploaded bytes are preserved separately, with a backup download. The Save Editor does not write into your current PokéRun run, ROM storage, or multiplayer profiles; you must import the exported save into your emulator yourself.
- **Testing:** ROM-free blank-save creation/export and structure checks for generations 1–5, plus failure-path checks. Some blank templates do not round-trip as played battery saves; real-save imports remain an explicit release gate. Real saves from each game and actual emulator import/export require manual validation before considering the editor production-ready.
- **License:** PKHeX.Everywhere and its PKHeX.Core runtime are GPL-3.0-or-later. **Do not merge this experimental branch into a proprietary/distribution build without reviewing the GPL obligations and project licensing.**

See [Save Editor implementation notes](docs/SAVE_EDITOR.md) for the engine boundary, coverage and checklist.

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

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the boundaries, game-family plan, and implementation roadmap; [`docs/MELONDS.md`](docs/MELONDS.md) for the reproducible DS runtime; and [`docs/MULTIPLAYER.md`](docs/MULTIPLAYER.md) for the multiplayer protocol.

## Recommended next milestones

1. Move the existing mGBA player behind the `EmulatorBridge` boundary and expose its raw reads through that contract.
2. Validate battery-save import/export and expand Emerald live state beyond map/party.
3. Expand encounter/death tracking and move persistence to IndexedDB.
4. Manually validate the existing melonDS bridge with a local White 2 ROM and finish save/audio plumbing.
5. Establish a fingerprinted White 2 adapter before attempting multiplayer game-state exchange.

## Product/design notes

Figma concept file:
https://www.figma.com/design/sCNUOpXiMSUPofrqYEzKLK

The current visual direction uses a readable pixel UI, square borders, game-specific background themes, and a game-first Active Run layout.
