import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * PRK81A: Asyncify feasibility spike, not a multiplayer fix.
 * Keep this patch isolated from radio and guest-memory code.
 * Applied after PRK80 to the pinned melonDS source.
 */
export function applyPrk81AsyncifyProbe(source) {
  const header = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.h')
  const cpp = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.cpp')
  function replaceUnique(path, oldText, newText) {
    const data = readFileSync(path, 'utf8')
    const matches = data.split(oldText).length - 1
    if (matches !== 1) {
      throw new Error('PRK81A pinned-source mismatch ' + path + ': ' + matches)
    }
    writeFileSync(path, data.replace(oldText, newText))
  }

  replaceUnique(cpp,
    '#include <memory>',
    '#include <memory>\n#include <emscripten.h>')

  replaceUnique(header,
    '    melonDS::u32 prk80AckOk() const { return prk80AckOkCount.load(std::memory_order_relaxed); }',
    '    melonDS::u32 prk80AckOk() const { return prk80AckOkCount.load(std::memory_order_relaxed); }\n    // Test-only, no interaction with ROM, multiplayer queues or saved data.\n    int prk81AsyncifyProbe(int delayMs);')

  replaceUnique(cpp,
    '  void WasmEmulator::setBatteryLevels() {',
    `  // Proves that a native Embind call yields to the browser event loop and
  // resumes. PRK81B will only attempt real reply waiting after this passes.
  int WasmEmulator::prk81AsyncifyProbe(int delayMs) {
    if (delayMs < 1 || delayMs > 100) return -1;
    emscripten_sleep(static_cast<unsigned>(delayMs));
    return 0x81;
  }

  void WasmEmulator::setBatteryLevels() {`)

  replaceUnique(cpp,
    '    .function("prk80AckOk", &wasmelon::WasmEmulator::prk80AckOk)',
    '    .function("prk80AckOk", &wasmelon::WasmEmulator::prk80AckOk)\n    .function("prk81AsyncifyProbe", &wasmelon::WasmEmulator::prk81AsyncifyProbe)')

  replaceUnique(cpp, 'return 0x50524B46;', 'return 0x50524B47;')
  console.log('[PokéRun] PRK81A Asyncify feasibility probe installed')
}
