import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// PRK81F: isolated native futex wait; no changes to actual wireless callbacks.
export function applyPrk81fNativeMailbox(source) {
  const header = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.h')
  const cpp = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.cpp')
  const replaceUnique = (file, before, after) => {
    const content = readFileSync(file, 'utf8')
    const count = content.split(before).length - 1
    if (count !== 1) throw new Error('PRK81F source mismatch: ' + file + ' (' + count + ')')
    writeFileSync(file, content.replace(before, after))
  }

  // offsetof is also evaluated in source units that include this header.
  replaceUnique(header, '#include <emscripten/bind.h>',
    '#include <emscripten/bind.h>\n#include <cstddef>')

  replaceUnique(cpp, '#include <emscripten.h>',
    '#include <emscripten.h>\n#include <emscripten/threading.h>\n#include <cstddef>\n#include <cstdint>')

  const headerFields = [
    '    int prk81AsyncifyProbe(int delayMs);',
    '    // Fixed 96-byte shared WASM mailbox, no game state or radio linkage.',
    '    struct alignas(4) Prk81fMailbox {',
    '      std::atomic<melonDS::u32> state{0};',
    '      std::atomic<melonDS::u32> expectedSequence{0};',
    '      std::atomic<melonDS::u32> receivedSequence{0};',
    '      std::atomic<melonDS::u32> length{0};',
    '      std::atomic<melonDS::u32> aid{0};',
    '      melonDS::u32 reserved[3]{};',
    '      melonDS::u8 packet[64]{};',
    '    };',
    '    static_assert(sizeof(std::atomic<melonDS::u32>) == 4);',
    '    static_assert(offsetof(Prk81fMailbox, packet) == 32);',
    '    Prk81fMailbox prk81fMailbox;',
    '    unsigned prk81fMailboxPtr();',
    '    // 1 valid packet; 0 timeout; -1 invalid args; -2 wrong sequence;',
    '    // -3 wrong packet. Never fakes a wireless success ACK.',
    '    int prk81fWaitForReply(int sequence, int timeoutMs);'
  ].join('\n')
  replaceUnique(header, '    int prk81AsyncifyProbe(int delayMs);', headerFields)

  const impl = [
    '  unsigned WasmEmulator::prk81fMailboxPtr() {',
    '    return static_cast<unsigned>(reinterpret_cast<uintptr_t>(&prk81fMailbox));',
    '  }',
    '  int WasmEmulator::prk81fWaitForReply(int sequence, int timeoutMs) {',
    '    if (sequence < 1 || sequence > 65535 || timeoutMs < 1 || timeoutMs > 2000) return -1;',
    '    auto& m = prk81fMailbox;',
    '    m.expectedSequence.store(static_cast<melonDS::u32>(sequence), std::memory_order_relaxed);',
    '    m.receivedSequence.store(0, std::memory_order_relaxed);',
    '    m.length.store(0, std::memory_order_relaxed);',
    '    m.aid.store(0, std::memory_order_relaxed);',
    '    m.state.store(1, std::memory_order_release);',
    '    const double deadline = emscripten_get_now() + timeoutMs;',
    '    for (;;) {',
    '      if (m.state.load(std::memory_order_acquire) == 2) {',
    '        const auto received = m.receivedSequence.load(std::memory_order_relaxed);',
    '        const auto len = m.length.load(std::memory_order_relaxed);',
    '        const auto aid = m.aid.load(std::memory_order_relaxed);',
    '        int result = 1;',
    '        if (received != static_cast<melonDS::u32>(sequence)) result = -2;',
    '        else if (len != 36 || aid != 1 || m.packet[10] != 24 ||',
    '                 m.packet[11] != 0 || m.packet[12] != 8 ||',
    '                 m.packet[13] != 1 || m.packet[14] != (sequence & 255)) result = -3;',
    '        m.state.store(0, std::memory_order_release);',
    '        return result;',
    '      }',
    '      const double msRemaining = deadline - emscripten_get_now();',
    '      if (msRemaining <= 0) {',
    '        melonDS::u32 expected = 1;',
    '        if (m.state.compare_exchange_strong(expected, 0, std::memory_order_acq_rel)) return 0;',
    '        continue; // Consume a frame published at the deadline.',
    '      }',
    '      emscripten_futex_wait(reinterpret_cast<volatile void*>(&m.state), 1, msRemaining);',
    '    }',
    '  }',
    '',
    '  void WasmEmulator::setBatteryLevels() {'
  ].join('\n')
  replaceUnique(cpp, '  void WasmEmulator::setBatteryLevels() {', impl)

  replaceUnique(cpp,
    '    .function("prk81AsyncifyProbe", &wasmelon::WasmEmulator::prk81AsyncifyProbe)',
    '    .function("prk81AsyncifyProbe", &wasmelon::WasmEmulator::prk81AsyncifyProbe)\n' +
    '    .function("prk81fMailboxPtr", &wasmelon::WasmEmulator::prk81fMailboxPtr)\n' +
    '    .function("prk81fWaitForReply", &wasmelon::WasmEmulator::prk81fWaitForReply)')
  replaceUnique(cpp, 'return 0x50524B48;', 'return 0x50524B49;')
  console.log('[PokéRun] PRK81F native shared-memory futex probe installed')
}
