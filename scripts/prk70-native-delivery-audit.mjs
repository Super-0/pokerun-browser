import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * PRK70 — actual downstream DS Wi-Fi receive checks, no packet content.
 * Distinguishes a CheckRX match from the later FinishRX ring/IRQ stage,
 * plus detects whether the incoming beacon's transmitter address equals
 * the receiver's own hardware MAC. Strictly source-matched and read-only.
 */
export function applyPrk70ReceiveDeliveryAudit(source) {
  const header = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.h')
  const wifiHeader = resolve(source, 'wasmelonDS/src/Wifi.h')
  const platform = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmPlatform.cpp')
  const wifi = resolve(source, 'wasmelonDS/src/Wifi.cpp')
  const cpp = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.cpp')
  function replaceUnique(path, before, after) {
    const data = readFileSync(path, 'utf8')
    const n = data.split(before).length - 1
    if (n !== 1) throw new Error('PRK70 unexpected pinned source in ' + path + ': ' + n)
    writeFileSync(path, data.replace(before, after))
  }

  replaceUnique(header,
    '    melonDS::u32 prk69ChannelChanges() const { return prk69ChannelChangesCount.load(std::memory_order_relaxed); }',
    `    melonDS::u32 prk69ChannelChanges() const { return prk69ChannelChangesCount.load(std::memory_order_relaxed); }

    // All counts are aggregate observations; no MACs or frame bytes exported.
    std::atomic<melonDS::u32> prk70BeaconSameMacCount{0};
    std::atomic<melonDS::u32> prk70BeaconDifferentMacCount{0};
    std::atomic<melonDS::u32> prk70NativeRxFinishedCount{0};
    std::atomic<melonDS::u32> prk70DestFilteredCount{0};
    std::atomic<melonDS::u32> prk70WepFilteredCount{0};
    std::atomic<melonDS::u32> prk70BeaconBssidMatchedCount{0};
    std::atomic<melonDS::u32> prk70BeaconFilterDroppedCount{0};
    std::atomic<melonDS::u32> prk70RxRingIrqCount{0};
    void prk70Record(int kind) {
      switch (kind) {
        case 0: prk70BeaconSameMacCount.fetch_add(1, std::memory_order_relaxed); break;
        case 1: prk70BeaconDifferentMacCount.fetch_add(1, std::memory_order_relaxed); break;
        case 2: prk70NativeRxFinishedCount.fetch_add(1, std::memory_order_relaxed); break;
        case 3: prk70DestFilteredCount.fetch_add(1, std::memory_order_relaxed); break;
        case 4: prk70WepFilteredCount.fetch_add(1, std::memory_order_relaxed); break;
        case 5: prk70BeaconBssidMatchedCount.fetch_add(1, std::memory_order_relaxed); break;
        case 6: prk70BeaconFilterDroppedCount.fetch_add(1, std::memory_order_relaxed); break;
        case 7: prk70RxRingIrqCount.fetch_add(1, std::memory_order_relaxed); break;
      }
    }
    melonDS::u32 prk70BeaconSameMac() const { return prk70BeaconSameMacCount.load(std::memory_order_relaxed); }
    melonDS::u32 prk70BeaconDifferentMac() const { return prk70BeaconDifferentMacCount.load(std::memory_order_relaxed); }
    melonDS::u32 prk70NativeRxFinished() const { return prk70NativeRxFinishedCount.load(std::memory_order_relaxed); }
    melonDS::u32 prk70DestFiltered() const { return prk70DestFilteredCount.load(std::memory_order_relaxed); }
    melonDS::u32 prk70WepFiltered() const { return prk70WepFilteredCount.load(std::memory_order_relaxed); }
    melonDS::u32 prk70BeaconBssidMatched() const { return prk70BeaconBssidMatchedCount.load(std::memory_order_relaxed); }
    melonDS::u32 prk70BeaconFilterDropped() const { return prk70BeaconFilterDroppedCount.load(std::memory_order_relaxed); }
    melonDS::u32 prk70RxRingIrq() const { return prk70RxRingIrqCount.load(std::memory_order_relaxed); }`)

  replaceUnique(platform,
    '  void PokerunPrk69RecordTuning(void* userdata, int channel) {',
    `  void PokerunPrk70RecordRx(void* userdata, int kind) {
    auto* emulator = Prk63Emulator(userdata);
    if (!emulator || !emulator->prk66Enabled.load(std::memory_order_acquire)) return;
    emulator->prk70Record(kind);
  }
  void PokerunPrk69RecordTuning(void* userdata, int channel) {`)

  replaceUnique(wifiHeader,
    `    u32 RXHalfwordTimeMask;

    u32 ComStatus;`,
    `    u32 RXHalfwordTimeMask;
    // PRK70: attribution of a native PRK66 frame through asynchronous FinishRX.
    bool Prk70NativeRxInFlight = false;

    u32 ComStatus;`)

  replaceUnique(wifi,
    `  void PokerunPrk69RecordTuning(void* userdata, int channel);
}`,
    `  void PokerunPrk69RecordTuning(void* userdata, int channel);
  void PokerunPrk70RecordRx(void* userdata, int kind);
}`)

  replaceUnique(wifi,
    `    Enabled = false;
    PowerOn = false;`,
    `    Enabled = false;
    PowerOn = false;
    Prk70NativeRxInFlight = false;`)

  replaceUnique(wifi,
    `    // TODO: RX stats

    u16 framectl = *(u16*)&RXBuffer[12];`,
    `    // TODO: RX stats
    const bool prk70NativeFrame = Prk70NativeRxInFlight;
    Prk70NativeRxInFlight = false;
    if (prk70NativeFrame) Platform::PokerunPrk70RecordRx(NDS.UserData, 2);

    u16 framectl = *(u16*)&RXBuffer[12];`)

  replaceUnique(wifi,
    `        if (!MACEqual(dstmac, (u8*)&IOPORT(W_MACAddr0)))
            return;`,
    `        if (!MACEqual(dstmac, (u8*)&IOPORT(W_MACAddr0))) {
            if (prk70NativeFrame) Platform::PokerunPrk70RecordRx(NDS.UserData, 3);
            return;
        }`)

  replaceUnique(wifi,
    `        if (!(IOPORT(W_WEPCnt) & (1<<15)))
            return;`,
    `        if (!(IOPORT(W_WEPCnt) & (1<<15))) {
            if (prk70NativeFrame) Platform::PokerunPrk70RecordRx(NDS.UserData, 4);
            return;
        }`)

  replaceUnique(wifi,
    `            if (subtype == 0x8) // beacon
            {
                if (!(rxflags & 0x8000))`,
    `            if (subtype == 0x8) // beacon
            {
                if (prk70NativeFrame && (rxflags & 0x8000))
                    Platform::PokerunPrk70RecordRx(NDS.UserData, 5);
                if (!(rxflags & 0x8000))`)

  replaceUnique(wifi,
    `                    if (!(IOPORT(W_RXFilter) & (1<<0)))
                        return;`,
    `                    if (!(IOPORT(W_RXFilter) & (1<<0))) {
                        if (prk70NativeFrame) Platform::PokerunPrk70RecordRx(NDS.UserData, 6);
                        return;
                    }`)

  replaceUnique(wifi,
    `        SetIRQ(0);
    }

    if ((rxflags & 0x800F) == 0x800C)`,
    `        SetIRQ(0);
        if (prk70NativeFrame) Platform::PokerunPrk70RecordRx(NDS.UserData, 7);
    }

    if ((rxflags & 0x800F) == 0x800C)`)

  // This observes both matching and non-matching beacon transmitter addresses
  // AFTER the built-in 802.11 length check and BEFORE the channel check.
  // No address ever leaves WASM; only equality is recorded.
  replaceUnique(wifi,
    `        chan = RXBuffer[9];
        if (chan != CurChannel || CurChannel == 0)`,
    `        if (prk67NativeFrame && (RXBuffer[12] & 0xFC) == 0x80) {
            Platform::PokerunPrk70RecordRx(NDS.UserData,
                MACEqual(&RXBuffer[12 + 10], (u8*)&IOPORT(W_MACAddr0)) ? 0 : 1);
        }
        chan = RXBuffer[9];
        if (chan != CurChannel || CurChannel == 0)`)

  replaceUnique(wifi,
    `        break;
    }

    WIFI_LOG("wifi: received packet`,
    `        Prk70NativeRxInFlight = prk67NativeFrame;
        break;
    }

    WIFI_LOG("wifi: received packet`)

  replaceUnique(cpp,
    '    .function("prk69ChannelChanges", &wasmelon::WasmEmulator::prk69ChannelChanges)',
    `    .function("prk69ChannelChanges", &wasmelon::WasmEmulator::prk69ChannelChanges)
    .function("prk70BeaconSameMac", &wasmelon::WasmEmulator::prk70BeaconSameMac)
    .function("prk70BeaconDifferentMac", &wasmelon::WasmEmulator::prk70BeaconDifferentMac)
    .function("prk70NativeRxFinished", &wasmelon::WasmEmulator::prk70NativeRxFinished)
    .function("prk70DestFiltered", &wasmelon::WasmEmulator::prk70DestFiltered)
    .function("prk70WepFiltered", &wasmelon::WasmEmulator::prk70WepFiltered)
    .function("prk70BeaconBssidMatched", &wasmelon::WasmEmulator::prk70BeaconBssidMatched)
    .function("prk70BeaconFilterDropped", &wasmelon::WasmEmulator::prk70BeaconFilterDropped)
    .function("prk70RxRingIrq", &wasmelon::WasmEmulator::prk70RxRingIrq)`)
  replaceUnique(cpp, 'return 0x50524B41;', 'return 0x50524B42;')
  console.log('[PokéRun] PRK70 downstream radio acceptance / MAC collision audit installed without exposing MACs.')
}
