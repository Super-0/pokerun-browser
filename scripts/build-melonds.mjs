import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { applyPrk66LocalRadioBridge } from './prk66-wireless-patch.mjs'
import { applyPrk67NativeRxAudit } from './prk67-native-rx-audit.mjs'
import { applyPrk69ChannelAudit } from './prk69-native-channel-audit.mjs'
import { applyPrk70ReceiveDeliveryAudit } from './prk70-native-delivery-audit.mjs'
import { applyPrk71FirmwareMacIdentity } from './prk71-firmware-mac-identity.mjs'
import { applyPrk72HandshakeStageAudit } from './prk72-handshake-stage-audit.mjs'
import { applyPrk79NativeMpReplies } from './prk79-native-mp-replies.mjs'
import { applyPrk80MpTimingAudit } from './prk80-mp-timing-audit.mjs'
import { applyPrk81AsyncifyProbe } from './prk81-asyncify-probe.mjs'
import { applyPrk81WorkerCallbacks } from './prk81-worker-callbacks.mjs'
import { applyPrk81fNativeMailbox } from './prk81f-native-mailbox.mjs'
import { applyPrk81gPlatformMailboxes } from './prk81g-platform-mailboxes.mjs'
import { applyPrk81hNativePeer } from './prk81h-native-peer.mjs'

const root = resolve(new URL('..', import.meta.url).pathname)
const source = resolve(root, 'third_party/ds-anywhere')
const patches = [
  resolve(root, 'third_party/patches/0001-expose-arm9-bus-reads.patch'),
  resolve(root, 'third_party/patches/0002-real-hidden-fast-forward-frames.patch'),
  resolve(root, 'third_party/patches/0003-raise-arm9-native-call-budget.patch'),
  resolve(root, 'third_party/patches/0004-scheduler-aware-arm9-native-calls.patch'),
  resolve(root, 'third_party/patches/0005-atomic-arm9-stack-args.patch'),
  resolve(root, 'third_party/patches/0006-scheduler-aware-arm9-stack-args.patch'),
  resolve(root, 'third_party/patches/0007-isolate-arm9-injected-stack.patch'),
]
const build = resolve(source, 'build-pokerun-wasm')
const output = resolve(root, 'public/emulators/melonds')
const expectedRevision = '53c7c6cb362560a9e362ae754a162f638fa3cd64'
const requiredRuntimeSymbols = [
  'writeArm9U8', 'writeArm9U16', 'writeArm9U32',
  'getArm9Sp', 'callArm9Thumb4', 'callArm9Thumb8Atomic', 'arm9CallStatus',
  'arm9CallPc', 'arm9CallLr', 'arm9CallCpsr', 'arm9CallInstructions',
  'arm9CallBudget', 'pokerunRuntimeVersion',
  'prk63WifiStarts', 'prk63WifiStops', 'prk63MpTxCalls',
  'prk63MpRxPolls', 'prk63MpHostRxPolls', 'prk63NetTxCalls',
  'prk65TxMgmt', 'prk65TxControl', 'prk65TxData', 'prk65TxInvalid', 'prk65TxBeacon', 'prk65TxProbe', 'prk65TxCommand', 'prk65TxReply', 'prk65TxAck',
  'prk66SetEnabled', 'prk66TakeOutgoing', 'prk66InjectIncoming',
  'prk66TxQueued', 'prk66RxQueued', 'prk66RxConsumed', 'prk66FramesDropped',
  'prk67RxAccepted', 'prk67RxBadLength', 'prk67RxBadChannel',
  'prk67RxMpFiltered', 'prk67RxBeacon', 'prk67RxAssocAccepted',
  'prk69TxChannel', 'prk69AcceptedChannel', 'prk69WrongChannel',
  'prk69TunedChannel', 'prk69CurrentChannel', 'prk69ChannelChanges',
  'prk70BeaconSameMac', 'prk70BeaconDifferentMac', 'prk70NativeRxFinished',
  'prk70DestFiltered', 'prk70WepFiltered', 'prk70BeaconBssidMatched',
  'prk70BeaconFilterDropped', 'prk70RxRingIrq',
  'prk71SetFirmwareMacRole', 'prk71AppliedFirmwareMacRole',
  'prk72TxKind', 'prk72RxKind',
  'prk79InjectReply', 'prk79ReplyTx', 'prk79ReplyRx', 'prk79HostPoll',
  'prk79HostMatch', 'prk79Stale', 'prk79Empty',
  'prk80EmptyPoll', 'prk80MissPoll', 'prk80PendingMiss', 'prk80FutureMatch', 'prk80AckFail', 'prk80AckOk',
  'prk81AsyncifyProbe', 'prk81fMailboxPtr', 'prk81fWaitForReply',
  'prk81gTxPtr', 'prk81gRxPtr', 'prk81gEnable', 'prk81gTestPlatformRoundTrip',
  'prk81gMatched', 'prk81gRejected', 'prk81gTimedOut', 'prk81gDropped',
  'prk81hPeerReplyFromQueue',
]

function run(command, args, cwd = root) { execFileSync(command, args, { cwd, stdio: 'inherit' }) }
function containsAscii(buffer, text) { return buffer.indexOf(Buffer.from(text, 'utf8')) !== -1 }

// The historical 0006/0007 unified diffs were written with inaccurate hunk
// headers; git apply rejects them even after --recount. Apply ONLY these known
// C++ hunks by exact, unique old-context matches instead. Never do a fuzzy
// replacement: changing source upstream must stop the build.
function applyExactWasmCppPatch(patchPath) {
  const cppPath = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.cpp')
  const targetHeader = 'diff --git a/wasmelonDS/src/frontend/wasm/WasmEmulator.cpp b/wasmelonDS/src/frontend/wasm/WasmEmulator.cpp'
  const lines = readFileSync(patchPath, 'utf8').split(/\r?\n/)
  const hunks = []
  let target = false
  let current = null

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (line !== targetHeader) throw new Error(`Unexpected file in ${patchPath}: ${line}`)
      target = true
      current = null
    } else if (target && line.startsWith('@@ ')) {
      current = { header: line, operations: [] }
      hunks.push(current)
    } else if (target && current && /^[ +\-]/.test(line)) {
      current.operations.push(line)
    } else if (target && current && line.startsWith('\\ No newline')) {
      throw new Error(`Unsupported non-terminated patch hunk in ${patchPath}`)
    }
  }

  const expectedHunks = patchPath.includes('0006-') ? 6 : 3
  if (hunks.length !== expectedHunks) {
    throw new Error(`Expected ${expectedHunks} validated C++ hunks in ${patchPath}, got ${hunks.length}`)
  }

  const sourceLines = readFileSync(cppPath, 'utf8').split('\n')
  for (const hunk of hunks) {
    const before = hunk.operations.filter(op => op[0] !== '+').map(op => op.slice(1))
    const after = hunk.operations.filter(op => op[0] !== '-').map(op => op.slice(1))
    if (!before.length) throw new Error(`Refusing insertion-only hunk in ${patchPath}: ${hunk.header}`)
    const hits = []
    for (let offset = 0; offset <= sourceLines.length - before.length; offset += 1) {
      if (sourceLines[offset] === before[0] && before.every((line, idx) => sourceLines[offset + idx] === line)) {
        hits.push(offset)
      }
    }
    if (hits.length !== 1) {
      throw new Error(`Patch ${patchPath} ${hunk.header} matched ${hits.length} locations (expected exactly one)`)
    }
    sourceLines.splice(hits[0], before.length, ...after)
  }

  writeFileSync(cppPath, sourceLines.join('\n'))
  console.log(`[PokéRun] Strictly applied ${hunks.length} C++ hunks from ${patchPath}`)
}


function applyPrk63WirelessTelemetry() {
  // Strict pinned-source transformations: fail on any unexpected upstream changes.
  const platform = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmPlatform.cpp')
  const header = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.h')
  const cpp = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.cpp')
  function replaceUnique(path, before, after) {
    const original = readFileSync(path, 'utf8')
    const pieces = original.split(before)
    if (pieces.length !== 2) {
      throw new Error('PRK63 telemetry source context mismatch in ' + path + ': ' + (pieces.length - 1) + ' matches.')
    }
    writeFileSync(path, pieces.join(after))
  }

  replaceUnique(header, '#include <emscripten/bind.h>', '#include <emscripten/bind.h>\n#include <atomic>')
  replaceUnique(header, "    std::string savePath;\n", "    std::string savePath;\n    // Per-emulator counters: Wi-Fi callbacks can run on an emulation worker.\n    std::atomic<melonDS::u32> prk63WifiStartsCount{0};\n    std::atomic<melonDS::u32> prk63WifiStopsCount{0};\n    std::atomic<melonDS::u32> prk63MpTxCallsCount{0};\n    std::atomic<melonDS::u32> prk63MpRxPollsCount{0};\n    std::atomic<melonDS::u32> prk63MpHostRxPollsCount{0};\n    std::atomic<melonDS::u32> prk63NetTxCallsCount{0};\n\n    melonDS::u32 prk63WifiStarts() const { return prk63WifiStartsCount.load(std::memory_order_relaxed); }\n    melonDS::u32 prk63WifiStops() const { return prk63WifiStopsCount.load(std::memory_order_relaxed); }\n    melonDS::u32 prk63MpTxCalls() const { return prk63MpTxCallsCount.load(std::memory_order_relaxed); }\n    melonDS::u32 prk63MpRxPolls() const { return prk63MpRxPollsCount.load(std::memory_order_relaxed); }\n    melonDS::u32 prk63MpHostRxPolls() const { return prk63MpHostRxPollsCount.load(std::memory_order_relaxed); }\n    melonDS::u32 prk63NetTxCalls() const { return prk63NetTxCallsCount.load(std::memory_order_relaxed); }\n")
  replaceUnique(platform, "  // Local Multiplayer (DS Download Play)\n  void MP_Begin(void* userdata) { }\n  void MP_End(void* userdata) { }\n  int MP_SendPacket(u8* data, int len, u64 timestamp, void* userdata) { }\n  int MP_RecvPacket(u8* data, u64* timestamp, void* userdata) { }\n  int MP_SendCmd(u8* data, int len, u64 timestamp, void* userdata) { }\n  int MP_SendReply(u8* data, int len, u64 timestamp, u16 aid, void* userdata) { }\n  int MP_SendAck(u8* data, int len, u64 timestamp, void* userdata) { }\n  int MP_RecvHostPacket(u8* data, u64* timestamp, void* userdata) { }\n  u16 MP_RecvReplies(u8* data, u64 timestamp, u16 aidmask, void* userdata) { }\n\n  // NetPlay interface (going to likely remain unimplemented)\n  int Net_SendPacket(u8* data, int len, void* userdata) { }\n  int Net_RecvPacket(u8* data, void* userdata) { }", "  // PRK63: count wireless activity without delivering or collecting any packets.\n  // The old empty non-void stubs had undefined returns; 0 means no packet.\n  static wasmelon::WasmEmulator* Prk63Emulator(void* userdata) {\n    return static_cast<wasmelon::WasmEmulator*>(userdata);\n  }\n  void MP_Begin(void* userdata) {\n    if (auto* emulator = Prk63Emulator(userdata))\n      emulator->prk63WifiStartsCount.fetch_add(1, std::memory_order_relaxed);\n  }\n  void MP_End(void* userdata) {\n    if (auto* emulator = Prk63Emulator(userdata))\n      emulator->prk63WifiStopsCount.fetch_add(1, std::memory_order_relaxed);\n  }\n  int MP_SendPacket(u8*, int, u64, void* userdata) {\n    if (auto* emulator = Prk63Emulator(userdata))\n      emulator->prk63MpTxCallsCount.fetch_add(1, std::memory_order_relaxed);\n    return 0;\n  }\n  int MP_RecvPacket(u8*, u64*, void* userdata) {\n    if (auto* emulator = Prk63Emulator(userdata))\n      emulator->prk63MpRxPollsCount.fetch_add(1, std::memory_order_relaxed);\n    return 0;\n  }\n  int MP_SendCmd(u8*, int, u64, void* userdata) {\n    if (auto* emulator = Prk63Emulator(userdata))\n      emulator->prk63MpTxCallsCount.fetch_add(1, std::memory_order_relaxed);\n    return 0;\n  }\n  int MP_SendReply(u8*, int, u64, u16, void* userdata) {\n    if (auto* emulator = Prk63Emulator(userdata))\n      emulator->prk63MpTxCallsCount.fetch_add(1, std::memory_order_relaxed);\n    return 0;\n  }\n  int MP_SendAck(u8*, int, u64, void* userdata) {\n    if (auto* emulator = Prk63Emulator(userdata))\n      emulator->prk63MpTxCallsCount.fetch_add(1, std::memory_order_relaxed);\n    return 0;\n  }\n  int MP_RecvHostPacket(u8*, u64*, void* userdata) {\n    if (auto* emulator = Prk63Emulator(userdata))\n      emulator->prk63MpHostRxPollsCount.fetch_add(1, std::memory_order_relaxed);\n    return 0;\n  }\n  u16 MP_RecvReplies(u8*, u64, u16, void* userdata) {\n    if (auto* emulator = Prk63Emulator(userdata))\n      emulator->prk63MpHostRxPollsCount.fetch_add(1, std::memory_order_relaxed);\n    return 0;\n  }\n  int Net_SendPacket(u8*, int, void* userdata) {\n    if (auto* emulator = Prk63Emulator(userdata))\n      emulator->prk63NetTxCallsCount.fetch_add(1, std::memory_order_relaxed);\n    return 0;\n  }\n  int Net_RecvPacket(u8*, void*) { return 0; }")
  replaceUnique(cpp, "    .function(\"getCartTitle\", &wasmelon::WasmEmulator::getCartTitle)", "    .function(\"getCartTitle\", &wasmelon::WasmEmulator::getCartTitle)\n    .function(\"prk63WifiStarts\", &wasmelon::WasmEmulator::prk63WifiStarts)\n    .function(\"prk63WifiStops\", &wasmelon::WasmEmulator::prk63WifiStops)\n    .function(\"prk63MpTxCalls\", &wasmelon::WasmEmulator::prk63MpTxCalls)\n    .function(\"prk63MpRxPolls\", &wasmelon::WasmEmulator::prk63MpRxPolls)\n    .function(\"prk63MpHostRxPolls\", &wasmelon::WasmEmulator::prk63MpHostRxPolls)\n    .function(\"prk63NetTxCalls\", &wasmelon::WasmEmulator::prk63NetTxCalls)")
  replaceUnique(cpp, 'return 0x50524B3C;', 'return 0x50524B3D;')
  console.log('[PokéRun] PRK63 counters installed on pinned native Wi-Fi stubs; packet routing disabled.')
}


// PRK65 classification is applied AFTER the existing PRK63 counter patch so
// packet kind stats never modify the behavior that has already been verified.
function applyPrk65WifiFrameClasses() {
  const platform = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmPlatform.cpp')
  const header = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.h')
  const cpp = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.cpp')
  function replaceUnique(path, before, after) {
    const contents = readFileSync(path, 'utf8')
    const parts = contents.split(before)
    if (parts.length !== 2) {
      throw new Error('PRK65 pinned source mismatch in ' + path + ': ' + (parts.length - 1) + ' matches.')
    }
    writeFileSync(path, parts.join(after))
  }
  replaceUnique(header,
    "    std::atomic<melonDS::u32> prk63NetTxCallsCount{0};",
    "    std::atomic<melonDS::u32> prk63NetTxCallsCount{0};\n    std::atomic<melonDS::u32> prk65TxMgmtCount{0};\n    std::atomic<melonDS::u32> prk65TxControlCount{0};\n    std::atomic<melonDS::u32> prk65TxDataCount{0};\n    std::atomic<melonDS::u32> prk65TxInvalidCount{0};\n    std::atomic<melonDS::u32> prk65TxBeaconCount{0};\n    std::atomic<melonDS::u32> prk65TxProbeCount{0};\n    std::atomic<melonDS::u32> prk65TxCommandCount{0};\n    std::atomic<melonDS::u32> prk65TxReplyCount{0};\n    std::atomic<melonDS::u32> prk65TxAckCount{0};")
  replaceUnique(header,
    "    melonDS::u32 prk63NetTxCalls() const { return prk63NetTxCallsCount.load(std::memory_order_relaxed); }",
    "    melonDS::u32 prk63NetTxCalls() const { return prk63NetTxCallsCount.load(std::memory_order_relaxed); }\n    melonDS::u32 prk65TxMgmt() const { return prk65TxMgmtCount.load(std::memory_order_relaxed); }\n    melonDS::u32 prk65TxControl() const { return prk65TxControlCount.load(std::memory_order_relaxed); }\n    melonDS::u32 prk65TxData() const { return prk65TxDataCount.load(std::memory_order_relaxed); }\n    melonDS::u32 prk65TxInvalid() const { return prk65TxInvalidCount.load(std::memory_order_relaxed); }\n    melonDS::u32 prk65TxBeacon() const { return prk65TxBeaconCount.load(std::memory_order_relaxed); }\n    melonDS::u32 prk65TxProbe() const { return prk65TxProbeCount.load(std::memory_order_relaxed); }\n    melonDS::u32 prk65TxCommand() const { return prk65TxCommandCount.load(std::memory_order_relaxed); }\n    melonDS::u32 prk65TxReply() const { return prk65TxReplyCount.load(std::memory_order_relaxed); }\n    melonDS::u32 prk65TxAck() const { return prk65TxAckCount.load(std::memory_order_relaxed); }")
  replaceUnique(platform,
    "  int MP_SendPacket(u8*, int, u64, void* userdata) {",
    "  // PRK65: read only the 802.11 frame-control bytes at host-TX offset 12.\n  // No frame bytes leave WASM; no MAC, payload, Pokémon or trainer IDs logged.\n  // The 12-byte melonDS radio header precedes the 802.11 frame. Guard both.\n  static void Prk65ObserveTx(u8* data, int len, void* userdata, int kind) {\n    auto* emulator = Prk63Emulator(userdata);\n    if (!emulator) return;\n    if (kind == 1) emulator->prk65TxCommandCount.fetch_add(1, std::memory_order_relaxed);\n    if (kind == 2) emulator->prk65TxReplyCount.fetch_add(1, std::memory_order_relaxed);\n    if (kind == 3) emulator->prk65TxAckCount.fetch_add(1, std::memory_order_relaxed);\n    if (!data || len < 14 || len > 0x2000) {\n      emulator->prk65TxInvalidCount.fetch_add(1, std::memory_order_relaxed);\n      return;\n    }\n    const u8 frameControl = data[12];\n    const u8 frameType = (frameControl >> 2) & 3;\n    const u8 subtype = (frameControl >> 4) & 15;\n    switch (frameType) {\n      case 0:\n        emulator->prk65TxMgmtCount.fetch_add(1, std::memory_order_relaxed);\n        if (subtype == 8) emulator->prk65TxBeaconCount.fetch_add(1, std::memory_order_relaxed);\n        if (subtype == 4 || subtype == 5)\n          emulator->prk65TxProbeCount.fetch_add(1, std::memory_order_relaxed);\n        break;\n      case 1:\n        emulator->prk65TxControlCount.fetch_add(1, std::memory_order_relaxed);\n        break;\n      case 2:\n        emulator->prk65TxDataCount.fetch_add(1, std::memory_order_relaxed);\n        break;\n      default:\n        emulator->prk65TxInvalidCount.fetch_add(1, std::memory_order_relaxed);\n        break;\n    }\n  }\n  int MP_SendPacket(u8*, int, u64, void* userdata) {")
  replaceUnique(platform, "  int MP_SendPacket(u8*, int, u64, void* userdata) {\n    if (auto* emulator = Prk63Emulator(userdata))\n      emulator->prk63MpTxCallsCount.fetch_add(1, std::memory_order_relaxed);\n    return 0;\n  }", "  int MP_SendPacket(u8* data, int len, u64, void* userdata) {\n    if (auto* emulator = Prk63Emulator(userdata))\n      emulator->prk63MpTxCallsCount.fetch_add(1, std::memory_order_relaxed);\n    Prk65ObserveTx(data, len, userdata, 0);\n    return 0;\n  }")
  replaceUnique(platform, "  int MP_SendCmd(u8*, int, u64, void* userdata) {\n    if (auto* emulator = Prk63Emulator(userdata))\n      emulator->prk63MpTxCallsCount.fetch_add(1, std::memory_order_relaxed);\n    return 0;\n  }", "  int MP_SendCmd(u8* data, int len, u64, void* userdata) {\n    if (auto* emulator = Prk63Emulator(userdata))\n      emulator->prk63MpTxCallsCount.fetch_add(1, std::memory_order_relaxed);\n    Prk65ObserveTx(data, len, userdata, 1);\n    return 0;\n  }")
  replaceUnique(platform, "  int MP_SendReply(u8*, int, u64, u16, void* userdata) {\n    if (auto* emulator = Prk63Emulator(userdata))\n      emulator->prk63MpTxCallsCount.fetch_add(1, std::memory_order_relaxed);\n    return 0;\n  }", "  int MP_SendReply(u8* data, int len, u64, u16, void* userdata) {\n    if (auto* emulator = Prk63Emulator(userdata))\n      emulator->prk63MpTxCallsCount.fetch_add(1, std::memory_order_relaxed);\n    Prk65ObserveTx(data, len, userdata, 2);\n    return 0;\n  }")
  replaceUnique(platform, "  int MP_SendAck(u8*, int, u64, void* userdata) {\n    if (auto* emulator = Prk63Emulator(userdata))\n      emulator->prk63MpTxCallsCount.fetch_add(1, std::memory_order_relaxed);\n    return 0;\n  }", "  int MP_SendAck(u8* data, int len, u64, void* userdata) {\n    if (auto* emulator = Prk63Emulator(userdata))\n      emulator->prk63MpTxCallsCount.fetch_add(1, std::memory_order_relaxed);\n    Prk65ObserveTx(data, len, userdata, 3);\n    return 0;\n  }")
  replaceUnique(cpp,
    "    .function(\"prk63NetTxCalls\", &wasmelon::WasmEmulator::prk63NetTxCalls)",
    "    .function(\"prk63NetTxCalls\", &wasmelon::WasmEmulator::prk63NetTxCalls)\n    .function(\"prk65TxMgmt\", &wasmelon::WasmEmulator::prk65TxMgmt)\n    .function(\"prk65TxControl\", &wasmelon::WasmEmulator::prk65TxControl)\n    .function(\"prk65TxData\", &wasmelon::WasmEmulator::prk65TxData)\n    .function(\"prk65TxInvalid\", &wasmelon::WasmEmulator::prk65TxInvalid)\n    .function(\"prk65TxBeacon\", &wasmelon::WasmEmulator::prk65TxBeacon)\n    .function(\"prk65TxProbe\", &wasmelon::WasmEmulator::prk65TxProbe)\n    .function(\"prk65TxCommand\", &wasmelon::WasmEmulator::prk65TxCommand)\n    .function(\"prk65TxReply\", &wasmelon::WasmEmulator::prk65TxReply)\n    .function(\"prk65TxAck\", &wasmelon::WasmEmulator::prk65TxAck)")
  replaceUnique(cpp, 'return 0x50524B3D;', 'return 0x50524B3E;')
  console.log('[PokéRun] PRK65 privacy-safe 802.11 frame-class telemetry installed (packet routing still disabled).')
}

function restorePinnedSource() {
  try {
    execFileSync('git', ['reset', '--hard', expectedRevision], { cwd: source, stdio: 'inherit' })
  } catch (error) {
    console.warn('[PokéRun] Could not restore the pinned ds-anywhere source after the build.', error)
  }
  rmSync(build, { recursive: true, force: true })
}

if (!existsSync(resolve(source, '.git'))) throw new Error('Missing third_party/ds-anywhere. Run: git submodule update --init --recursive')
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
if (revision !== expectedRevision) throw new Error(`DS Anywhere must be pinned to ${expectedRevision}; found ${revision}.`)

let published = false
try {
  // PokéRun-owned patches can change while the pinned upstream revision stays fixed.
  // Always restore tracked upstream files first so an older applied patch cannot block a newer one.
  run('git', ['reset', '--hard', expectedRevision], source)
  // Git applies 0001-0005 as usual. Historical 0006/0007 headers are rejected
  // by git apply even with --recount; match their C++ contents exactly instead.
  for (const patch of patches.slice(0, 5)) {
    run('git', ['apply', '--recount', '--check', patch], source)
    run('git', ['apply', '--recount', patch], source)
  }
  for (const patch of patches.slice(5)) applyExactWasmCppPatch(patch)
  applyPrk63WirelessTelemetry()
  applyPrk65WifiFrameClasses()
  applyPrk66LocalRadioBridge(source)
  applyPrk67NativeRxAudit(source)
  applyPrk69ChannelAudit(source)
  applyPrk70ReceiveDeliveryAudit(source)
  applyPrk71FirmwareMacIdentity(source)
  applyPrk72HandshakeStageAudit(source)
  applyPrk79NativeMpReplies(source)
  applyPrk80MpTimingAudit(source)
  applyPrk81AsyncifyProbe(source)
  applyPrk81WorkerCallbacks(source)
  applyPrk81fNativeMailbox(source)
  applyPrk81gPlatformMailboxes(source)
  applyPrk81hNativePeer(source)

  // Apply build requirements after restoring and patching upstream.
  const wasmCmake = resolve(source, 'wasmelonDS/src/frontend/wasm/CMakeLists.txt')
  writeFileSync(wasmCmake, readFileSync(wasmCmake, 'utf8') +
    '\ntarget_compile_features(wasmemulator PRIVATE cxx_std_20)\n' +
    // PRK81A is isolated to its own branch: transform only for a capability test.
    'set_property(TARGET wasmemulator APPEND_STRING PROPERTY LINK_FLAGS " -sASYNCIFY -sASYNCIFY_STACK_SIZE=65536")\n')

  const patchedCpp = readFileSync(resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.cpp'), 'utf8')
  for (const symbol of requiredRuntimeSymbols) {
    if (!patchedCpp.includes(`.function("${symbol}"`)) throw new Error(`PokéRun melonDS patch did not expose ${symbol} through Embind.`)
  }
  if (!patchedCpp.includes('arm.PokerunInstructionLimit = 1000000;')) {
    throw new Error('PokéRun melonDS patch did not install the 1,000,000-instruction ARM9 native-call budget.')
  }
  if (!patchedCpp.includes('nds->RunFrame();')) {
    throw new Error('PokéRun melonDS patch did not retain scheduler-aware ARM9 native calls.')
  }
  if (!patchedCpp.includes('u32 WasmEmulator::callArm9Thumb8Atomic')) {
    throw new Error('PokéRun melonDS patch did not install the stack-argument ARM9 bridge.')
  }
  if (!patchedCpp.includes('PRK11 scheduler-aware stack-argument bridge')) {
    throw new Error('PokéRun stack-argument bridge is not scheduler-aware PRK11.')
  }
  if (!patchedCpp.includes('const u32 injectedSp = originalSp - (stackReserve >> 2);') ||
      !patchedCpp.includes('arm.R[13] = injectedSp;')) {
    throw new Error('PokéRun melonDS patch did not isolate the injected stack arguments.')
  }
  if (!patchedCpp.includes('return 0x50524B4B;')) {
    throw new Error('PokéRun melonDS patch did not install the PRK81H runtime stamp.')
  }

  // Rebuild from scratch, but keep the last served runtime in place until the new
  // JS/WASM pair has compiled and passed export verification. A compiler failure
  // should not turn into a confusing browser-side 404 on the next launch.
  rmSync(build, { recursive: true, force: true })
  run('emcmake', ['cmake', '-S', 'wasmelonDS', '-B', build, '-DBUILD_QT_SDL=OFF', '-DENABLE_OGLRENDERER=OFF', '-DENABLE_GDBSTUB=OFF',
    '-DCMAKE_C_FLAGS=-pthread',
    '-DCMAKE_CXX_FLAGS=-pthread',
    '-DCMAKE_EXE_LINKER_FLAGS=-pthread'], source)
  run('cmake', ['--build', build, '--target', 'wasmemulator', '-j2'], source)

  const builtJsPath = resolve(build, 'wasmemulator.js')
  const builtWasmPath = resolve(build, 'wasmemulator.wasm')
  const builtJs = readFileSync(builtJsPath)
  const builtWasm = readFileSync(builtWasmPath)
  for (const symbol of requiredRuntimeSymbols) {
    if (!containsAscii(builtJs, symbol) && !containsAscii(builtWasm, symbol)) {
      throw new Error(`Built melonDS runtime is missing required PokéRun export ${symbol}; refusing to publish stale WASM.`)
    }
  }

  // Publish only after the candidate runtime is known-good so wasmemulator.js and
  // wasmemulator.wasm are always replaced as a verified pair.
  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
  copyFileSync(builtJsPath, resolve(output, 'wasmemulator.js'))
  copyFileSync(builtWasmPath, resolve(output, 'wasmemulator.wasm'))
  published = true
} finally {
  // ds-anywhere is a pinned third-party source tree. The patches above are the
  // canonical PokéRun changes, so never leave generated or applied build state
  // behind in the submodule after a build attempt.
  restorePinnedSource()
}

if (published) {
  console.log(`Built verified melonDS runtime into public/emulators/melonds/ with exports: ${requiredRuntimeSymbols.join(', ')}.`)
}
