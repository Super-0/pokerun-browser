# Save Editor: PKHeX integration (experimental)

This branch replaces the Emerald-only editor UI with a Generation I–V editor powered by [PKHeX.Everywhere](https://docs.pkhex-everywhere.fyi/docs/getting-started). It does not alter PokéRun's emulator run data or multiplayer saves.

## Scope

The PKHeX engine detects files and reads game-specific formats for Generations I–V. Current controls cover trainer name and money (where available), party and PC-box inspection, and editing existing Pokémon nicknames and levels. Moves, IVs, EVs, items, Pokémon creation/deletion, transfers and box reordering are not exposed yet. Ambiguous or invalid saves remain uneditable.

The original upload is retained for backup download and edits occur only in the in-memory engine. Export creates a separate '-edited' copy. No localStorage, IndexedDB, active mGBA or melonDS save is modified. Users import the edited battery save separately after leaving the game.

The prototype Gen III module remains for legacy regression tests, but the new editor uses PKHeX for actual parsing and writing.

## Architecture

- src/core/save-editor/pkhexEditor.ts: lazy engine session and validated commands.
- src/screens/SaveEditorScreen.tsx: selected file, original bytes, trainer/party/PC controls.
- vite.config.ts: self-hosts the engine's _framework files in development and production.
- tests/browser/helpers/pkhex-blank-fixtures.ts: ROM-free template generation/export checks and reload diagnostics.

## Release checklist

1. Confirm npm ci, npm run build, and Playwright pass on Node 24.
2. Manually test real valid saves from every PokéRun Generation I–V game: Red/Blue/Yellow; Gold/Silver/Crystal; Ruby/Sapphire/Emerald/FireRed/LeafGreen; Diamond/Pearl/Platinum/HeartGold/SoulSilver; Black/White/Black 2/White 2.
3. For each, edit trainer fields, party and box Pokémon, export, reload, verify checksums/values, and boot in the target emulator.
4. Test corrupted, truncated, unsupported, ambiguous and emulator save-state files. Do not allow editing.
5. Confirm local _framework assets, offline loading after the first app load, and realistic production performance.
6. Review licensing before merging/distributing: @pkhex-everywhere/engine and PKHeX.Core use GPL-3.0-or-later. Embedded linking can require licensing compatible source. This repository has no explicit compatible project license yet.

These notes are not legal advice. Review the upstream SDK's license and third-party notices.
