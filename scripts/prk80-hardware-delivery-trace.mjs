import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Observe only register metadata and queue IDs. This patch does not read
// packet contents beyond frame-control/length and sequence-control fields.
export function applyHardwareDeliveryTrace(source) {
  const root = resolve(source, 'wasmelonDS/src')
  function edit(file, before, after) {
    const path = resolve(root, file)
    const contents = readFileSync(path, 'utf8')
    if (contents.split(before).length !== 2) throw new Error(`Hardware delivery trace source mismatch in ${file}: ${before}`)
    writeFileSync(path, contents.replace(before, after))
  }
  const header = 'frontend/wasm/WasmEmulator.h'
  edit(header, '    unsigned greetingTxId = 0, greetingCommandId = 0;', `    unsigned greetingTxId = 0, greetingCommandId = 0;
    std::array<double, 16> greetingReplyIds{};
    double recordPrk80Hardware(unsigned kind, melonDS::u64 timestamp, double id,
                               melonDS::u64 detail, unsigned flags) {
      if (!greetingEnabled.load(std::memory_order_relaxed)) return 0;
      std::lock_guard<std::mutex> guard(prk66Mutex);
      if (kind == 11) id = greetingReplyIds[static_cast<unsigned>(id) & 15];
      recordGreetingLocked(kind, timestamp, detail, id, flags,
                           prk79HostPollCount.load(std::memory_order_relaxed));
      return id;
    }`)
  edit(header, '      recordGreetingLocked(hadPending ? 4 : 3, cmdTimestamp, 0, greetingCommandId, aidmask, poll);', `      if (greetingEnabled.load(std::memory_order_relaxed)) greetingReplyIds.fill(0);
      recordGreetingLocked(hadPending ? 4 : 3, cmdTimestamp, 0, greetingCommandId, aidmask, poll);`)
  edit(header, '          recordGreetingLocked(7, cmdTimestamp, it->timestamp, it->traceSequence, it->aid, poll);', `          if (greetingEnabled.load(std::memory_order_relaxed)) greetingReplyIds[it->aid] = it->traceSequence;
          recordGreetingLocked(7, cmdTimestamp, it->timestamp, it->traceSequence, it->aid, poll);`)
  edit('frontend/wasm/WasmPlatform.cpp', '  void PokerunPrk80RecordAck(', `  double PokerunPrk80Hardware(void* userdata, unsigned kind, u64 timestamp, double id, u64 detail, unsigned flags) {
    auto* emulator = Prk63Emulator(userdata);
    return emulator ? emulator->recordPrk80Hardware(kind, timestamp, id, detail, flags) : 0;
  }
  void PokerunPrk80RecordAck(`)
  edit('Wifi.h', '    int MPReplyTimer;', '    int MPReplyTimer;\n    double PokerunTraceReplyId = 0;')
  edit('Wifi.cpp', '  void PokerunPrk80RecordAck(void* userdata, unsigned clientFail);', `  void PokerunPrk80RecordAck(void* userdata, unsigned clientFail);
  double PokerunPrk80Hardware(void* userdata, unsigned kind, u64 timestamp, double id, u64 detail, unsigned flags);`)
  edit('Wifi.cpp', '    MPReplyTimer = 0;', '    MPReplyTimer = 0;\n    PokerunTraceReplyId = 0;')
  edit('Wifi.cpp', '    Platform::PokerunPrk80RecordAck(NDS.UserData, clientfail);', `    Platform::PokerunPrk80RecordAck(NDS.UserData, clientfail);
    Platform::PokerunPrk80Hardware(NDS.UserData, 17, USTimestamp, IOPORT(W_TXSeqNo), CmdCounter, clientfail);`)
  edit('Wifi.cpp', 'void Wifi::MPClientReplyRX(int client)\n{', `void Wifi::MPClientReplyRX(int client)
{
    const unsigned blocked = ((IOPORT(W_PowerState) & (1<<9)) ? 1u : 0u) |
      ((IOPORT(W_RXCnt) & 0x8000) ? 0u : 2u) |
      ((IOPORT(W_RXBufBegin) == IOPORT(W_RXBufEnd)) ? 4u : 0u);
    const auto traceReplyId = Platform::PokerunPrk80Hardware(NDS.UserData, 11, USTimestamp, client, client, blocked);`)
  edit('Wifi.cpp', '    RXTimestamp = 0;\n    StartRX();\n}\n\nbool Wifi::CheckRX', `    RXTimestamp = 0;
    StartRX();
    PokerunTraceReplyId = traceReplyId;
    if (traceReplyId)
        Platform::PokerunPrk80Hardware(NDS.UserData, 12, USTimestamp, traceReplyId, framelen, framectl);
}

bool Wifi::CheckRX`)
  edit('Wifi.cpp', 'void Wifi::StartRX()\n{', `void Wifi::StartRX()
{
    PokerunTraceReplyId = 0;`)
  edit('Wifi.cpp', 'void Wifi::FinishRX()\n{', `void Wifi::FinishRX()
{
    const auto traceReplyId = PokerunTraceReplyId;
    PokerunTraceReplyId = 0;
    if (traceReplyId)
        Platform::PokerunPrk80Hardware(NDS.UserData, 13, USTimestamp, traceReplyId, *(u16*)&RXBuffer[8], *(u16*)&RXBuffer[12]);`)
  edit('Wifi.cpp', '        u16 headeraddr = IOPORT(W_RXBufWriteCursor) << 1;', `        const auto oldWriteCursor = IOPORT(W_RXBufWriteCursor);
        u16 headeraddr = oldWriteCursor << 1;`)
  edit('Wifi.cpp', '        SetIRQ(0);', `        SetIRQ(0);
        if (traceReplyId || (rxflags & 0x800F) == 0x800D)
        {
            const auto span = u32(oldWriteCursor) | (u32(IOPORT(W_RXBufWriteCursor)) << 16);
            Platform::PokerunPrk80Hardware(NDS.UserData, traceReplyId ? 14 : 18, USTimestamp,
                traceReplyId ? traceReplyId : (seqno >> 4), span, rxflags);
        }`)
  edit('Wifi.cpp', '                // TODO: proper error management\n                if ((!ComStatus)', `                if (PokerunTraceReplyId)
                    Platform::PokerunPrk80Hardware(NDS.UserData, 15, USTimestamp, PokerunTraceReplyId, 0, 0);
                PokerunTraceReplyId = 0;
                // TODO: proper error management
                if ((!ComStatus)`)
  edit('Wifi.cpp', '    case W_RXBufReadCursor:\n        val &= 0x0FFF;', `        val &= 0x0FFF;
        break;
    case W_RXBufReadCursor:
        val &= 0x0FFF;
        if (val != IOPORT(W_RXBufReadCursor))
            Platform::PokerunPrk80Hardware(NDS.UserData, 16, USTimestamp, 0,
                u32(IOPORT(W_RXBufReadCursor)) | (u32(val) << 16), IOPORT(W_RXBufWriteCursor));`)
}
