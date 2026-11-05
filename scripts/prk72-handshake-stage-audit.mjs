import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * PRK72: aggregate 802.11 handshake-stage frame types. No frame dumps.
 * Keeps radio behavior unchanged and counts native packets by management
 * subtype at TX and at the actual receive-ring interrupt.
 */
export function applyPrk72HandshakeStageAudit(source) {
  const header = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.h')
  const platform = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmPlatform.cpp')
  const wifi = resolve(source, 'wasmelonDS/src/Wifi.cpp')
  const cpp = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.cpp')
  function replaceUnique(path, before, after) {
    const data = readFileSync(path, 'utf8')
    const hits = data.split(before).length - 1
    if (hits !== 1) throw new Error('PRK72 pinned source mismatch in ' + path + ': ' + hits)
    writeFileSync(path, data.replace(before, after))
  }
  replaceUnique(header,
    '    int prk71AppliedFirmwareMacRole() const {\n      return prk71FirmwareGenerated ? prk71FirmwareMacRole : 0;\n    }',
    `    int prk71AppliedFirmwareMacRole() const {
      return prk71FirmwareGenerated ? prk71FirmwareMacRole : 0;
    }

    // 0 beacon; 1 probe request; 2 probe response; 3 auth;
    // 4 (re)association request; 5 (re)association response;
    // 6 deauth/disassociation; 7 other management;
    // 8 data; 9 control; 10 reserved/unknown.
    // Only aggregate counters are accessible to JavaScript.
    std::atomic<melonDS::u32> prk72TxFrameTypes[11]{};
    std::atomic<melonDS::u32> prk72RxFrameTypes[11]{};
    static unsigned prk72FrameKind(unsigned frameControl) {
      const unsigned type = (frameControl >> 2) & 3;
      const unsigned subtype = (frameControl >> 4) & 15;
      if (type == 0) {
        if (subtype == 8) return 0;
        if (subtype == 4) return 1;
        if (subtype == 5) return 2;
        if (subtype == 11) return 3;
        if (subtype == 0 || subtype == 2) return 4;
        if (subtype == 1 || subtype == 3) return 5;
        if (subtype == 10 || subtype == 12) return 6;
        return 7;
      }
      if (type == 2) return 8;
      if (type == 1) return 9;
      return 10;
    }
    void prk72RecordFrame(int direction, unsigned frameControl) {
      const unsigned kind = prk72FrameKind(frameControl);
      if (direction == 0) prk72TxFrameTypes[kind].fetch_add(1, std::memory_order_relaxed);
      else if (direction == 1) prk72RxFrameTypes[kind].fetch_add(1, std::memory_order_relaxed);
    }
    melonDS::u32 prk72TxKind(int kind) const {
      if (kind < 0 || kind >= 11) return 0;
      return prk72TxFrameTypes[kind].load(std::memory_order_relaxed);
    }
    melonDS::u32 prk72RxKind(int kind) const {
      if (kind < 0 || kind >= 11) return 0;
      return prk72RxFrameTypes[kind].load(std::memory_order_relaxed);
    }`)

  // The already-patched TX classifier is invoked by MP_SendPacket,
  // MP_SendCmd, MP_SendReply, MP_SendAck. Do not touch those send paths.
  replaceUnique(platform,
    `    const u8 subtype = (frameControl >> 4) & 15;
    switch (frameType) {`,
    `    const u8 subtype = (frameControl >> 4) & 15;
    // PRK72 classification uses only the 802.11 frame-control word.
    // The complete 24-byte MAC header is required before counting.
    if (len >= 36) {
      const unsigned controlWord = static_cast<unsigned>(data[12]) |
          (static_cast<unsigned>(data[13]) << 8);
      emulator->prk72RecordFrame(0, controlWord);
    }
    switch (frameType) {`)

  replaceUnique(platform,
    '  void PokerunPrk70RecordRx(void* userdata, int kind) {',
    `  void PokerunPrk72RecordRxFrame(void* userdata, unsigned frameControl) {
    auto* emulator = Prk63Emulator(userdata);
    if (!emulator || !emulator->prk66Enabled.load(std::memory_order_acquire)) return;
    emulator->prk72RecordFrame(1, frameControl);
  }
  void PokerunPrk70RecordRx(void* userdata, int kind) {`)

  replaceUnique(wifi,
    `  void PokerunPrk70RecordRx(void* userdata, int kind);
}`,
    `  void PokerunPrk70RecordRx(void* userdata, int kind);
  void PokerunPrk72RecordRxFrame(void* userdata, unsigned frameControl);
}`)

  // An incoming frame counts only after FinishRX wrote the native RX ring
  // and signalled IRQ 0. This is NOT game-level peer discovery.
  replaceUnique(wifi,
    `        SetIRQ(0);
        if (prk70NativeFrame) Platform::PokerunPrk70RecordRx(NDS.UserData, 7);`,
    `        SetIRQ(0);
        if (prk70NativeFrame) {
            Platform::PokerunPrk70RecordRx(NDS.UserData, 7);
            Platform::PokerunPrk72RecordRxFrame(NDS.UserData, framectl);
        }`)

  replaceUnique(cpp,
    '    .function("prk71AppliedFirmwareMacRole", &wasmelon::WasmEmulator::prk71AppliedFirmwareMacRole)',
    `    .function("prk71AppliedFirmwareMacRole", &wasmelon::WasmEmulator::prk71AppliedFirmwareMacRole)
    .function("prk72TxKind", &wasmelon::WasmEmulator::prk72TxKind)
    .function("prk72RxKind", &wasmelon::WasmEmulator::prk72RxKind)`)
  replaceUnique(cpp, 'return 0x50524B43;', 'return 0x50524B44;')
  console.log('[PokéRun] PRK72 native 802.11 handshake-stage counters installed; no payloads exported.')
}
