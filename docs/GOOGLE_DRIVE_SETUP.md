# Google Drive ROM library

PokéRun's portable ROM-library path keeps ROM files in the player's own Google Drive rather than storing them on PokéRun servers.

## Intended flow

1. A player stores their legally obtained ROM files in their own Google Drive.
2. PokéRun asks the player to authorize read access to Drive.
3. The player links one Drive file to a PokéRun game, such as `Pokemon Emerald.gba` -> Emerald.
4. PokéRun stores only that file reference in `pokerun-library.json` inside Google Drive's hidden `appDataFolder`.
5. On another computer, the player connects the same Google account.
6. PokéRun reads the hidden manifest, finds the linked ROM, downloads the bytes directly into browser memory, and hands them to the emulator.

The ROM does not go through PokéRun's repository or a PokéRun storage server.

## Development setup

Create a Google Cloud project and enable the Google Drive API. Create an OAuth 2.0 **Web application** client and add the development origin, normally:

```text
http://localhost:5173
```

Copy `.env.example` to `.env` and set:

```text
VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

Then restart Vite.

## Current scopes

The prototype requests:

```text
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/drive.appdata
```

- `drive.readonly` lets the browser find and download the player's ROM files.
- `drive.appdata` lets PokéRun keep its tiny cross-device ROM-link manifest in the hidden application-data folder.

For a public production release, we should evaluate replacing broad Drive read access with Google Picker + per-file authorization so users grant access only to ROM files they explicitly choose.

## Security model

- OAuth access tokens live only in browser memory in the current prototype.
- No Google client secret belongs in the frontend.
- `VITE_GOOGLE_CLIENT_ID` is an identifier, not a secret.
- ROM bytes are downloaded directly from Google Drive to the player's browser.
- GitHub must never contain ROMs, BIOS files, OAuth tokens, or private credentials.

## Next step

Once emulator cores are integrated, the linked Drive ROM should be loaded automatically when a run opens. Saves can use a similar provider abstraction, with the save file synchronized separately from the ROM.
