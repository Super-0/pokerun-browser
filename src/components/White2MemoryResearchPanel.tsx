import { useEffect } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2ActorSystemProbe } from '../multiplayer/games/White2ActorSystem'
import { POKERUN_NATIVE_TEST_UID } from '../multiplayer/games/White2NativeActor'

// Probe 6 validates the allocator/lifetime of White 2's native field-
// communication actor system before we let it create any actors.
//
// pokebw2 w2_us overlay 36 symbols:
//   FldCommActSys_Create  0x0218AE78
//   FldCommActSys_Free    0x0218AEBC
const FLD_COMM_ACT_SYS_CREATE = 0x0218ae78
const FLD_COMM_ACT_SYS_FREE = 0x0218aebc

// MMSys from field_actor_internal.h. HeapID is u16 in this build, and the
// already-validated tcbMgr offset of +0x24 is consistent with heapId at +0x08.
const MMSYS_HEAP_ID = 0x08

// struct FldCommActSys {
//   u16 count;       // +0x00
//   u16 allowRun;    // +0x02
//   MMSys *system;   // +0x04
//   Entry *entries;  // +0x08
// }
const COMM_SYS_SIZE = 0x0c

// struct FldCommActEntry {
//   u32 netId;       // +0x00
//   u16 actorDeleted;// +0x04
//   u16 allowRun;    // +0x06
//   FieldActor *actor;//+0x08
// }
const COMM_ENTRY_SIZE = 0x0c

const POLL_MS = 150
const STABLE_MS = 700
const NATIVE_STACK_RESERVE = 0x400
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000

function hex(value: number) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

function bytesHex(bytes: Uint8Array) {
  return [...bytes].map(value => value.toString(16).toUpperCase().padStart(2, '0')).join(' ')
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 3) === 0
}

function assertMainRamPointer(value: number, label: string) {
  if (!isMainRamPointer(value)) throw new Error(`${label} is not a valid White 2 main-RAM pointer: ${hex(value)}.`)
}

function assertCallReturned(call: { status: number; result: number; pc: number }, label: string) {
  if (call.status === 1) return
  throw new Error(`${label} did not return normally (status ${call.status}, PC ${hex(call.pc)}).`)
}

async function probeNativeCommSystemLifetime(bridge: MelonDsBridge, actorSystem: number) {
  const heapId = await bridge.read16(actorSystem + MMSYS_HEAP_ID)

  const createCall = await bridge.callArm9Thumb4(
    FLD_COMM_ACT_SYS_CREATE,
    1, // count
    actorSystem,
    heapId,
    1, // allowRun
    NATIVE_STACK_RESERVE,
  )
  assertCallReturned(createCall, 'FldCommActSys_Create')

  const commSystem = createCall.result >>> 0
  assertMainRamPointer(commSystem, 'FldCommActSys_Create result')

  let freeCall: { status: number; result: number; pc: number } | null = null
  let report: Record<string, unknown> | null = null

  try {
    const systemBytes = await bridge.readBytes(commSystem, COMM_SYS_SIZE)
    const systemView = new DataView(systemBytes.buffer, systemBytes.byteOffset, systemBytes.byteLength)
    const count = systemView.getUint16(0x00, true)
    const allowRun = systemView.getUint16(0x02, true)
    const storedActorSystem = systemView.getUint32(0x04, true)
    const entries = systemView.getUint32(0x08, true)
    assertMainRamPointer(entries, 'FldCommActSys entries')

    const entryBytes = await bridge.readBytes(entries, COMM_ENTRY_SIZE)
    const entryView = new DataView(entryBytes.buffer, entryBytes.byteOffset, entryBytes.byteLength)
    const entry = {
      netId: entryView.getUint32(0x00, true),
      actorDeleted: entryView.getUint16(0x04, true),
      allowRun: entryView.getUint16(0x06, true),
      actor: entryView.getUint32(0x08, true),
    }

    report = {
      purpose: 'validate native FldCommActSys allocation/layout/free before creating a native communication actor',
      source: 'pokebw2 src/ov036/field_comm_actor.c + field_actor_internal.h',
      actorSystem: hex(actorSystem),
      actorSystemHeapId: heapId,
      create: {
        status: createCall.status,
        result: hex(commSystem),
      },
      allocatedSystem: {
        address: hex(commSystem),
        raw: bytesHex(systemBytes),
        count,
        allowRun,
        actorSystem: hex(storedActorSystem),
        entries: hex(entries),
      },
      firstEntry: {
        address: hex(entries),
        raw: bytesHex(entryBytes),
        netId: entry.netId,
        actorDeleted: entry.actorDeleted,
        allowRun: entry.allowRun,
        actor: hex(entry.actor),
      },
      checks: {
        countIsOne: count === 1,
        allowRunEnabled: allowRun === 1,
        actorSystemMatches: storedActorSystem === actorSystem,
        entriesPointerValid: isMainRamPointer(entries),
        firstEntryInitiallyZeroed: entry.netId === 0 && entry.actorDeleted === 0 && entry.allowRun === 0 && entry.actor === 0,
      },
    }
  } finally {
    freeCall = await bridge.callArm9Thumb4(
      FLD_COMM_ACT_SYS_FREE,
      commSystem,
      0,
      0,
      0,
      NATIVE_STACK_RESERVE,
    )
    assertCallReturned(freeCall, 'FldCommActSys_Free')
  }

  return {
    ...report,
    free: {
      status: freeCall?.status ?? 0,
      returnedNormally: freeCall?.status === 1,
    },
    conclusion: {
      allocatorLifetimeValidated: Boolean(
        report
        && (report.checks as Record<string, boolean> | undefined)
        && Object.values(report.checks as Record<string, boolean>).every(Boolean)
        && freeCall?.status === 1
      ),
      nextIfTrue: 'Probe 7 can allocate persistent remote state and create an actor through FldCommActSys_CreateActor.',
    },
  }
}

/**
 * Probe 6: controlled native allocator/lifetime test.
 *
 * This DOES allocate and immediately free a FldCommActSys, but it creates no
 * FieldActor and modifies no existing actor. It is intentionally the smallest
 * write-side experiment after Probe 5 proved overlay 36 is resident.
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

        // Mark before the allocation so React remounts / slow logging cannot run
        // the same lifetime test twice for one stable actor binding.
        capturedKey = key
        const report = await probeNativeCommSystemLifetime(runtimeBridge, scan.actorSystem)
        console.info('[PokéRun resdiag] NATIVE COMM SYSTEM LIFETIME', report)
      } catch (reason) {
        console.info('[PokéRun resdiag] PROBE 6 WAITING', {
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
