# Save Editor: PKHeX integration (experimental)

This branch replaces the Emerald-only editor UI with a Generation I–V editor powered by [PKHeX.Everywhere](https://docs.pkhex-everywhere.fyi/docs/getting-started). It does not alter PokéRun's emulator run data or multiplayer saves.

## Scope

The PKHeX engine detects files and reads game-specific formats for Generations I–V. Current controls cover trainer name, money, Battle Points (where available), game progress, editable badges where PKHeX supports the game's layout, inventory pouches (existing counts and allowed new items), and party/PC-box inspection. Existing Pokémon can be edited for nickname, level, friendship, nature, ability, held item, moves and IV/EVs when offered by the save's generation and per-Pokémon options. The SDK rejects unsupported fields. Advanced Pokémon fields include species (limited to the current evolution line), form, gender, shininess, capture ball, original trainer IDs and name, met level/location/date, and read-only PID and Hidden Power details. PC tools can clone an existing Pokémon into an empty box, export a .pk file, preview/import a .pk file, search across boxes, and create game-specific Pokémon from PKHeX encounter data. Generation IV/V saves support Mystery Gift album inspection, Wonder Card previews, insertion and removal. Arbitrary species replacement outside an evolution line, destructive PC deletion, box reordering, arbitrary event-flag injection, and live emulator save overwrites are not exposed. Ambiguous or invalid saves remain uneditable.

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

## Depth pass verification

- Browser tests cover navigation into bag/trainer progress using a synthetic Black save and a Generation V item quantity round-trip through export and reload. These synthetic tests are not substitutes for real multi-game save compatibility checks.
- Nature and move changes, especially changes affecting Gen III/IV personality values, may alter legality. The editor displays available PKHeX legality findings when a Pokémon is opened, but cannot guarantee an edited Pokémon will be legal.
- Always download a backup before importing an edited export back into an emulator. Some Pokémon edits need more game-specific validation, particularly Gen I/II DV/Stat Exp and Gen III/IV PID-related nature changes.

## Advanced save editing and caution

- Pokémon cloning and encounter creation insert into the first available PC-box slot. A full PC box causes an explicit error. Single-Pokémon file export does not modify the save; import requires an SDK conversion preview and confirmation for unofficial conversions.
- Changing shininess, PID-dependent traits, original trainer and encounter metadata may make a Pokémon illegal or inconsistent with its origin; confirm those changes. Any editor legality result is informational, not proof that online gameplay will accept the Pokémon.
- Generation IV and V Mystery Gift tab inserts Wonder Cards into the album, not directly into inventory or the party. Removing a card may leave its received marker set. A Gen IV unlock setting is supported; Gen V doesn't use that flag.
- Real-save round-trip checks, emulator re-import and loading across all 20 game versions remain required. Synthetic Gen V fixtures verify a subset of these behaviors; no user save or copyrighted ROM is stored in the repository.
