import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function applyDeferredReplyPoll(source) {
  const root = resolve(source, 'wasmelonDS/src')
  function edit(file, before, after) {
    const path = resolve(root, file)
    const contents = readFileSync(path, 'utf8')
    if (contents.split(before).length !== 2) throw new Error(`Deferred reply poll source mismatch in ${file}: ${before}`)
    writeFileSync(path, contents.replace(before, after))
  }
  const frontend = 'frontend/wasm/'
  edit(frontend + 'WasmEmulator.h', '    std::atomic<bool> prk66Enabled{false};', `    std::atomic<bool> prk66Enabled{false};
    unsigned prk80HostPollMode = 0;
    void setPrk80DeferHostPoll(unsigned mode) { prk80HostPollMode = mode <= 3 ? mode : 0; }
    unsigned deferredPrk80HostPollMode() const {
      return prk66Enabled.load(std::memory_order_acquire) ? prk80HostPollMode : 0;
    }`)
  edit(frontend + 'WasmEmulator.h', '    bool prk79InjectReply(', `    bool prk80HasReply(melonDS::u64 timestamp, melonDS::u16 aidmask) {
      std::lock_guard<std::mutex> guard(prk66Mutex);
      return std::any_of(prk79RxReplies.begin(), prk79RxReplies.end(), [&](const auto& reply) {
        return (aidmask & (1u << reply.aid)) && !reply.bytes.empty() &&
          (reply.timestamp >= timestamp || timestamp - reply.timestamp <= 32);
      });
    }
    bool prk79InjectReply(`)
  edit(frontend + 'WasmEmulator.cpp', '    .function("setGreetingTrace",', `    .function("setPrk80DeferHostPoll", &wasmelon::WasmEmulator::setPrk80DeferHostPoll)
    .function("setGreetingTrace",`)
  edit(frontend + 'WasmEmulator.cpp', 'return 0x50524B47;', 'return 0x50524B4A;')
  edit(frontend + 'WasmPlatform.cpp', '  void PokerunPrk80RecordAck(', `  unsigned PokerunPrk80DeferHostPoll(void* userdata) {
    auto* emulator = Prk63Emulator(userdata);
    return emulator ? emulator->deferredPrk80HostPollMode() : 0;
  }
  bool PokerunPrk80HasReply(void* userdata, u64 timestamp, u16 mask) {
    auto* emulator = Prk63Emulator(userdata);
    return emulator && emulator->prk80HasReply(timestamp, mask);
  }
  void PokerunPrk80RecordAck(`)
  edit('Wifi.h', '    int MPReplyTimer;', '    int MPReplyTimer;\n    u64 PokerunReplyPollTimestamp = 0;\n    int PokerunReplyWaitRemaining = 0;\n    bool PokerunPreserveCmdCounter = false;')
  edit('Wifi.cpp', '  void PokerunPrk80RecordAck(void* userdata, unsigned clientFail);', `  void PokerunPrk80RecordAck(void* userdata, unsigned clientFail);
  unsigned PokerunPrk80DeferHostPoll(void* userdata);
  bool PokerunPrk80HasReply(void* userdata, u64 timestamp, u16 mask);`)
  edit('Wifi.cpp', '    MPReplyTimer = 0;', '    MPReplyTimer = 0;\n    PokerunReplyPollTimestamp = 0;\n    PokerunReplyWaitRemaining = 0;\n    PokerunPreserveCmdCounter = false;')
  edit('Wifi.cpp', '    case 1: // transmit done\n        {', `    case 15: // PokéRun adaptive browser delivery window
        {
            constexpr int probeInterval = 1024;
            const int mode = Platform::PokerunPrk80DeferHostPoll(NDS.UserData);
            if (mode >= 2 && PokerunReplyWaitRemaining > 0 &&
                !Platform::PokerunPrk80HasReply(NDS.UserData, PokerunReplyPollTimestamp, MPClientMask))
            {
                slot->CurPhaseTime = std::min(probeInterval, PokerunReplyWaitRemaining);
                PokerunReplyWaitRemaining -= slot->CurPhaseTime;
                break;
            }
        }
        [[fallthrough]];
    case 14: // PokéRun browser delivery window, then resume normal TX completion
    case 1: // transmit done
        {
            if (num == 1 && slot->CurPhase == 1 && MPClientMask)
            {
                const auto mode = Platform::PokerunPrk80DeferHostPoll(NDS.UserData);
                if (mode)
                {
                    // Preserve the original timestamp for the stale rule.
                    PokerunReplyPollTimestamp = USTimestamp;
                    slot->CurPhase = mode >= 2 ? 15 : 14;
                    slot->CurPhaseTime = mode >= 2 ? 1024 : 32000;
                    PokerunReplyWaitRemaining = mode >= 2 ? 48000 - 1024 : 0;
                    PokerunPreserveCmdCounter = mode == 3;
                    break;
                }
            }`)
  edit('Wifi.cpp', '    if (IOPORT(W_CmdCountCnt) & 0x0001)', `    // The opt-in browser wait is outside the DS command's normal RF window.
    const bool holdCmdCounter = PokerunPreserveCmdCounter && (ComStatus & 2) &&
                                TXCurSlot == 1 && TXSlots[1].CurPhase == 15;
    if ((IOPORT(W_CmdCountCnt) & 0x0001) && !holdCmdCounter)`)
  edit('Wifi.cpp', '                    res = Platform::MP_RecvReplies(MPClientReplies, USTimestamp, MPClientMask, NDS.UserData);', `                    res = Platform::MP_RecvReplies(MPClientReplies,
                        slot->CurPhase == 1 ? USTimestamp : PokerunReplyPollTimestamp,
                        MPClientMask, NDS.UserData);`)
}
