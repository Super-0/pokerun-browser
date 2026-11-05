import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * PRK71 — distinct, per-emulator DEV firmware MAC identities.
 *
 * Instead of rewriting packets or poking live DS registers, change a freshly
 * generated in-memory firmware header before melonDS installs that firmware.
 * The firmware's Wi-Fi checksum is recalculated. Never mutate stored firmware,
 * ROMs, battery saves, or non-opted-in single-player instances.
 */
export function applyPrk71FirmwareMacIdentity(source) {
  const header = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.h')
  const cpp = resolve(source, 'wasmelonDS/src/frontend/wasm/WasmEmulator.cpp')
  function replaceUnique(path, before, after) {
    const original = readFileSync(path, 'utf8')
    const count = original.split(before).length - 1
    if (count !== 1) throw new Error('PRK71 pinned source mismatch in ' + path + ': ' + count)
    writeFileSync(path, original.replace(before, after))
  }

  replaceUnique(header,
    '    melonDS::u32 prk70RxRingIrq() const { return prk70RxRingIrqCount.load(std::memory_order_relaxed); }',
    `    melonDS::u32 prk70RxRingIrq() const { return prk70RxRingIrqCount.load(std::memory_order_relaxed); }

    // Roles 1 and 2 are assigned ONLY by the real-two-player DEV launcher
    // before loadFreeBIOS. Role 0 retains exact legacy firmware behavior.
    int prk71FirmwareMacRole = 0;
    bool prk71FirmwareGenerated = false;
    bool prk71SetFirmwareMacRole(int role) {
      if (prk71FirmwareGenerated || (role != 1 && role != 2)) return false;
      prk71FirmwareMacRole = role;
      return true;
    }
    int prk71AppliedFirmwareMacRole() const {
      return prk71FirmwareGenerated ? prk71FirmwareMacRole : 0;
    }`)

  replaceUnique(cpp,
    `  Firmware WasmEmulator::genFirmware() {
    return firmwareSettings.toFirmware();
  }`,
    `  Firmware WasmEmulator::genFirmware() {
    Firmware generated = firmwareSettings.toFirmware();
    // Distinct, valid unicast locally administered 802.11 MACs for the two
    // independent test emulators, not derived from save or trainer details.
    // The first 3 bytes are a locally-administered prefix; the last byte
    // encodes only the development role (1 or 2).
    if (prk71FirmwareMacRole == 1 || prk71FirmwareMacRole == 2) {
      auto& mac = generated.GetHeader().MacAddr;
      mac[0] = 0x02;
      mac[1] = 0x09;
      mac[2] = 0xBF;
      mac[3] = 0x71;
      mac[4] = 0x00;
      mac[5] = static_cast<melonDS::u8>(prk71FirmwareMacRole);
      generated.UpdateChecksums();
    }
    prk71FirmwareGenerated = true;
    return generated;
  }`)

  replaceUnique(cpp,
    '    .function("prk70RxRingIrq", &wasmelon::WasmEmulator::prk70RxRingIrq)',
    `    .function("prk70RxRingIrq", &wasmelon::WasmEmulator::prk70RxRingIrq)
    .function("prk71SetFirmwareMacRole", &wasmelon::WasmEmulator::prk71SetFirmwareMacRole)
    .function("prk71AppliedFirmwareMacRole", &wasmelon::WasmEmulator::prk71AppliedFirmwareMacRole)`)

  replaceUnique(cpp, 'return 0x50524B42;', 'return 0x50524B43;')
  console.log('[PokéRun] PRK71 independent DEV firmware MAC roles installed; battery saves unchanged.')
}
