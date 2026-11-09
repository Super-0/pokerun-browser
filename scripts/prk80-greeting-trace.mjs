import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Bounded native observation. Keep all branches and values that drive the radio intact.
export function applyPrk80GreetingTrace(source) {
  const root = resolve(source, 'wasmelonDS/src/frontend/wasm')
  const edit = (file, before, after) => {
    const path = resolve(root, file)
    const contents = readFileSync(path, 'utf8')
    if (contents.split(before).length !== 2) throw new Error(`Greeting trace source mismatch in ${file}: ${before}`)
    writeFileSync(path, contents.replace(before, after))
  }
  const header = 'WasmEmulator.h'
  const cpp = 'WasmEmulator.cpp'
  const platform = 'WasmPlatform.cpp'
  edit(header, '#include <emscripten/bind.h>', '#include <emscripten/bind.h>\n#include <array>')
  edit(header, '    std::deque<Prk79Reply> prk79RxReplies;', `    std::deque<Prk79Reply> prk79RxReplies;

    // The lock is shared with the radio queues. No payload or player identity is recorded.
    struct GreetingEvent {
      unsigned kind;
      double monotonicMs, dsUs, replyUs, sequence;
      unsigned aidOrMask, poll;
    };
    std::array<GreetingEvent, 1024> greetingEvents{};
    std::atomic<bool> greetingEnabled{false};
    unsigned greetingSize = 0, greetingDropped = 0;
    unsigned greetingTxId = 0, greetingCommandId = 0;
    void recordGreetingLocked(unsigned kind, melonDS::u64 dsUs, melonDS::u64 replyUs = 0,
                              double sequence = 0, unsigned aidOrMask = 0, unsigned poll = 0) {
      if (!greetingEnabled.load(std::memory_order_relaxed)) return;
      if (greetingSize == greetingEvents.size()) { ++greetingDropped; return; }
      greetingEvents[greetingSize++] = {kind, emscripten_get_now(), double(dsUs),
                                        double(replyUs), sequence, aidOrMask, poll};
    }
  public:
    unsigned recordGreetingTx(unsigned kind, melonDS::u64 timestamp, unsigned aid = 0) {
      if (!greetingEnabled.load(std::memory_order_relaxed)) return 0;
      std::lock_guard<std::mutex> guard(prk66Mutex);
      if (!greetingEnabled.load(std::memory_order_relaxed)) return 0;
      const auto id = ++greetingTxId;
      if (kind == 1) greetingCommandId = id;
      recordGreetingLocked(kind, timestamp, 0, id, aid);
      return id;
    }
    void setGreetingTrace(bool enabled) {
      std::lock_guard<std::mutex> guard(prk66Mutex);
      greetingSize = greetingDropped = greetingTxId = greetingCommandId = 0;
      greetingEnabled.store(enabled, std::memory_order_relaxed);
    }
    emscripten::val drainGreetingTrace();
`)
  edit(header, '      melonDS::u16 replyAid = 0;\n    };', '      melonDS::u16 replyAid = 0;\n      unsigned traceTxId = 0;\n    };')
  edit(header, 'int length, melonDS::u64 timestamp) {', 'int length, melonDS::u64 timestamp, unsigned traceTxId = 0) {')
  edit(header, 'bytes + length), timestamp});', 'bytes + length), timestamp, 0, traceTxId});')
  edit(header, 'melonDS::u64 timestamp, melonDS::u16 aid) {', 'melonDS::u64 timestamp, melonDS::u16 aid, unsigned traceTxId) {')
  edit(header, 'std::move(payload), timestamp, aid});', 'std::move(payload), timestamp, aid, traceTxId});')
  edit(cpp, '    packet.set("replyAid", static_cast<unsigned>(frame.replyAid));', `    packet.set("replyAid", static_cast<unsigned>(frame.replyAid));
    if (frame.traceTxId) packet.set("traceTxId", frame.traceTxId);`)
  edit(header, '      melonDS::u16 aid = 0;\n    };', '      melonDS::u16 aid = 0;\n      double traceSequence = 0;\n    };')
  edit(header, '    bool prk79InjectReply(emscripten::val bytes, double timestamp, int aid);', '    bool prk79InjectReply(emscripten::val bytes, double timestamp, int aid, double traceSequence);')
  edit(header, '      const bool hadPending = !prk79RxReplies.empty();', `      const bool hadPending = !prk79RxReplies.empty();
      const auto poll = greetingEnabled.load(std::memory_order_relaxed)
        ? prk79HostPollCount.load(std::memory_order_relaxed) : 0;
      recordGreetingLocked(hadPending ? 4 : 3, cmdTimestamp, 0, greetingCommandId, aidmask, poll);`)
  edit(header, '          it = prk79RxReplies.erase(it);\n          prk79StaleCount', `          recordGreetingLocked(5, cmdTimestamp, it->timestamp, it->traceSequence, it->aid, poll);
          it = prk79RxReplies.erase(it);
          prk79StaleCount`)
  edit(header, '        if (!(aidmask & (1u << it->aid))) { ++it; continue; }', `        if (!(aidmask & (1u << it->aid))) {
          recordGreetingLocked(6, cmdTimestamp, it->timestamp, it->traceSequence, it->aid, poll);
          ++it;
          continue;
        }`)
  edit(header, '          std::copy(it->bytes.begin(), it->bytes.end(),', `          recordGreetingLocked(7, cmdTimestamp, it->timestamp, it->traceSequence, it->aid, poll);
          std::copy(it->bytes.begin(), it->bytes.end(),`)
  edit(header, '          prk79EmptyCount.fetch_add(1, std::memory_order_relaxed);\n        }', `          recordGreetingLocked(8, cmdTimestamp, it->timestamp, it->traceSequence, it->aid, poll);
          prk79EmptyCount.fetch_add(1, std::memory_order_relaxed);
        } else {
          recordGreetingLocked(9, cmdTimestamp, it->timestamp, it->traceSequence, it->aid, poll);
        }`)
  edit(cpp, 'double timestamp, int aid) {', 'double timestamp, int aid, double traceSequence) {')
  edit(cpp, 'static_cast<melonDS::u16>(aid)});', `static_cast<melonDS::u16>(aid), traceSequence});
    recordGreetingLocked(10, static_cast<melonDS::u64>(timestamp), 0, traceSequence, aid);`)
  edit(cpp, '  bool WasmEmulator::prk79InjectReply(', `  emscripten::val WasmEmulator::drainGreetingTrace() {
    using emscripten::val;
    auto result = val::object();
    auto values = val::array();
    {
      std::lock_guard<std::mutex> guard(prk66Mutex);
      result.set("dropped", greetingDropped);
      result.set("nativeNowMs", emscripten_get_now());
      for (unsigned i = 0; i < greetingSize; ++i) {
        const auto& event = greetingEvents[i];
        const auto base = i * 7;
        values.set(base, event.kind);
        values.set(base + 1, event.monotonicMs);
        values.set(base + 2, event.dsUs);
        values.set(base + 3, event.replyUs);
        values.set(base + 4, event.sequence);
        values.set(base + 5, event.aidOrMask);
        values.set(base + 6, event.poll);
      }
      greetingSize = greetingDropped = 0;
    }
    result.set("values", values);
    return result;
  }

  bool WasmEmulator::prk79InjectReply(`)
  edit(cpp, '    .function("prk79InjectReply",', `    .function("setGreetingTrace", &wasmelon::WasmEmulator::setGreetingTrace)
    .function("drainGreetingTrace", &wasmelon::WasmEmulator::drainGreetingTrace)
    .function("prk79InjectReply",`)
  edit(cpp, 'return 0x50524B46;', 'return 0x50524B47;')
  edit(platform, `      Prk65ObserveTx(data, len, userdata, 1);
      return emulator->prk66QueueTx(data, len, timestamp) ? len : 0;`, `      const auto traceId = emulator->recordGreetingTx(1, timestamp);
      Prk65ObserveTx(data, len, userdata, 1);
      return emulator->prk66QueueTx(data, len, timestamp, traceId) ? len : 0;`)
  edit(platform, `      Prk65ObserveTx(data, len, userdata, 2);
      return emulator->prk79QueueReplyTx(data, len, timestamp, aid) ? len : 0;`, `      const auto traceId = emulator->recordGreetingTx(2, timestamp, aid);
      Prk65ObserveTx(data, len, userdata, 2);
      return emulator->prk79QueueReplyTx(data, len, timestamp, aid, traceId) ? len : 0;`)
}
