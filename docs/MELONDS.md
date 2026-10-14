# Nintendo DS / melonDS runtime

## Status (2026-10-14)

PokéRun now contains a source-backed **experimental** DS runtime integration.
It uses a pinned DS Anywhere source submodule and PokéRun's own React player
and `MelonDsBridge`; it does not embed DS Anywhere's Preact application.

| Capability | Status |
| --- | --- |
| Reproducible melonDS WASM build | Built locally with Emscripten 3.1.74 |
| `.nds` ROM path | Implemented through `RomSessionStore` and `MelonDsBridge` |
| Dual canvas presentation | Implemented |
| Keyboard and scaled touchscreen input | Implemented |
| Lifecycle (pause/resume/dispose) | Implemented |
| ARM9 emulated-bus reads | Implemented through native wrapper exports |
| White 2 boot with a legal local ROM | **Not yet proven in this environment** (no ROM is present) |
| Audio / battery-save import-export | Not implemented yet |

This is deliberately not a claim that every DS game runs. A user-supplied,
locally owned `.nds` ROM is required for the remaining runtime verification.

## Chosen source and license

- **Integration source:** [DS Anywhere](https://github.com/brxxn/ds-anywhere)
- **Pinned revision:** `53c7c6cb362560a9e362ae754a162f638fa3cd64`
- **Location:** `third_party/ds-anywhere` Git submodule
- **License:** GPL-3.0 (its `LICENSE` and `wasmelonDS/LICENSE` remain intact)
- **PokéRun-owned code:** GPL-3.0-or-later; see root `LICENSE`

The earlier candidates were not selected: upstream melonDS does not offer an
equivalent browser host, Pilas-melonDS did not provide matching auditable core
source alongside its prebuilt browser runtime, and 44670/melonDS-wasm is stale.
See `THIRD_PARTY_NOTICES.md` for component attribution, including the existing
MPL-2.0 mGBA dependency.

## Reproducing the runtime

Generated artifacts are ignored: `public/emulators/melonds/wasmemulator.{js,wasm}`.
They must be regenerated from the tracked source rather than committed.

```bash
git submodule update --init --recursive
git clone https://github.com/emscripten-core/emsdk.git /tmp/emsdk
/tmp/emsdk/emsdk install 3.1.74
/tmp/emsdk/emsdk activate 3.1.74
source /tmp/emsdk/emsdk_env.sh
npm run build:melonds
npm run build
```

`build:melonds` verifies the pinned source revision, applies
`third_party/patches/0001-expose-arm9-bus-reads.patch` exactly once, configures
the `wasmemulator` target with Qt/SDL/OpenGL/GDB disabled, and copies its JS and
WASM output to the ignored runtime directory. Local modifications are therefore
reviewable source, not opaque binaries.

## Runtime architecture

```text
LoadedRom -> RomSessionStore -> MelonDsPlayer -> MelonDsBridge -> melonDS WASM
```

`MelonDsPlayer` owns only React controls/canvases. `MelonDsBridge` owns the
runtime lifecycle, virtual filesystem ROM copy, direct boot, input mask, frame
upload, touch conversion, and memory boundary. Generic UI and multiplayer code
do not use Emscripten or melonDS APIs directly.

The core direct-boots through the DS Anywhere FreeBIOS/HLE path. It does not
ship Nintendo BIOS, firmware, ROM, NAND, or save assets.

## Video and input

The native core calls its frame callback after producing two 256×192 RGBA frame
buffers. The bridge copies those buffers to ordinary canvases without putting
frames in React state. Keyboard controls are D-pad, `X=A`, `Z=B`, `S=X`,
`A=Y`, `Q/W=L/R`, `Enter=Start`, and right Shift=Select. Pointer coordinates
are calculated from the displayed bottom canvas rectangle and scaled/clamped to
the DS's 256×192 touchscreen space.

## ARM9 bus API

The local source patch adds Embind methods `readArm9U8`, `readArm9U16`, and
`readArm9U32`. They call melonDS `NDS::ARM9Read8/16/32`, so their address is an
**emulated ARM9-visible Nintendo DS bus address**, not an Emscripten `HEAPU8`
offset. `MelonDsBridge` exposes `read8`, `read16`, `read32`, and bounded
`readBytes` (0–65536 bytes). Development builds include a small read at
`0x02000000` as an end-to-end diagnostic once a ROM is running.

Only framebuffer presentation reads `HEAPU8`, using pointers returned by the
native core; that is separate from game-memory access.

## Current limitations / next verification

- Test White 2 boot, controls, touch, leaving/relaunching, and the ARM9
  diagnostic with a user-owned local ROM.
- Verify/persist cartridge saves through the core's eventual IDBFS/save hook.
- Add audio only after visual/input/lifecycle validation.
- Do not begin White 2 player-coordinate research until DS boot and ARM9 reads
  are manually proven.
