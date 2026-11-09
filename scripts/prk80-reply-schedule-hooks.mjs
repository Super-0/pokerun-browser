import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Included only in an explicit test build. Drive the actual platform entry
// points without a cartridge, Wi-Fi guest, browser timers, or live game state.
export function applyReplyScheduleTestHooks(source) {
  const cpp = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.cpp')
  const original = readFileSync(cpp, 'utf8')
  const binding = '    .function("prk79InjectReply",'
  const entry = '  WasmEmulator::WasmEmulator() {'
  for (const anchor of [entry, binding]) {
    if (original.split(anchor).length !== 2) throw new Error(`Native schedule test hook source mismatch: ${anchor}`)
  }

  writeFileSync(cpp, original.replace(entry, `  static int testSendMpCommand(WasmEmulator& emulator, unsigned timestamp) {
    std::array<u8, 36> command{};
    command[10] = command.size() - 12;
    return Platform::MP_SendCmd(command.data(), command.size(), timestamp, &emulator);
  }

  static unsigned testPollMpReplies(WasmEmulator& emulator, unsigned timestamp, unsigned aidMask) {
    std::array<u8, 15 * 1024> replies{};
    return Platform::MP_RecvReplies(replies.data(), timestamp, static_cast<u16>(aidMask), &emulator);
  }

${entry}`).replace(binding, `    .function("pokerunTestSendMpCommand", &wasmelon::testSendMpCommand)
    .function("pokerunTestPollMpReplies", &wasmelon::testPollMpReplies)
${binding}`))
}
