import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Opt-in frame pthread. The browser continues to relay the same validated
// packets while the emulated CPUs wait at real MP receive boundaries.
export function applyWorkerRadio(source) {
  const root = resolve(source, 'wasmelonDS/src')
  function edit(file, before, after) {
    const path = resolve(root, file)
    const contents = readFileSync(path, 'utf8')
    if (contents.split(before).length !== 2) throw new Error(`Worker radio source mismatch in ${file}: ${before}`)
    writeFileSync(path, contents.replace(before, after))
  }
  const header = 'frontend/wasm/WasmEmulator.h'
  const cpp = 'frontend/wasm/WasmEmulator.cpp'
  const platform = 'frontend/wasm/WasmPlatform.cpp'
  edit(header, '#include <mutex>', '#include <mutex>\n#include <condition_variable>\n#include <thread>\n#include <emscripten/threading.h>')
  edit(header, '    std::mutex prk66Mutex;', `    std::mutex prk66Mutex;
    std::condition_variable pokerunRadioReady;
    std::mutex pokerunFrameMutex;
    std::condition_variable pokerunFrameReady;
    std::thread pokerunFrameThread;
    struct WorkerFrameInput {
      melonDS::u32 buttons;
      bool lid, touching;
      melonDS::u16 x, y;
    } pokerunFrame{};
    bool pokerunFrameStopping = false;
    std::atomic<bool> pokerunFrameBusy{false};
    std::atomic<bool> pokerunRadioWaiting{false};
    bool pokerunStartFrame();
    void pokerunStopFrames();
    void pokerunNotifyRadio();
    bool pokerunFramePending() const { return pokerunFrameBusy.load(std::memory_order_acquire); }
    void pokerunSetRadioWaiting(bool enabled) {
      std::lock_guard<std::mutex> lock(prk66Mutex);
      pokerunRadioWaiting.store(enabled, std::memory_order_relaxed);
      pokerunRadioReady.notify_all();
    }
    void pokerunWaitForRadio(bool reply, melonDS::u64 timestamp = 0, melonDS::u16 mask = 0) {
      if ((reply && !mask) || !pokerunRadioWaiting.load(std::memory_order_relaxed) ||
          emscripten_is_main_runtime_thread()) return;
      std::unique_lock<std::mutex> lock(prk66Mutex);
      pokerunRadioReady.wait_for(lock, std::chrono::milliseconds(24), [&] {
        if (!pokerunRadioWaiting.load(std::memory_order_relaxed) ||
            !prk66Enabled.load(std::memory_order_relaxed)) return true;
        if (!reply) return std::any_of(prk66RxQueue.begin(), prk66RxQueue.end(), [](const auto& frame) {
          return frame.bytes.size() >= 36 && (frame.bytes[12] & 0xFC) == 0x18 &&
            frame.bytes[16] == 3 && frame.bytes[17] == 9 && frame.bytes[18] == 0xBF &&
            frame.bytes[19] == 0 && frame.bytes[20] == 0 && frame.bytes[21] == 3;
        });
        return std::any_of(prk79RxReplies.begin(), prk79RxReplies.end(), [&](const auto& item) {
          return (mask & (1u << item.aid)) &&
            (item.timestamp >= timestamp || timestamp - item.timestamp <= 32);
        });
      });
    }`)
  edit(header, '      prk66Enabled.store(enabled, std::memory_order_release);', `      prk66Enabled.store(enabled, std::memory_order_release);
      pokerunRadioReady.notify_all();`)
  edit(cpp, '    delete nds;', `    pokerunStopFrames();
    delete emuThread;
    delete nds;`)
  edit(cpp, '  void WasmEmulator::processFrame(bool ghostFrame) {', `  bool WasmEmulator::pokerunStartFrame() {
    if (pokerunFramePending()) return false;
    if (!pokerunFrameThread.joinable()) {
      pokerunFrameThread = std::thread([this] {
        std::unique_lock<std::mutex> lock(pokerunFrameMutex);
        while (true) {
          pokerunFrameReady.wait(lock, [&] { return pokerunFrameStopping || pokerunFramePending(); });
          if (pokerunFrameStopping) break;
          const auto frame = pokerunFrame;
          lock.unlock();
          const double started = emscripten_get_now();
          setDateTime();
          emuThread->nextFrame({frame.buttons, frame.lid, frame.touching, frame.x, frame.y, false});
          lock.lock();
          pokerunFrameBusy.store(false, std::memory_order_release);
          MAIN_THREAD_ASYNC_EM_ASM(window.WebMelon._internal.events.onWorkerFrame?.($0),
                                  emscripten_get_now() - started);
        }
      });
    }
    std::lock_guard<std::mutex> lock(pokerunFrameMutex);
    pokerunFrame = {buttonInput, lidClosed, isTouching, isTouching ? touchX : melonDS::u16(0),
                    isTouching ? touchY : melonDS::u16(0)};
    pokerunFrameBusy.store(true, std::memory_order_release);
    pokerunFrameReady.notify_one();
    return true;
  }

  void WasmEmulator::pokerunStopFrames() {
    if (!pokerunFrameThread.joinable()) return;
    pokerunSetRadioWaiting(false);
    {
      std::lock_guard<std::mutex> lock(pokerunFrameMutex);
      pokerunFrameStopping = true;
      pokerunFrameReady.notify_one();
    }
    pokerunFrameThread.join();
  }

  void WasmEmulator::pokerunNotifyRadio() {
    if (!pokerunRadioWaiting.load(std::memory_order_relaxed)) return;
    MAIN_THREAD_ASYNC_EM_ASM(window.WebMelon._internal.events.onRadioOutput?.());
  }

  void WasmEmulator::processFrame(bool ghostFrame) {`)
  edit(cpp, '    EM_ASM(\n      window.WebMelon._internal.events.onSaveWrite();', '    MAIN_THREAD_ASYNC_EM_ASM(\n      window.WebMelon._internal.events.onSaveWrite();')
  for (const event of ['RumbleStart', 'RumbleStop', 'Shutdown']) {
    edit(cpp, `EM_ASM(window.WebMelon._internal.events.on${event}());`, `MAIN_THREAD_ASYNC_EM_ASM(window.WebMelon._internal.events.on${event}());`)
  }
  edit(cpp, '  void WasmEmulator::updateWebFrame() {', `  void WasmEmulator::updateWebFrame() {
    if (!emscripten_is_main_runtime_thread()) return;`)
  for (const count of ['prk66RxQueuedCount', 'prk79ReplyRxCount']) {
    const line = `    ${count}.fetch_add(1, std::memory_order_relaxed);`
    edit(cpp, line, `${line}\n    pokerunRadioReady.notify_one();`)
  }
  edit(cpp, '    .function("processFrame", &wasmelon::WasmEmulator::processFrame)', `    .function("processFrame", &wasmelon::WasmEmulator::processFrame)
    .function("pokerunStartFrame", &wasmelon::WasmEmulator::pokerunStartFrame)
    .function("pokerunFramePending", &wasmelon::WasmEmulator::pokerunFramePending)
    .function("pokerunSetRadioWaiting", &wasmelon::WasmEmulator::pokerunSetRadioWaiting)`)
  edit(platform, '      return emulator->prk79ReadReplies(replies, timestamp, aidmask);', `      emulator->pokerunWaitForRadio(true, timestamp, aidmask);
      return emulator->prk79ReadReplies(replies, timestamp, aidmask);`)
  edit(platform, '  int MP_RecvHostPacket(', `  void PokerunWaitForGuestAck(void* userdata) {
    if (auto* emulator = Prk63Emulator(userdata)) emulator->pokerunWaitForRadio(false);
  }
  int MP_RecvHostPacket(`)
  for (const [queue, args] of [['prk66QueueTx', 'data, len, timestamp, traceId'], ['prk79QueueReplyTx', 'data, len, timestamp, aid, traceId']]) {
    const call = `emulator->${queue}(${args})`
    edit(platform, `      return ${call} ? len : 0;`, `      if (!${call}) return 0;
      emulator->pokerunNotifyRadio();
      return len;`)
  }
  edit(platform, '      Prk65ObserveTx(data, len, userdata, 3);\n      return emulator->prk66QueueTx(data, len, timestamp) ? len : 0;', `      Prk65ObserveTx(data, len, userdata, 3);
      if (!emulator->prk66QueueTx(data, len, timestamp)) return 0;
      emulator->pokerunNotifyRadio();
      return len;`)
  edit('Wifi.h', '    int MPReplyTimer;', '    int MPReplyTimer;\n    bool PokerunAwaitGuestAck = false;')
  edit('Wifi.cpp', '  unsigned PokerunPrk80DeferHostPoll(void* userdata);', '  unsigned PokerunPrk80DeferHostPoll(void* userdata);\n  void PokerunWaitForGuestAck(void* userdata);')
  edit('Wifi.cpp', '    MPReplyTimer = 0;', '    MPReplyTimer = 0;\n    PokerunAwaitGuestAck = false;')
  edit('Wifi.cpp', '    IOPORT(W_TXBusy) |= 0x0080;', '    IOPORT(W_TXBusy) |= 0x0080;\n    PokerunAwaitGuestAck = true;')
  edit('Wifi.cpp', '            CheckRX(2);', `            if (PokerunAwaitGuestAck)
            {
                PokerunAwaitGuestAck = false;
                Platform::PokerunWaitForGuestAck(NDS.UserData);
            }
            CheckRX(2);`)
}
