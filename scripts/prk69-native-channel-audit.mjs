import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * PRK69 — read-only RF channel attribution (after PRK66 + PRK67).
 * Monitors unmodified game-driven channel changes and attempted sends.
 * Counts Wi-Fi acceptance by sender channel; never modifies radio tuning.
 */
export function applyPrk69ChannelAudit(source) {
  const header = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.h')
  const platform = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmPlatform.cpp')
  const wifi = resolve(source, 'wasmelonDS/src/Wifi.cpp')
  const cpp = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.cpp')
  function replaceUnique(path, oldText, newText) {
    const original = readFileSync(path, 'utf8')
    const matches = original.split(oldText).length - 1
    if (matches !== 1) throw new Error('PRK69 pinned source mismatch ' + path + ': ' + matches)
    writeFileSync(path, original.replace(oldText, newText))
  }

  replaceUnique(header,
    '    melonDS::u32 prk67RxAssocAccepted() const { return prk67RxAssocAcceptedCount.load(std::memory_order_relaxed); }',
    `    melonDS::u32 prk67RxAssocAccepted() const { return prk67RxAssocAcceptedCount.load(std::memory_order_relaxed); }

    // Index 0 means invalid / unknown channel; 1–14 are DS RF channels.
    // Atomic counters contain only aggregate metadata, never packet bytes.
    std::atomic<melonDS::u32> prk69TxChannels[15]{};
    std::atomic<melonDS::u32> prk69AcceptedChannels[15]{};
    std::atomic<melonDS::u32> prk69WrongChannels[15]{};
    std::atomic<melonDS::u32> prk69TunedChannels[15]{};
    std::atomic<int> prk69CurrentChannelCount{0};
    std::atomic<melonDS::u32> prk69ChannelChangesCount{0};

    static int prk69ChannelIndex(int channel) {
      return (channel >= 1 && channel <= 14) ? channel : 0;
    }
    void prk69RecordTxChannel(int channel) {
      prk69TxChannels[prk69ChannelIndex(channel)].fetch_add(1, std::memory_order_relaxed);
    }
    void prk69RecordRxChannel(int kind, int channel) {
      const int index = prk69ChannelIndex(channel);
      if (kind == 0) prk69AcceptedChannels[index].fetch_add(1, std::memory_order_relaxed);
      if (kind == 1) prk69WrongChannels[index].fetch_add(1, std::memory_order_relaxed);
    }
    void prk69RecordTunedChannel(int channel) {
      const int index = prk69ChannelIndex(channel);
      const int previous = prk69CurrentChannelCount.exchange(index, std::memory_order_relaxed);
      if (index != previous) {
        prk69ChannelChangesCount.fetch_add(1, std::memory_order_relaxed);
        prk69TunedChannels[index].fetch_add(1, std::memory_order_relaxed);
      }
    }
    melonDS::u32 prk69TxChannel(int channel) const {
      if (channel < 0 || channel > 14) return 0;
      return prk69TxChannels[channel].load(std::memory_order_relaxed);
    }
    melonDS::u32 prk69AcceptedChannel(int channel) const {
      if (channel < 0 || channel > 14) return 0;
      return prk69AcceptedChannels[channel].load(std::memory_order_relaxed);
    }
    melonDS::u32 prk69WrongChannel(int channel) const {
      if (channel < 0 || channel > 14) return 0;
      return prk69WrongChannels[channel].load(std::memory_order_relaxed);
    }
    melonDS::u32 prk69TunedChannel(int channel) const {
      if (channel < 0 || channel > 14) return 0;
      return prk69TunedChannels[channel].load(std::memory_order_relaxed);
    }
    int prk69CurrentChannel() const { return prk69CurrentChannelCount.load(std::memory_order_relaxed); }
    melonDS::u32 prk69ChannelChanges() const { return prk69ChannelChangesCount.load(std::memory_order_relaxed); }`)

  replaceUnique(header,
    `      prk66TxQueue.push_back({std::vector<melonDS::u8>(bytes, bytes + length), timestamp});
      prk66TxQueuedCount.fetch_add(1, std::memory_order_relaxed);`,
    `      prk66TxQueue.push_back({std::vector<melonDS::u8>(bytes, bytes + length), timestamp});
      prk69RecordTxChannel(bytes[9]);
      prk66TxQueuedCount.fetch_add(1, std::memory_order_relaxed);`)

  replaceUnique(platform,
    '  void PokerunPrk67RecordRx(void* userdata, int kind) {',
    `  // RF channel data is recorded without touching channel selection, timing
  // or actual Wi-Fi frame contents. Captures only known PRK66 RX decisions.
  void PokerunPrk69RecordRxChannel(void* userdata, int kind, int channel) {
    auto* emulator = Prk63Emulator(userdata);
    if (!emulator || !emulator->prk66Enabled.load(std::memory_order_acquire)) return;
    emulator->prk69RecordRxChannel(kind, channel);
  }
  void PokerunPrk69RecordTuning(void* userdata, int channel) {
    auto* emulator = Prk63Emulator(userdata);
    if (emulator) emulator->prk69RecordTunedChannel(channel);
  }
  void PokerunPrk67RecordRx(void* userdata, int kind) {`)

  replaceUnique(wifi,
    'namespace melonDS::Platform { void PokerunPrk67RecordRx(void* userdata, int kind); }',
    `namespace melonDS::Platform {
  void PokerunPrk67RecordRx(void* userdata, int kind);
  void PokerunPrk69RecordRxChannel(void* userdata, int kind, int channel);
  void PokerunPrk69RecordTuning(void* userdata, int channel);
}`)

  replaceUnique(wifi,
    `            if (prk67NativeFrame) Platform::PokerunPrk67RecordRx(NDS.UserData, 2);
            continue;`,
    `            if (prk67NativeFrame) {
                Platform::PokerunPrk67RecordRx(NDS.UserData, 2);
                Platform::PokerunPrk69RecordRxChannel(NDS.UserData, 1, chan);
            }
            continue;`)

  replaceUnique(wifi,
    `            Platform::PokerunPrk67RecordRx(NDS.UserData, 0);
            if ((framectl & 0xFC) == 0x80)`,
    `            Platform::PokerunPrk67RecordRx(NDS.UserData, 0);
            Platform::PokerunPrk69RecordRxChannel(NDS.UserData, 0, chan);
            if ((framectl & 0xFC) == 0x80)`)

  replaceUnique(wifi,
    `    if (CurChannel > 0)
        Log(LogLevel::Debug, "wifi: switching to channel %d\\n", CurChannel);`,
    `    Platform::PokerunPrk69RecordTuning(NDS.UserData, CurChannel);
    if (CurChannel > 0)
        Log(LogLevel::Debug, "wifi: switching to channel %d\\n", CurChannel);`)

  replaceUnique(cpp,
    '    .function("prk67RxAssocAccepted", &wasmelon::WasmEmulator::prk67RxAssocAccepted)',
    `    .function("prk67RxAssocAccepted", &wasmelon::WasmEmulator::prk67RxAssocAccepted)
    .function("prk69TxChannel", &wasmelon::WasmEmulator::prk69TxChannel)
    .function("prk69AcceptedChannel", &wasmelon::WasmEmulator::prk69AcceptedChannel)
    .function("prk69WrongChannel", &wasmelon::WasmEmulator::prk69WrongChannel)
    .function("prk69TunedChannel", &wasmelon::WasmEmulator::prk69TunedChannel)
    .function("prk69CurrentChannel", &wasmelon::WasmEmulator::prk69CurrentChannel)
    .function("prk69ChannelChanges", &wasmelon::WasmEmulator::prk69ChannelChanges)`)

  replaceUnique(cpp, 'return 0x50524B40;', 'return 0x50524B41;')
  console.log('[PokéRun] PRK69 per-channel native RF audit installed (read-only).')
}
