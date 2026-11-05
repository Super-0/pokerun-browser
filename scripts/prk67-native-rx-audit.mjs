import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * PRK67: Count native Wi-Fi receive decisions after PRK66 frame dequeue.
 * No packet logging, no change to native receive timing or filtering.
 * Fail closed if the pinned melonDS source does not match exactly.
 */
export function applyPrk67NativeRxAudit(source) {
  const header = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.h')
  const platform = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmPlatform.cpp')
  const wifi = resolve(source, 'wasmelonDS/src/Wifi.cpp')
  const cpp = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.cpp')
  function replaceUnique(path, before, after) {
    const original = readFileSync(path, 'utf8')
    const count = original.split(before).length - 1
    if (count !== 1) throw new Error('PRK67 pinned source mismatch in ' + path + ': ' + count)
    writeFileSync(path, original.replace(before, after))
  }

  replaceUnique(header,
    '    melonDS::u32 prk66FramesDropped() const { return prk66FramesDroppedCount.load(std::memory_order_relaxed); }',
    `    melonDS::u32 prk66FramesDropped() const { return prk66FramesDroppedCount.load(std::memory_order_relaxed); }

    // PRK67: receive decisions from the actual Wifi::CheckRX path.
    std::atomic<melonDS::u32> prk67RxAcceptedCount{0};
    std::atomic<melonDS::u32> prk67RxBadLengthCount{0};
    std::atomic<melonDS::u32> prk67RxBadChannelCount{0};
    std::atomic<melonDS::u32> prk67RxMpFilteredCount{0};
    std::atomic<melonDS::u32> prk67RxBeaconCount{0};
    std::atomic<melonDS::u32> prk67RxAssocAcceptedCount{0};

    melonDS::u32 prk67RxAccepted() const { return prk67RxAcceptedCount.load(std::memory_order_relaxed); }
    melonDS::u32 prk67RxBadLength() const { return prk67RxBadLengthCount.load(std::memory_order_relaxed); }
    melonDS::u32 prk67RxBadChannel() const { return prk67RxBadChannelCount.load(std::memory_order_relaxed); }
    melonDS::u32 prk67RxMpFiltered() const { return prk67RxMpFilteredCount.load(std::memory_order_relaxed); }
    melonDS::u32 prk67RxBeacon() const { return prk67RxBeaconCount.load(std::memory_order_relaxed); }
    melonDS::u32 prk67RxAssocAccepted() const { return prk67RxAssocAcceptedCount.load(std::memory_order_relaxed); }`)

  replaceUnique(platform, '  // NetPlay interface (going to likely remain unimplemented)',
    `  // PRK67 observations are called from the native Wifi::CheckRX path,
  // ONLY for a successfully dequeued PRK66 host-radio frame.
  void PokerunPrk67RecordRx(void* userdata, int kind) {
    auto* emulator = Prk63Emulator(userdata);
    if (!emulator || !emulator->prk66Enabled.load(std::memory_order_acquire)) return;
    switch (kind) {
      case 0: emulator->prk67RxAcceptedCount.fetch_add(1, std::memory_order_relaxed); break;
      case 1: emulator->prk67RxBadLengthCount.fetch_add(1, std::memory_order_relaxed); break;
      case 2: emulator->prk67RxBadChannelCount.fetch_add(1, std::memory_order_relaxed); break;
      case 3: emulator->prk67RxMpFilteredCount.fetch_add(1, std::memory_order_relaxed); break;
      case 4: emulator->prk67RxBeaconCount.fetch_add(1, std::memory_order_relaxed); break;
      case 5: emulator->prk67RxAssocAcceptedCount.fetch_add(1, std::memory_order_relaxed); break;
    }
  }

  // NetPlay interface (going to likely remain unimplemented)`)

  replaceUnique(wifi, '#include "Platform.h"\n\nnamespace melonDS',
    `#include "Platform.h"

// PRK67 WASM-only research declaration: defined in the patched WasmPlatform.cpp.
// No production build uses this pinned, build-time modified copy.
namespace melonDS::Platform { void PokerunPrk67RecordRx(void* userdata, int kind); }

namespace melonDS`)

  replaceUnique(wifi,
    `    u8 txrate, chan;
    u64 timestamp;

    for (;;)
    {
        timestamp = 0;`,
    `    u8 txrate, chan;
    u64 timestamp;
    bool prk67NativeFrame = false;

    for (;;)
    {
        timestamp = 0;
        prk67NativeFrame = false;`)

  replaceUnique(wifi,
    `            rxlen = Platform::MP_RecvPacket(RXBuffer, &timestamp, NDS.UserData);
            if ((rxlen <= 0) && (!IsMP))`,
    `            rxlen = Platform::MP_RecvPacket(RXBuffer, &timestamp, NDS.UserData);
            prk67NativeFrame = rxlen > 0;
            if ((rxlen <= 0) && (!IsMP))`)

  replaceUnique(wifi,
    `            rxlen = Platform::MP_RecvHostPacket(RXBuffer, &timestamp, NDS.UserData);
            if (rxlen < 0)`,
    `            rxlen = Platform::MP_RecvHostPacket(RXBuffer, &timestamp, NDS.UserData);
            prk67NativeFrame = rxlen > 0;
            if (rxlen < 0)`)

  replaceUnique(wifi,
    `        if (rxlen <= 0) return false;
        if (rxlen < 12+24) continue;

        framelen = *(u16*)&RXBuffer[10];`,
    `        if (rxlen <= 0) return false;
        if (rxlen < 12+24) {
            if (prk67NativeFrame) Platform::PokerunPrk67RecordRx(NDS.UserData, 1);
            continue;
        }

        framelen = *(u16*)&RXBuffer[10];`)

  replaceUnique(wifi,
    `            Log(LogLevel::Error, "bad frame length %d/%d\\n", framelen, rxlen-12);
            continue;`,
    `            Log(LogLevel::Error, "bad frame length %d/%d\\n", framelen, rxlen-12);
            if (prk67NativeFrame) Platform::PokerunPrk67RecordRx(NDS.UserData, 1);
            continue;`)

  replaceUnique(wifi,
    `            Log(LogLevel::Debug, "received frame but bad channel %d (expected %d)\\n", chan, CurChannel);
            continue;`,
    `            Log(LogLevel::Debug, "received frame but bad channel %d (expected %d)\\n", chan, CurChannel);
            if (prk67NativeFrame) Platform::PokerunPrk67RecordRx(NDS.UserData, 2);
            continue;`)

  replaceUnique(wifi,
    `                MACEqual(&RXBuffer[12 + 4], MPReplyMAC))
            {
                continue;
            }`,
    `                MACEqual(&RXBuffer[12 + 4], MPReplyMAC))
            {
                if (prk67NativeFrame) Platform::PokerunPrk67RecordRx(NDS.UserData, 3);
                continue;
            }`)

  replaceUnique(wifi,
    `        if (framelen < 0) framelen = 0;

        break;
    }

    WIFI_LOG("wifi: received packet`,
    `        if (framelen < 0) framelen = 0;

        if (prk67NativeFrame) {
            Platform::PokerunPrk67RecordRx(NDS.UserData, 0);
            if ((framectl & 0xFC) == 0x80)
                Platform::PokerunPrk67RecordRx(NDS.UserData, 4);
        }
        break;
    }

    WIFI_LOG("wifi: received packet`)

  // This is intentionally narrower than seeing a native frame pass CheckRX:
  // the emulated Wi-Fi client actually accepted a positive AID in its
  // association response. No AIDs or MAC addresses leave WASM.
  replaceUnique(wifi,
    `            IsMP = true;
            IsMPClient = true;
            USTimestamp = timestamp;`,
    `            IsMP = true;
            IsMPClient = true;
            if (prk67NativeFrame) Platform::PokerunPrk67RecordRx(NDS.UserData, 5);
            USTimestamp = timestamp;`)

  replaceUnique(cpp,
    '    .function("prk66FramesDropped", &wasmelon::WasmEmulator::prk66FramesDropped)',
    `    .function("prk66FramesDropped", &wasmelon::WasmEmulator::prk66FramesDropped)
    .function("prk67RxAccepted", &wasmelon::WasmEmulator::prk67RxAccepted)
    .function("prk67RxBadLength", &wasmelon::WasmEmulator::prk67RxBadLength)
    .function("prk67RxBadChannel", &wasmelon::WasmEmulator::prk67RxBadChannel)
    .function("prk67RxMpFiltered", &wasmelon::WasmEmulator::prk67RxMpFiltered)
    .function("prk67RxBeacon", &wasmelon::WasmEmulator::prk67RxBeacon)
    .function("prk67RxAssocAccepted", &wasmelon::WasmEmulator::prk67RxAssocAccepted)`)
  replaceUnique(cpp, 'return 0x50524B3F;', 'return 0x50524B40;')
  console.log('[PokéRun] PRK67 native Wi-Fi receiver audits installed; no frame content exported.')
}
