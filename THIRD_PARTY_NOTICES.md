# Third-party notices

PokéRun does not include Nintendo ROMs, BIOS, firmware, save files, or other
Nintendo proprietary assets. Users supply their own ROMs locally.

## DS Anywhere / wasmelonDS / melonDS-derived runtime

- **Source:** `third_party/ds-anywhere`, pinned Git submodule
- **Upstream:** <https://github.com/brxxn/ds-anywhere>
- **Pinned revision:** `53c7c6cb362560a9e362ae754a162f638fa3cd64`
- **License:** GNU GPL version 3.0 (see `third_party/ds-anywhere/LICENSE` and
  `third_party/ds-anywhere/wasmelonDS/LICENSE`)
- **Use in PokéRun:** The submodule supplies the source and build tooling for
  the browser-targeted melonDS-derived WebAssembly core. PokéRun retains its
  own React UI; it does not incorporate DS Anywhere's Preact application.

Any local modifications to this source must be recorded as root-repository
patches and applied during the documented runtime build, so generated artifacts
always have corresponding source.

## @thenick775/mgba-wasm

- **Package:** `@thenick775/mgba-wasm` version `2.5.1`
- **Upstream:** <https://github.com/thenick775/mgba>
- **Package license:** MPL-2.0
- **Use in PokéRun:** Existing local GBA emulation used by `MgbaPlayer`.

The installed package metadata identifies MPL-2.0. The inspected package
license material contains no `Incompatible With Secondary Licenses` notice.
Its source/license notices must be preserved when distributing that component.

## Emscripten

The reproducible DS runtime build uses Emscripten 3.1.74. Emscripten is used as
a build tool; its own MIT license applies to Emscripten, not to melonDS-derived
runtime code.
