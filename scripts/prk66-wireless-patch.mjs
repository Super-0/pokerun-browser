import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * PRK66: strictly scoped experimental local-radio bridge.
 * Applied AFTER PRK63/65, to the exact pinned melonDS source.
 * Old single-emulator behavior stays unchanged until a user enables it.
 */
export function applyPrk66LocalRadioBridge(source) {
  const platform = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmPlatform.cpp')
  const header = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.h')
  const cpp = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.cpp')
  function replaceUnique(path, before, after) {
    const original = readFileSync(path, 'utf8')
    const count = original.split(before).length - 1
    if (count !== 1) throw new Error('PRK66 pinned-source context mismatch in ' + path + ': ' + count)
    writeFileSync(path, original.replace(before, after))
  }

  replaceUnique(header, '#include <atomic>', `#include <atomic>
#include <algorithm>
#include <deque>
#include <mutex>
#include <utility>
#include <vector>`)

  replaceUnique(header,
    '    melonDS::u32 prk65TxAck() const { return prk65TxAckCount.load(std::memory_order_relaxed); }',
    `    melonDS::u32 prk65TxAck() const { return prk65TxAckCount.load(std::memory_order_relaxed); }

    // PRK66: 2 actual DS instances only, opt-in, bounded browser-local radio.
    // 2048 is Wifi::RXBuffer's exact size. No storage, network relay, or logging.
    struct Prk66Frame {
      std::vector<melonDS::u8> bytes;
      melonDS::u64 timestamp = 0;
    };
    std::mutex prk66Mutex;
    std::deque<Prk66Frame> prk66TxQueue;
    std::deque<Prk66Frame> prk66RxQueue;
    std::atomic<bool> prk66Enabled{false};
    std::atomic<melonDS::u32> prk66TxQueuedCount{0};
    std::atomic<melonDS::u32> prk66RxQueuedCount{0};
    std::atomic<melonDS::u32> prk66RxConsumedCount{0};
    std::atomic<melonDS::u32> prk66FramesDroppedCount{0};

    void prk66SetEnabled(bool enabled) {
      prk66Enabled.store(false, std::memory_order_release);
      std::lock_guard<std::mutex> guard(prk66Mutex);
      prk66TxQueue.clear();
      prk66RxQueue.clear();
      prk66Enabled.store(enabled, std::memory_order_release);
    }
    bool prk66QueueTx(const melonDS::u8* bytes, int length, melonDS::u64 timestamp) {
      if (!prk66Enabled.load(std::memory_order_acquire)) return false;
      if (!bytes || length < 36 || length > 2048 ||
          (bytes[10] | (static_cast<unsigned>(bytes[11]) << 8)) !=
              static_cast<unsigned>(length - 12)) {
        prk66FramesDroppedCount.fetch_add(1, std::memory_order_relaxed);
        return false;
      }
      std::lock_guard<std::mutex> guard(prk66Mutex);
      if (!prk66Enabled.load(std::memory_order_acquire)) return false;
      if (prk66TxQueue.size() >= 32) {
        prk66FramesDroppedCount.fetch_add(1, std::memory_order_relaxed);
        return false;
      }
      prk66TxQueue.push_back({std::vector<melonDS::u8>(bytes, bytes + length), timestamp});
      prk66TxQueuedCount.fetch_add(1, std::memory_order_relaxed);
      return true;
    }
    int prk66ReadRx(melonDS::u8* dest, melonDS::u64* timestamp) {
      if (!prk66Enabled.load(std::memory_order_acquire)) return 0;
      Prk66Frame frame;
      {
        std::lock_guard<std::mutex> guard(prk66Mutex);
        if (prk66RxQueue.empty()) return 0;
        frame = std::move(prk66RxQueue.front());
        prk66RxQueue.pop_front();
      }
      const int length = static_cast<int>(frame.bytes.size());
      if (!dest || length < 36 || length > 2048) return 0;
      std::copy(frame.bytes.begin(), frame.bytes.end(), dest);
      if (timestamp) *timestamp = frame.timestamp;
      prk66RxConsumedCount.fetch_add(1, std::memory_order_relaxed);
      return length;
    }
    emscripten::val prk66TakeOutgoing();
    bool prk66InjectIncoming(emscripten::val bytes, double timestamp);
    melonDS::u32 prk66TxQueued() const { return prk66TxQueuedCount.load(std::memory_order_relaxed); }
    melonDS::u32 prk66RxQueued() const { return prk66RxQueuedCount.load(std::memory_order_relaxed); }
    melonDS::u32 prk66RxConsumed() const { return prk66RxConsumedCount.load(std::memory_order_relaxed); }
    melonDS::u32 prk66FramesDropped() const { return prk66FramesDroppedCount.load(std::memory_order_relaxed); }`)

  replaceUnique(cpp, '#include <codecvt>', '#include <codecvt>\n#include <cmath>')

  // Embed at top-level outside the original namespace, before its embind table.
  replaceUnique(cpp, 'EMSCRIPTEN_BINDINGS(WasmEmulator) {',
`namespace wasmelon {
  emscripten::val WasmEmulator::prk66TakeOutgoing() {
    Prk66Frame frame;
    {
      std::lock_guard<std::mutex> guard(prk66Mutex);
      if (prk66TxQueue.empty()) return emscripten::val::null();
      frame = std::move(prk66TxQueue.front());
      prk66TxQueue.pop_front();
    }
    auto bytes = emscripten::val::global("Uint8Array").new_(frame.bytes.size());
    bytes.call<void>("set", emscripten::val(
      emscripten::typed_memory_view(frame.bytes.size(), frame.bytes.data())));
    auto packet = emscripten::val::object();
    packet.set("bytes", bytes);
    packet.set("timestamp", static_cast<double>(frame.timestamp));
    return packet;
  }

  bool WasmEmulator::prk66InjectIncoming(emscripten::val bytes, double timestamp) {
    if (!prk66Enabled.load(std::memory_order_acquire)) return false;
    if (bytes.isNull() || bytes.isUndefined() || !std::isfinite(timestamp) ||
        timestamp < 0 || timestamp > 9007199254740991.0) return false;
    const auto length = bytes["byteLength"].as<unsigned>();
    if (length < 36 || length > 2048) {
      prk66FramesDroppedCount.fetch_add(1, std::memory_order_relaxed);
      return false;
    }
    std::vector<melonDS::u8> copy(length);
    auto target = emscripten::val(
      emscripten::typed_memory_view(copy.size(), copy.data()));
    target.call<void>("set", bytes);
    if ((copy[10] | (static_cast<unsigned>(copy[11]) << 8)) != length - 12) {
      prk66FramesDroppedCount.fetch_add(1, std::memory_order_relaxed);
      return false;
    }
    std::lock_guard<std::mutex> guard(prk66Mutex);
    if (!prk66Enabled.load(std::memory_order_acquire)) return false;
    if (prk66RxQueue.size() >= 32) {
      prk66FramesDroppedCount.fetch_add(1, std::memory_order_relaxed);
      return false;
    }
    prk66RxQueue.push_back({std::move(copy), static_cast<melonDS::u64>(timestamp)});
    prk66RxQueuedCount.fetch_add(1, std::memory_order_relaxed);
    return true;
  }
}

EMSCRIPTEN_BINDINGS(WasmEmulator) {`)

  replaceUnique(cpp,
    '    .function("prk65TxAck", &wasmelon::WasmEmulator::prk65TxAck)',
    `    .function("prk65TxAck", &wasmelon::WasmEmulator::prk65TxAck)
    .function("prk66SetEnabled", &wasmelon::WasmEmulator::prk66SetEnabled)
    .function("prk66TakeOutgoing", &wasmelon::WasmEmulator::prk66TakeOutgoing)
    .function("prk66InjectIncoming", &wasmelon::WasmEmulator::prk66InjectIncoming)
    .function("prk66TxQueued", &wasmelon::WasmEmulator::prk66TxQueued)
    .function("prk66RxQueued", &wasmelon::WasmEmulator::prk66RxQueued)
    .function("prk66RxConsumed", &wasmelon::WasmEmulator::prk66RxConsumed)
    .function("prk66FramesDropped", &wasmelon::WasmEmulator::prk66FramesDropped)`)

  const conversions = [
    [
`  int MP_SendPacket(u8* data, int len, u64, void* userdata) {
    if (auto* emulator = Prk63Emulator(userdata))
      emulator->prk63MpTxCallsCount.fetch_add(1, std::memory_order_relaxed);
    Prk65ObserveTx(data, len, userdata, 0);
    return 0;
  }`,
`  int MP_SendPacket(u8* data, int len, u64 timestamp, void* userdata) {
    if (auto* emulator = Prk63Emulator(userdata)) {
      emulator->prk63MpTxCallsCount.fetch_add(1, std::memory_order_relaxed);
      Prk65ObserveTx(data, len, userdata, 0);
      return emulator->prk66QueueTx(data, len, timestamp) ? len : 0;
    }
    return 0;
  }`,
    ],
    [
`  int MP_SendCmd(u8* data, int len, u64, void* userdata) {
    if (auto* emulator = Prk63Emulator(userdata))
      emulator->prk63MpTxCallsCount.fetch_add(1, std::memory_order_relaxed);
    Prk65ObserveTx(data, len, userdata, 1);
    return 0;
  }`,
`  int MP_SendCmd(u8* data, int len, u64 timestamp, void* userdata) {
    if (auto* emulator = Prk63Emulator(userdata)) {
      emulator->prk63MpTxCallsCount.fetch_add(1, std::memory_order_relaxed);
      Prk65ObserveTx(data, len, userdata, 1);
      return emulator->prk66QueueTx(data, len, timestamp) ? len : 0;
    }
    return 0;
  }`,
    ],
    [
`  int MP_SendReply(u8* data, int len, u64, u16, void* userdata) {
    if (auto* emulator = Prk63Emulator(userdata))
      emulator->prk63MpTxCallsCount.fetch_add(1, std::memory_order_relaxed);
    Prk65ObserveTx(data, len, userdata, 2);
    return 0;
  }`,
`  int MP_SendReply(u8* data, int len, u64 timestamp, u16, void* userdata) {
    if (auto* emulator = Prk63Emulator(userdata)) {
      emulator->prk63MpTxCallsCount.fetch_add(1, std::memory_order_relaxed);
      Prk65ObserveTx(data, len, userdata, 2);
      return emulator->prk66QueueTx(data, len, timestamp) ? len : 0;
    }
    return 0;
  }`,
    ],
    [
`  int MP_SendAck(u8* data, int len, u64, void* userdata) {
    if (auto* emulator = Prk63Emulator(userdata))
      emulator->prk63MpTxCallsCount.fetch_add(1, std::memory_order_relaxed);
    Prk65ObserveTx(data, len, userdata, 3);
    return 0;
  }`,
`  int MP_SendAck(u8* data, int len, u64 timestamp, void* userdata) {
    if (auto* emulator = Prk63Emulator(userdata)) {
      emulator->prk63MpTxCallsCount.fetch_add(1, std::memory_order_relaxed);
      Prk65ObserveTx(data, len, userdata, 3);
      return emulator->prk66QueueTx(data, len, timestamp) ? len : 0;
    }
    return 0;
  }`,
    ],
    [
`  int MP_RecvPacket(u8*, u64*, void* userdata) {
    if (auto* emulator = Prk63Emulator(userdata))
      emulator->prk63MpRxPollsCount.fetch_add(1, std::memory_order_relaxed);
    return 0;
  }`,
`  int MP_RecvPacket(u8* bytes, u64* timestamp, void* userdata) {
    if (auto* emulator = Prk63Emulator(userdata)) {
      emulator->prk63MpRxPollsCount.fetch_add(1, std::memory_order_relaxed);
      return emulator->prk66ReadRx(bytes, timestamp);
    }
    return 0;
  }`,
    ],
    [
`  int MP_RecvHostPacket(u8*, u64*, void* userdata) {
    if (auto* emulator = Prk63Emulator(userdata))
      emulator->prk63MpHostRxPollsCount.fetch_add(1, std::memory_order_relaxed);
    return 0;
  }`,
`  int MP_RecvHostPacket(u8* bytes, u64* timestamp, void* userdata) {
    if (auto* emulator = Prk63Emulator(userdata)) {
      emulator->prk63MpHostRxPollsCount.fetch_add(1, std::memory_order_relaxed);
      return emulator->prk66ReadRx(bytes, timestamp);
    }
    return 0;
  }`,
    ],
  ]
  for (const [before, after] of conversions) replaceUnique(platform, before, after)
  replaceUnique(cpp, 'return 0x50524B3E;', 'return 0x50524B3F;')
  console.log('[PokéRun] PRK66 opt-in two-DS radio queues installed; disabled by default, no save or remote transport.')
}
