import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// This optional native build observes execution of verified White 2 ARM9
// functions. It does not install breakpoints, patch ROM instructions, or call game functions.
export function applyGflCallbackTrace(source) {
  const root = resolve(source, 'wasmelonDS/src')
  function edit(file, before, after) {
    const path = resolve(root, file)
    const contents = readFileSync(path, 'utf8')
    if (contents.split(before).length !== 2) throw new Error(`GFL trace source mismatch in ${file}: ${before}`)
    writeFileSync(path, contents.replace(before, after))
  }
  edit('frontend/wasm/WasmEmulator.h', '    double recordPrk80Hardware(', `    bool isGreetingTraceEnabled() const {
      return greetingEnabled.load(std::memory_order_relaxed);
    }
    double recordPrk80Hardware(`)
  edit('frontend/wasm/WasmPlatform.cpp', '  double PokerunPrk80Hardware(', `  bool PokerunPrk80TraceGflEnabled(void* userdata) {
    auto* emulator = Prk63Emulator(userdata);
    return emulator && emulator->isGreetingTraceEnabled();
  }
  double PokerunPrk80Hardware(`)
  edit('ARM.h', '    u32 Num;', `    u32 Num;
    u32 PokerunGflReturn = 0;
    u32 PokerunGflReceive = 0;
    u32 PokerunGflNetId = 0;
    u32 PokerunWmReturn = 0;
    u32 PokerunWmOutput = 0;`)
  edit('ARM.cpp', 'void ARMv5::JumpTo(u32 addr, bool restorecpsr)\n{', `namespace Platform {
  bool PokerunPrk80TraceGflEnabled(void* userdata);
  double PokerunPrk80Hardware(void* userdata, unsigned kind, u64 timestamp, double id, u64 detail, unsigned flags);
}

void ARMv5::JumpTo(u32 addr, bool restorecpsr)
{
    const auto target = addr & ~1u;
    constexpr u32 wmFifo = 0x02080B2C;
    constexpr u32 wmStep = 0x02081E1C;
    constexpr u32 wmParent = 0x020820F0;
    constexpr u32 wmChild = 0x020821B4;
    if ((PokerunGflReturn && target == PokerunGflReturn) ||
        (PokerunWmReturn && target == PokerunWmReturn) ||
        (target >= 0x0203F81C && target <= 0x020424D8) ||
        target == wmFifo || target == wmStep || target == wmParent || target == wmChild)
    {
        constexpr u32 recvChild = 0x0203F81C;
        constexpr u32 recvParent = 0x0203F924;
        constexpr u32 sendNegotiation = 0x02040530;
        constexpr u32 recvNegotiation = 0x020408AC;
        constexpr u32 recvNegotiationReply = 0x02040988;
        constexpr u32 recordNetError = 0x020424D8;
        if (PokerunGflReturn && target == PokerunGflReturn)
        {
            Platform::PokerunPrk80Hardware(NDS.UserData, 20, 0, PokerunGflReceive, R[0] != 0, PokerunGflNetId);
            PokerunGflReturn = PokerunGflReceive = PokerunGflNetId = 0;
        }
        if (PokerunWmReturn && target == PokerunWmReturn)
        {
            const auto ptr = PokerunWmOutput;
            const unsigned received = R[0] == 0 && ptr >= 0x02000000 && ptr <= 0x02FFFFFC
              ? NDS.ARM9Read16(ptr + 2) : 0;
            Platform::PokerunPrk80Hardware(NDS.UserData, 19, 0, wmStep, R[0] & 0xFFFF, received);
            PokerunWmReturn = PokerunWmOutput = 0;
        }
        switch (target)
        {
        case wmFifo:
            if (!R[2] && Platform::PokerunPrk80TraceGflEnabled(NDS.UserData))
            {
                const auto ptr = R[1];
                if (ptr >= 0x02000000 && ptr <= 0x02FFFFF6)
                {
                    const unsigned api = NDS.ARM9Read16(ptr);
                    if (api == 0xE || api == 0x81 || api == 0x82)
                    {
                        const unsigned error = NDS.ARM9Read16(ptr + 2);
                        const unsigned state = NDS.ARM9Read16(ptr + (api == 0x81 ? 8 : 4));
                        Platform::PokerunPrk80Hardware(NDS.UserData, 19, 0, wmFifo,
                            api, (state & 255) | ((error & 255) << 8));
                    }
                }
            }
            break;
        case wmStep:
            if (Platform::PokerunPrk80TraceGflEnabled(NDS.UserData))
            {
                PokerunWmReturn = R[14] & ~1u;
                PokerunWmOutput = R[2];
            }
            break;
        case wmParent:
        case wmChild:
            if (Platform::PokerunPrk80TraceGflEnabled(NDS.UserData))
            {
                const auto ptr = R[0];
                if (ptr >= 0x02000000 && ptr <= 0x02FFFFEC)
                {
                    const unsigned state = NDS.ARM9Read16(ptr + 4);
                    const unsigned error = NDS.ARM9Read16(ptr + 2);
                    const unsigned aid = NDS.ARM9Read16(ptr + 0x12);
                    const unsigned length = NDS.ARM9Read16(ptr + 0x10);
                    Platform::PokerunPrk80Hardware(NDS.UserData, 19, 0, target,
                        length, (aid & 15) | ((state & 255) << 4) | ((error & 255) << 12));
                }
            }
            break;
        case recvChild:
        case recvParent:
            if (Platform::PokerunPrk80TraceGflEnabled(NDS.UserData))
            {
                const auto ptr = R[1], size = R[2];
                const unsigned packetKind = ptr >= 0x02000000 && ptr <= 0x02FFFFFB && size >= 7 && size <= 2048
                  ? (NDS.ARM9Read8(ptr + 4) == 0xFF ? 1 : 2) : 0;
                PokerunGflReturn = R[14] & ~1u;
                PokerunGflReceive = target;
                PokerunGflNetId = R[0] & 0xFF;
                Platform::PokerunPrk80Hardware(NDS.UserData, 19, 0, target, size & 0xFFFF,
                    PokerunGflNetId | (packetKind << 8));
            }
            break;
        case recvNegotiation:
        case recvNegotiationReply:
            Platform::PokerunPrk80Hardware(NDS.UserData, 19, 0, target, R[1] & 0xFFFF, R[0] & 0xFF);
            break;
        case sendNegotiation:
            Platform::PokerunPrk80Hardware(NDS.UserData, 19, 0, target, 0, 0);
            break;
        case recordNetError:
            Platform::PokerunPrk80Hardware(NDS.UserData, 19, 0, target, R[3] & 0xFFFF, 0);
            break;
        }
    }`)
}
