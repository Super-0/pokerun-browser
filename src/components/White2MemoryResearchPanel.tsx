import { useEffect } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2ActorSystemProbe } from '../multiplayer/games/White2ActorSystem'
import { POKERUN_NATIVE_TEST_UID } from '../multiplayer/games/White2NativeActor'

// White 2 US symbols from the pokebw2 reconstruction.
// These live in field overlay 36, the same overlay that contains the normal
// overworld Field implementation. Probe 5 verifies they are actually resident
// during PokéRun's ordinary map-427 test before we ever attempt to use them.
const FIELD_GET_ACTOR_SYSTEM = 0x021804f8
const FLD_COMM_ACT_SYS_CREATE = 0x0218ae78
const FLD_COMM_ACT_SYS_CREATE_ACTOR = 0x0218aef4
const FIELD_COMM_ACTOR_ADD = 0x0218affc
const FIELD_COMM_ACTOR_MOVE_INIT = 0x0218b084
const FIELD_COMM_ACTOR_MOVE_DELETE = 0x0218b090
const FIELD_COMM_ACTOR_MOVE = 0x0218b0a0
const FIELD_COMM_ACTOR_SET_MOVE_WORK = 0x0218b150
const FIELD_COMM_ACTOR_CONVERT_DIR = 0x0218b168
const MOVE_CODE_COMM_ACTOR_TABLE = 0x021cc418
const MOVE_CODE_COMM_ACTOR = 0x44

const POLL_MS = 150
const STABLE_MS = 700
const FUNCTION_HEAD_BYTES = 16
const MOVE_CODE_TABLE_BYTES = 20

function hex(value: number) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

function bytesHex(bytes: Uint8Array) {
  return [...bytes].map(value => value.toString(16).toUpperCase().padStart(2, '0')).join(' ')
}

function looksResident(bytes: Uint8Array) {
  if (bytes.length === 0) return false
  const allZero = bytes.every(value => value === 0)
  const allFF = bytes.every(value => value === 0xff)
  return !allZero && !allFF
}

async function captureFunction(bridge: MelonDsBridge, name: string, address: number) {
  const bytes = await bridge.readBytes(address, FUNCTION_HEAD_BYTES)
  return {
    name,
    address: hex(address),
    thumbEntry: hex(address | 1),
    resident: looksResident(bytes),
    head: bytesHex(bytes),
  }
}

async function captureNativeCommResidency(bridge: MelonDsBridge) {
  const functions = await Promise.all([
    captureFunction(bridge, 'Field_GetActorSystem', FIELD_GET_ACTOR_SYSTEM),
    captureFunction(bridge, 'FldCommActSys_Create', FLD_COMM_ACT_SYS_CREATE),
    captureFunction(bridge, 'FldCommActSys_CreateActor', FLD_COMM_ACT_SYS_CREATE_ACTOR),
    captureFunction(bridge, 'FieldCommActor_Add', FIELD_COMM_ACTOR_ADD),
    captureFunction(bridge, 'FieldCommActor_MoveInit', FIELD_COMM_ACTOR_MOVE_INIT),
    captureFunction(bridge, 'FieldCommActor_MoveDelete', FIELD_COMM_ACTOR_MOVE_DELETE),
    captureFunction(bridge, 'FieldCommActor_Move', FIELD_COMM_ACTOR_MOVE),
    captureFunction(bridge, 'FieldCommActor_SetMoveWork', FIELD_COMM_ACTOR_SET_MOVE_WORK),
    captureFunction(bridge, 'FieldCommActor_ConvertDir', FIELD_COMM_ACTOR_CONVERT_DIR),
  ])

  const tableBytes = await bridge.readBytes(MOVE_CODE_COMM_ACTOR_TABLE, MOVE_CODE_TABLE_BYTES)
  const view = new DataView(tableBytes.buffer, tableBytes.byteOffset, tableBytes.byteLength)
  const table = {
    address: hex(MOVE_CODE_COMM_ACTOR_TABLE),
    raw: bytesHex(tableBytes),
    code: view.getUint32(0x00, true),
    init: view.getUint32(0x04, true),
    move: view.getUint32(0x08, true),
    delete: view.getUint32(0x0c, true),
    onReturn: view.getUint32(0x10, true),
  }

  const expected = {
    code: MOVE_CODE_COMM_ACTOR,
    init: FIELD_COMM_ACTOR_MOVE_INIT | 1,
    move: FIELD_COMM_ACTOR_MOVE | 1,
    delete: FIELD_COMM_ACTOR_MOVE_DELETE | 1,
  }

  const tableChecks = {
    code: table.code === expected.code,
    init: table.init === expected.init,
    move: table.move === expected.move,
    delete: table.delete === expected.delete,
  }

  return {
    purpose: 'prove White 2 native communication-actor code is resident before any integration experiment',
    source: 'pokebw2 w2_us overlay 36 symbols + sMoveCodeCommActor',
    functions,
    moveCodeTable: {
      ...table,
      codeHex: hex(table.code),
      initHex: hex(table.init),
      moveHex: hex(table.move),
      deleteHex: hex(table.delete),
      onReturnHex: hex(table.onReturn),
      expected: {
        code: hex(expected.code),
        init: hex(expected.init),
        move: hex(expected.move),
        delete: hex(expected.delete),
      },
      checks: tableChecks,
    },
    conclusion: {
      allFunctionsResident: functions.every(fn => fn.resident),
      moveCodeTableMatchesDecomp: Object.values(tableChecks).every(Boolean),
      safeToResearchNativePathNext: functions.every(fn => fn.resident) && Object.values(tableChecks).every(Boolean),
    },
  }
}

/**
 * Probe 5: read-only residency/symbol validation for White 2's built-in
 * field-communication actor implementation. No emulated memory is written.
 */
export function White2MemoryResearchPanel({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return

    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    let cancelled = false
    let busy = false
    let readyKey = ''
    let readySince = 0
    let capturedKey = ''

    async function capture() {
      if (cancelled || busy || runtimeBridge.status !== 'running') return
      busy = true
      try {
        const scan = await probe.scanHeap()
        const remote = scan.entries.find(entry => entry.uid === POKERUN_NATIVE_TEST_UID) ?? null
        if (!remote) {
          readyKey = ''
          readySince = 0
          return
        }

        const key = `${scan.actorSystem}:${remote.address}:${remote.modelId}`
        if (key !== readyKey) {
          readyKey = key
          readySince = performance.now()
          return
        }
        if (capturedKey === key || performance.now() - readySince < STABLE_MS) return

        const report = await captureNativeCommResidency(runtimeBridge)
        capturedKey = key
        console.info('[PokéRun resdiag] NATIVE COMM OVERLAY RESIDENCY', report)
      } catch (reason) {
        console.info('[PokéRun resdiag] PROBE 5 WAITING', {
          reason: reason instanceof Error ? reason.message : String(reason),
        })
      } finally {
        busy = false
      }
    }

    void capture()
    const timer = window.setInterval(() => void capture(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
