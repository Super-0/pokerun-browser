# PRK81D — native WASM bootstrap in a worker

PRK81C passed (20/20 shared-memory packets, mean 11.0 ms per wait, 115 browser heartbeats).
This next experiment checks whether the existing PRK81A `0x50524b47` Emscripten
artifact can initialize **inside a classic Web Worker**.

The main PokeRun runtime loader uses `window` and `document`, so PRK81D
uses a separate importScripts-based worker rather than moving the browser
loader into a Worker. It creates one `WasmEmulator`, verifies the version,
ARM9 budget, and reply counter, and destroys the instance.

No ROM, save files, game frames or multiplayer radio are used.
Success is only a prerequisite for a worker-hosted emulator.

Run:

```bash
cd /workspaces/pokerun-browser
git pull --ff-only origin mp/prk81-reply-scheduling
npm run dev:multiplayer
```

Open `/prk81d-native-worker.html` on the same Codespaces port preview.
Send the complete stage log. The generated PRK81A WASM runtime should
already be present; no `npm run build:melonds` is necessary.
If the worker fails, do not simulate `window` or DOM APIs to mask the error:
report the actual stage and failure so we can determine the required
Emscripten worker-specific build or callback changes.
