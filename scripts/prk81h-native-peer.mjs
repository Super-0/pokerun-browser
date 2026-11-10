import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// PRK81H: test-only response derived from a real Platform::MP_RecvHostPacket.
// Forwarded through a second independent WASM instance's MP_SendReply.
export function applyPrk81hNativePeer(source) {
  const header = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.h')
  const cpp = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.cpp')
  const r = (path,before,after) => {
    const text = readFileSync(path,'utf8')
    const count = text.split(before).length - 1
    if(count!==1)throw Error('PRK81H pinned-source mismatch '+path+' '+count)
    writeFileSync(path,text.replace(before,after))
  }
  r(header,
"    int prk81gTestPlatformRoundTrip(int);",
"    int prk81gTestPlatformRoundTrip(int);\n    int prk81hPeerReplyFromQueue();")
  r(cpp,
"  void WasmEmulator::setBatteryLevels() {",
"  // PRK81H controlled test peer: real Platform receive then send callbacks.\n  // This is a test reply derived from a received command, NOT an in-game\n  // response from a second running Nintendo DS.\n  int WasmEmulator::prk81hPeerReplyFromQueue() {\n    if (!prk66Enabled.load(std::memory_order_acquire)) return -1;\n    melonDS::u8 incoming[2048] = {};\n    melonDS::u64 receivedAt = 0;\n    const int length = melonDS::Platform::MP_RecvHostPacket(\n        incoming, &receivedAt, this);\n    if (length < 36 || length > 1024 ||\n        (incoming[10] | (static_cast<unsigned>(incoming[11]) << 8)) !=\n            static_cast<unsigned>(length-12))\n      return -2;\n    // Mark the test response as peer-produced; preserve the native command\n    // sequence marker at [14] for the host callback's existing check.\n    incoming[15] = 0xA7;\n    const int sent = melonDS::Platform::MP_SendReply(\n        incoming, length, receivedAt, 1, this);\n    return sent == length ? sent : -3;\n  }\n\n  void WasmEmulator::setBatteryLevels() {")
  r(cpp,
"    .function(\"prk81gDropped\", &wasmelon::WasmEmulator::prk81gDropped)",
"    .function(\"prk81gDropped\", &wasmelon::WasmEmulator::prk81gDropped)\n    .function(\"prk81hPeerReplyFromQueue\", &wasmelon::WasmEmulator::prk81hPeerReplyFromQueue)")
  r(cpp, 'return 0x50524B4A;', 'return 0x50524B4B;')
  console.log('[PokéRun] PRK81H test peer receive/reply callback installed')
}
