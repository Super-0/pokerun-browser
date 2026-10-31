import { useEffect, useRef } from 'react'
import type { Arm9NativeCallResult, MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../multiplayer/core/MultiplayerPresence'
import type { MultiplayerPlayerState, MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2ActorSystemProbe } from '../multiplayer/games/White2ActorSystem'
import { POKERUN_NATIVE_TEST_UID } from '../multiplayer/games/White2NativeActor'

// Probe 9: mirror the *real fake-peer multiplayer stream* into White 2's native
// field communication actor path. The current generic PokéRun remote remains in
// place; this probe spawns a second native comm heroine two tiles east so both
// can be observed at once. PokéRun updates only the comm actor's backing state.
const FLD_COMM_ACT_SYS_CREATE = 0x0218ae78
const FLD_COMM_ACT_SYS_FREE = 0x0218aebc
const FLD_COMM_ACT_SYS_CREATE_ACTOR = 0x0218aef4
const FLD_COMM_ACT_SYS_DELETE_ACTOR = 0x0218af48
const GFL_TCB_MGR_ADD_TASK = 0x0203a640

const MMSYS_HEAP_ID = 0x08
const MMSYS_TCB_MGR = 0x24
const ACTOR_UID = 0x08
const ACTOR_MODEL_ID = 0x0c
const ACTOR_MOVE_CODE = 0x0e
const ACTOR_FACE_DIR = 0x18
const ACTOR_DRAW_STATUS = 0x2a
const ACTOR_WPOS = 0x44
const ACTOR_TCB = 0x84
const ACTOR_MOVE_CODE_VTABLE = 0x8c

const MOVE_CODE_COMM_ACTOR = 0x44
const MOVE_CODE_COMM_ACTOR_TABLE = 0x021cc418
const NATIVE_COMM_UID = 0x00fc
const PROBE_NET_ID = 0x70000009
const COMM_ENTRY_SIZE = 0x0c
const COMM_COUNT = 3
const FX32_TILE = 0x10000
const MIRROR_X_OFFSET = FX32_TILE * 2
const MIRROR_MS = 15000
const UPDATE_MS = 40

const FIELD_ACTOR_SIZE = 0x100
const TASK_DATA_OFFSET = 0x94
const TASK_CODE_OFFSET = 0xd0
const TASK_SCRATCH_SIZE = FIELD_ACTOR_SIZE - TASK_DATA_OFFSET
const TASK_RESULT_OFFSET = 0x1c
const TASK_STATUS_OFFSET = 0x20
const TASK_TIMEOUT_FRAMES = 900
const NATIVE_STACK_RESERVE = 0x400
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000
const POLL_MS = 150
const STABLE_MS = 700

const DIR_TO_FIELD: Record<MultiplayerPlayerState['direction'], number> = {
  north: 0,
  south: 1,
  west: 2,
  east: 3,
}

const SIX_ARG_FIELD_TASK_TRAMPOLINE = Uint8Array.from([
  0xf0, 0xb5, 0x04, 0x1c, 0x0d, 0x1c, 0x2e, 0x68,
  0x68, 0x68, 0xa9, 0x68, 0xea, 0x68, 0x2b, 0x69,
  0x83, 0xb0, 0x6f, 0x69, 0x00, 0x97, 0xaf, 0x69,
  0x01, 0x97, 0xb0, 0x47, 0x03, 0xb0, 0xe8, 0x61,
  0x20, 0x1c, 0x02, 0x4e, 0xb0, 0x47, 0x01, 0x27,
  0x2f, 0x62, 0xf0, 0xbd, 0xd5, 0xa6, 0x03, 0x02,
])

function delay(ms: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms))
}

function hex(value: number) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

function signed32(value: number) {
  return value | 0
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 3) === 0
}

function assertPointer(value: number, label: string) {
  if (!isMainRamPointer(value)) throw new Error(`${label} is not a valid main-RAM pointer: ${hex(value)}.`)
}

function assertCall(call: Arm9NativeCallResult, label: string) {
  if (call.status !== 1) throw new Error(`${label} failed (status ${call.status}, PC ${hex(call.pc)}).`)
}

async function waitForFrames(bridge: MelonDsBridge, count: number) {
  await new Promise<void>((resolve, reject) => {
    let frames = 0
    const timeout = window.setTimeout(() => {
      unsubscribe()
      reject(new Error(`Probe 9 timed out waiting for ${count} emulated frames.`))
    }, Math.max(5000, count * 40))
    const unsubscribe = bridge.subscribeEmulatedFrame(() => {
      frames += 1
      if (frames < count) return
      window.clearTimeout(timeout)
      unsubscribe()
      resolve()
    })
  })
}

async function runScheduledCall6(
  bridge: MelonDsBridge,
  probe: White2ActorSystemProbe,
  functionAddress: number,
  args: readonly [number, number, number, number, number, number],
  label: string,
  mayCreateActor = false,
) {
  const scan = await probe.scanHeap()
  const zeroed = scan.entries.filter(entry => entry.state === 'zeroed').sort((a, b) => a.index - b.index)
  const required = mayCreateActor ? 2 : 1
  if (zeroed.length < required) throw new Error(`${label} needs ${required} free actor slots; found ${zeroed.length}.`)

  const scratchSlot = zeroed[zeroed.length - 1]
  const dataAddress = scratchSlot.address + TASK_DATA_OFFSET
  const codeAddress = scratchSlot.address + TASK_CODE_OFFSET
  const original = await bridge.readBytes(dataAddress, TASK_SCRATCH_SIZE)
  const tcbManager = await bridge.read32(scan.actorSystem + MMSYS_TCB_MGR)
  assertPointer(tcbManager, `${label} TCB manager`)

  const scratch = new Uint8Array(TASK_SCRATCH_SIZE)
  const view = new DataView(scratch.buffer)
  view.setUint32(0x00, (functionAddress | 1) >>> 0, true)
  args.forEach((value, index) => view.setUint32(0x04 + index * 4, value >>> 0, true))
  scratch.set(SIX_ARG_FIELD_TASK_TRAMPOLINE, TASK_CODE_OFFSET - TASK_DATA_OFFSET)

  let scheduled = false
  let completed = false
  let task = 0
  let frames = 0
  const unsubscribe = bridge.subscribeEmulatedFrame(() => { frames += 1 })
  try {
    await bridge.writeBytes(dataAddress, scratch)
    const add = await bridge.callArm9Thumb4(
      GFL_TCB_MGR_ADD_TASK,
      tcbManager,
      (codeAddress | 1) >>> 0,
      dataAddress,
      0,
      NATIVE_STACK_RESERVE,
    )
    assertCall(add, `GFL_TCBMgrAddTask(${label})`)
    task = add.result >>> 0
    assertPointer(task, `${label} task`)
    scheduled = true

    while (frames < TASK_TIMEOUT_FRAMES) {
      if ((await bridge.read32(dataAddress + TASK_STATUS_OFFSET)) === 1) {
        completed = true
        return {
          result: await bridge.read32(dataAddress + TASK_RESULT_OFFSET),
          task,
          frames,
        }
      }
      await delay(16)
    }
    throw new Error(`${label} did not finish; reload the game before retrying because its task may still be live.`)
  } finally {
    unsubscribe()
    if (!scheduled || completed) await bridge.writeBytes(dataAddress, original)
  }
}

async function writeVec(bridge: MelonDsBridge, address: number, x: number, y: number, z: number) {
  await bridge.write32(address + 0x00, x >>> 0)
  await bridge.write32(address + 0x04, y >>> 0)
  await bridge.write32(address + 0x08, z >>> 0)
}

async function actorSnapshot(bridge: MelonDsBridge, actor: number) {
  const [uid, modelId, moveCode, faceDir, drawStatus, x, y, z, tcb, moveCodeVTable] = await Promise.all([
    bridge.read16(actor + ACTOR_UID),
    bridge.read16(actor + ACTOR_MODEL_ID),
    bridge.read16(actor + ACTOR_MOVE_CODE),
    bridge.read16(actor + ACTOR_FACE_DIR),
    bridge.read16(actor + ACTOR_DRAW_STATUS),
    bridge.read32(actor + ACTOR_WPOS),
    bridge.read32(actor + ACTOR_WPOS + 4),
    bridge.read32(actor + ACTOR_WPOS + 8),
    bridge.read32(actor + ACTOR_TCB),
    bridge.read32(actor + ACTOR_MOVE_CODE_VTABLE),
  ])
  return {
    actor: hex(actor),
    uid,
    modelId,
    moveCode,
    faceDir,
    drawStatus,
    world: { x: signed32(x), y: signed32(y), z: signed32(z) },
    tcb: hex(tcb),
    moveCodeVTable: hex(moveCodeVTable),
  }
}

async function runLiveMirror(
  bridge: MelonDsBridge,
  probe: White2ActorSystemProbe,
  actorSystem: number,
  modelId: number,
  getPresence: () => MultiplayerPresenceSnapshot,
) {
  const heapId = await bridge.read16(actorSystem + MMSYS_HEAP_ID)
  const createSys = await bridge.callArm9Thumb4(
    FLD_COMM_ACT_SYS_CREATE,
    COMM_COUNT,
    actorSystem,
    heapId,
    1,
    NATIVE_STACK_RESERVE,
  )
  assertCall(createSys, 'FldCommActSys_Create(Probe 9)')
  const commSystem = createSys.result >>> 0
  assertPointer(commSystem, 'Probe 9 comm system')
  const entries = await bridge.read32(commSystem + 0x08)
  assertPointer(entries, 'Probe 9 entries')

  const actorEntry = entries
  const posAddress = entries + COMM_ENTRY_SIZE
  const auxAddress = entries + COMM_ENTRY_SIZE * 2
  const dirAddress = auxAddress
  const hiddenAddress = auxAddress + 4

  let nativeActor = 0
  let deleteTask: unknown = null
  let freeCall: Arm9NativeCallResult | null = null
  let safe = true

  try {
    const startingPresence = getPresence()
    const initialRemote = startingPresence.remote
    if (!initialRemote?.worldPosition) throw new Error('Probe 9 needs a remote fake-P2 world position before native mirror creation.')
    const sameMap = Boolean(startingPresence.local && startingPresence.local.location.mapId === initialRemote.location.mapId)
    const initialX = (initialRemote.worldPosition.x + MIRROR_X_OFFSET) >>> 0
    await writeVec(bridge, posAddress, initialX, initialRemote.worldPosition.y, initialRemote.worldPosition.z)
    await bridge.write16(dirAddress, DIR_TO_FIELD[initialRemote.direction])
    await bridge.write32(hiddenAddress, sameMap ? 0 : 1)

    const createTask = await runScheduledCall6(
      bridge,
      probe,
      FLD_COMM_ACT_SYS_CREATE_ACTOR,
      [commSystem, PROBE_NET_ID, modelId, dirAddress, posAddress, hiddenAddress],
      'FldCommActSys_CreateActor(Probe 9)',
      true,
    )
    nativeActor = await bridge.read32(actorEntry + 8)
    assertPointer(nativeActor, 'Probe 9 native actor')
    await waitForFrames(bridge, 20)

    const initialActor = await actorSnapshot(bridge, nativeActor)
    console.info('[PokéRun resdiag] PROBE 9 LIVE MIRROR READY', {
      actor: hex(nativeActor),
      durationMs: MIRROR_MS,
      xOffsetTiles: 2,
      instruction: 'Move fake P2 normally now; the native comm heroine should mirror it two tiles to the right.',
      initialActor,
    })

    const startedAt = performance.now()
    let writes = 0
    let distinctRemotePositions = 0
    let lastRemoteKey = ''
    let lastExpected: { x: number; y: number; z: number; dir: number; hidden: number } | null = null
    let maxActorError = 0
    let movementDrawStatusObserved = false

    while (performance.now() - startedAt < MIRROR_MS) {
      const presence = getPresence()
      const remote = presence.remote
      if (remote?.worldPosition) {
        const hidden = presence.local && presence.local.location.mapId === remote.location.mapId ? 0 : 1
        const expected = {
          x: (remote.worldPosition.x + MIRROR_X_OFFSET) >>> 0,
          y: remote.worldPosition.y >>> 0,
          z: remote.worldPosition.z >>> 0,
          dir: DIR_TO_FIELD[remote.direction],
          hidden,
        }
        await writeVec(bridge, posAddress, expected.x, expected.y, expected.z)
        await bridge.write16(dirAddress, expected.dir)
        await bridge.write32(hiddenAddress, expected.hidden)
        writes += 1
        lastExpected = expected

        const remoteKey = `${remote.worldPosition.x}:${remote.worldPosition.y}:${remote.worldPosition.z}:${remote.direction}`
        if (remoteKey !== lastRemoteKey) {
          lastRemoteKey = remoteKey
          distinctRemotePositions += 1
        }

        await waitForFrames(bridge, 1)
        const sample = await actorSnapshot(bridge, nativeActor)
        const error = Math.abs(sample.world.x - signed32(expected.x))
          + Math.abs(sample.world.y - signed32(expected.y))
          + Math.abs(sample.world.z - signed32(expected.z))
        maxActorError = Math.max(maxActorError, error)
        if (sample.drawStatus !== 0) movementDrawStatusObserved = true
      }
      await delay(UPDATE_MS)
    }

    await waitForFrames(bridge, 3)
    const finalActor = await actorSnapshot(bridge, nativeActor)
    const finalExpected = lastExpected
    const finalPositionMatches = Boolean(
      finalExpected
      && finalActor.world.x === signed32(finalExpected.x)
      && finalActor.world.y === signed32(finalExpected.y)
      && finalActor.world.z === signed32(finalExpected.z)
    )
    const finalDirectionMatches = Boolean(finalExpected && finalActor.faceDir === finalExpected.dir)

    const checks = {
      nativeIdentity: initialActor.uid === NATIVE_COMM_UID
        && initialActor.moveCode === MOVE_CODE_COMM_ACTOR
        && initialActor.moveCodeVTable === hex(MOVE_CODE_COMM_ACTOR_TABLE),
      nativeUpdaterAttached: initialActor.tcb !== hex(0),
      consumedLivePresenceStream: writes > 0,
      finalPositionMatches,
      finalDirectionMatches,
      cleanupEligible: true,
    }

    return {
      purpose: 'prove live fake-P2 multiplayer state can directly drive White 2 native field communication actor backing state',
      actorSystem: hex(actorSystem),
      modelId,
      commSystem: hex(commSystem),
      actor: hex(nativeActor),
      mirror: { durationMs: MIRROR_MS, xOffsetTiles: 2, writes, distinctRemotePositions, maxActorError, movementDrawStatusObserved },
      createTask,
      initialActor,
      finalExpected: finalExpected ? { ...finalExpected, x: signed32(finalExpected.x), y: signed32(finalExpected.y), z: signed32(finalExpected.z) } : null,
      finalActor,
      checks,
      conclusion: {
        liveFakePeerToNativeCommValidated: Object.values(checks).every(Boolean),
        userMovementObserved: distinctRemotePositions > 1,
      },
      cleanup: null as unknown,
    }
  } catch (reason) {
    if (reason instanceof Error && reason.message.includes('may still be live')) safe = false
    throw reason
  } finally {
    if (safe) {
      try {
        if (nativeActor) {
          deleteTask = await runScheduledCall6(
            bridge,
            probe,
            FLD_COMM_ACT_SYS_DELETE_ACTOR,
            [commSystem, PROBE_NET_ID, 0, 0, 0, 0],
            'FldCommActSys_DeleteActor(Probe 9)',
          )
          await waitForFrames(bridge, 2)
        }
        await bridge.writeBytes(entries + COMM_ENTRY_SIZE, new Uint8Array(COMM_ENTRY_SIZE * 2))
        freeCall = await bridge.callArm9Thumb4(
          FLD_COMM_ACT_SYS_FREE,
          commSystem,
          0,
          0,
          0,
          NATIVE_STACK_RESERVE,
        )
        assertCall(freeCall, 'FldCommActSys_Free(Probe 9)')
      } catch (cleanupReason) {
        safe = false
        console.info('[PokéRun resdiag] PROBE 9 CLEANUP UNSAFE - RELOAD GAME', {
          reason: cleanupReason instanceof Error ? cleanupReason.message : String(cleanupReason),
          nativeActor: hex(nativeActor),
          commSystem: hex(commSystem),
        })
      }
    }
    console.info('[PokéRun resdiag] PROBE 9 CLEANUP', {
      deleteTask,
      freeStatus: freeCall?.status ?? 0,
      freeReturnedNormally: freeCall?.status === 1,
      safe,
    })
  }
}

export function White2NativeCommLiveMirrorProbe({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const presenceRef = useRef<MultiplayerPresenceSnapshot>({ local: null, remote: null })

  useEffect(() => multiplayerPresence.subscribe(snapshot => {
    presenceRef.current = snapshot
  }), [])

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
        const presence = presenceRef.current
        if (!presence.local?.worldPosition || !presence.remote?.worldPosition) {
          readyKey = ''
          readySince = 0
          return
        }

        const scan = await probe.scanHeap()
        const remotes = scan.entries.filter(entry => entry.uid === POKERUN_NATIVE_TEST_UID)
        const remoteActor = remotes.length === 1 ? remotes[0] : null
        if (!remoteActor) {
          readyKey = ''
          readySince = 0
          return
        }

        const key = `${scan.actorSystem}:${remoteActor.address}:${remoteActor.modelId}`
        if (key !== readyKey) {
          readyKey = key
          readySince = performance.now()
          return
        }
        if (capturedKey === key || performance.now() - readySince < STABLE_MS) return
        capturedKey = key

        const report = await runLiveMirror(
          runtimeBridge,
          probe,
          scan.actorSystem,
          remoteActor.modelId,
          () => presenceRef.current,
        )
        console.info('[PokéRun resdiag] NATIVE COMM LIVE MIRROR', report)
      } catch (reason) {
        console.info('[PokéRun resdiag] PROBE 9 RESULT', {
          ok: false,
          reason: reason instanceof Error ? reason.message : String(reason),
          recovery: reason instanceof Error && reason.message.includes('may still be live')
            ? 'Reload the game before retrying.'
            : 'Cleanup was attempted; inspect cleanup logs before retrying.',
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
