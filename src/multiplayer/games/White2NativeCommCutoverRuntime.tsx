import { useEffect, useRef } from 'react'
import type { Arm9NativeCallResult, MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerPlayerState, MultiplayerRomIdentity } from '../core/protocol'
import { White2ActorSystemProbe } from './White2ActorSystem'

// Probe 10: the actual DEV remote-P2 renderer uses White 2's native field
// communication actor system. The old detached/manual actor runtime is not
// mounted in DEV while this probe is active.
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
const PROBE_NET_ID = 0x7000000a
const COMM_ENTRY_SIZE = 0x0c
const COMM_COUNT = 3
const UPDATE_MS = 40
const STATUS_MS = 2000

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

type NativeRemote = {
  actorSystem: number
  commSystem: number
  entries: number
  actorEntry: number
  posAddress: number
  dirAddress: number
  hiddenAddress: number
  actor: number
  modelId: number
  lastRemoteKey: string
  distinctRemotePositions: number
  writes: number
  movementDrawStatusObserved: boolean
  createdAt: number
  lastStatusAt: number
}

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
      reject(new Error(`Probe 10 timed out waiting for ${count} emulated frames.`))
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

async function readActor(bridge: MelonDsBridge, actor: number) {
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
    uid,
    modelId,
    moveCode,
    faceDir,
    drawStatus,
    world: { x: signed32(x), y: signed32(y), z: signed32(z) },
    tcb,
    moveCodeVTable,
  }
}

async function createNativeRemote(
  bridge: MelonDsBridge,
  probe: White2ActorSystemProbe,
  presence: MultiplayerPresenceSnapshot,
): Promise<NativeRemote | null> {
  const local = presence.local
  const remote = presence.remote
  if (!local || !remote?.worldPosition || local.location.mapId !== remote.location.mapId) return null

  const scan = await probe.scanHeap()
  const player = scan.entries.find(entry => entry.state === 'player')
  if (!player) return null
  const modelId = player.modelId
  const heapId = await bridge.read16(scan.actorSystem + MMSYS_HEAP_ID)
  const createSys = await bridge.callArm9Thumb4(
    FLD_COMM_ACT_SYS_CREATE,
    COMM_COUNT,
    scan.actorSystem,
    heapId,
    1,
    NATIVE_STACK_RESERVE,
  )
  assertCall(createSys, 'FldCommActSys_Create(Probe 10)')
  const commSystem = createSys.result >>> 0
  assertPointer(commSystem, 'Probe 10 comm system')
  const entries = await bridge.read32(commSystem + 0x08)
  assertPointer(entries, 'Probe 10 entries')

  const actorEntry = entries
  const posAddress = entries + COMM_ENTRY_SIZE
  const auxAddress = entries + COMM_ENTRY_SIZE * 2
  const dirAddress = auxAddress
  const hiddenAddress = auxAddress + 4

  await writeVec(bridge, posAddress, remote.worldPosition.x, remote.worldPosition.y, remote.worldPosition.z)
  await bridge.write16(dirAddress, DIR_TO_FIELD[remote.direction])
  await bridge.write32(hiddenAddress, 0)

  try {
    const createTask = await runScheduledCall6(
      bridge,
      probe,
      FLD_COMM_ACT_SYS_CREATE_ACTOR,
      [commSystem, PROBE_NET_ID, modelId, dirAddress, posAddress, hiddenAddress],
      'FldCommActSys_CreateActor(Probe 10)',
      true,
    )
    const actor = await bridge.read32(actorEntry + 8)
    assertPointer(actor, 'Probe 10 native P2 actor')
    await waitForFrames(bridge, 8)
    const snapshot = await readActor(bridge, actor)
    const valid = snapshot.uid === NATIVE_COMM_UID
      && snapshot.moveCode === MOVE_CODE_COMM_ACTOR
      && snapshot.moveCodeVTable === MOVE_CODE_COMM_ACTOR_TABLE
      && isMainRamPointer(snapshot.tcb)
    if (!valid) throw new Error('Probe 10 native P2 actor did not initialize as a valid White 2 communication actor.')

    console.info('[PokéRun lifecycle] NATIVE COMM CUTOVER READY', {
      actor: hex(actor),
      actorSystem: hex(scan.actorSystem),
      commSystem: hex(commSystem),
      modelId,
      moveCode: snapshot.moveCode,
      tcb: hex(snapshot.tcb),
      createTask,
      note: 'DEV is now rendering the actual fake P2 with White 2 FieldCommActor; old detached/manual P2 runtime is disabled.',
    })

    return {
      actorSystem: scan.actorSystem,
      commSystem,
      entries,
      actorEntry,
      posAddress,
      dirAddress,
      hiddenAddress,
      actor,
      modelId,
      lastRemoteKey: '',
      distinctRemotePositions: 0,
      writes: 0,
      movementDrawStatusObserved: false,
      createdAt: performance.now(),
      lastStatusAt: 0,
    }
  } catch (reason) {
    await bridge.writeBytes(entries + COMM_ENTRY_SIZE, new Uint8Array(COMM_ENTRY_SIZE * 2))
    const free = await bridge.callArm9Thumb4(FLD_COMM_ACT_SYS_FREE, commSystem, 0, 0, 0, NATIVE_STACK_RESERVE)
    assertCall(free, 'FldCommActSys_Free(Probe 10 create failure)')
    throw reason
  }
}

async function deleteNativeRemote(
  bridge: MelonDsBridge,
  probe: White2ActorSystemProbe,
  current: NativeRemote,
) {
  let safe = true
  try {
    await bridge.write32(current.hiddenAddress, 1)
    await waitForFrames(bridge, 2)
    const deleteTask = await runScheduledCall6(
      bridge,
      probe,
      FLD_COMM_ACT_SYS_DELETE_ACTOR,
      [current.commSystem, PROBE_NET_ID, 0, 0, 0, 0],
      'FldCommActSys_DeleteActor(Probe 10)',
    )
    await waitForFrames(bridge, 2)
    await bridge.writeBytes(current.entries + COMM_ENTRY_SIZE, new Uint8Array(COMM_ENTRY_SIZE * 2))
    const freeCall = await bridge.callArm9Thumb4(
      FLD_COMM_ACT_SYS_FREE,
      current.commSystem,
      0,
      0,
      0,
      NATIVE_STACK_RESERVE,
    )
    assertCall(freeCall, 'FldCommActSys_Free(Probe 10)')
    console.info('[PokéRun lifecycle] NATIVE COMM CUTOVER CLEANUP', {
      actor: hex(current.actor),
      deleteTask,
      freeStatus: freeCall.status,
      safe: true,
    })
  } catch (reason) {
    safe = false
    console.info('[PokéRun lifecycle] NATIVE COMM CUTOVER CLEANUP UNSAFE - RELOAD GAME', {
      actor: hex(current.actor),
      commSystem: hex(current.commSystem),
      reason: reason instanceof Error ? reason.message : String(reason),
    })
  }
  return safe
}

export function White2NativeCommCutoverRuntime({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
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
    let nativeRemote: NativeRemote | null = null
    let lastError = ''

    async function tick() {
      if (cancelled || busy || runtimeBridge.status !== 'running') return
      busy = true
      try {
        const presence = presenceRef.current
        const local = presence.local
        const remote = presence.remote

        if (!local || !remote?.worldPosition) return

        if (!nativeRemote) {
          nativeRemote = await createNativeRemote(runtimeBridge, probe, presence)
          return
        }

        const current = nativeRemote
        const hidden = local.location.mapId === remote.location.mapId ? 0 : 1
        await writeVec(runtimeBridge, current.posAddress, remote.worldPosition.x, remote.worldPosition.y, remote.worldPosition.z)
        await runtimeBridge.write16(current.dirAddress, DIR_TO_FIELD[remote.direction])
        await runtimeBridge.write32(current.hiddenAddress, hidden)
        current.writes += 1

        const remoteKey = `${remote.worldPosition.x}:${remote.worldPosition.y}:${remote.worldPosition.z}:${remote.direction}:${hidden}`
        if (remoteKey !== current.lastRemoteKey) {
          current.lastRemoteKey = remoteKey
          current.distinctRemotePositions += 1
        }

        await waitForFrames(runtimeBridge, 1)
        const actor = await readActor(runtimeBridge, current.actor)
        if (actor.drawStatus !== 0) current.movementDrawStatusObserved = true

        const expectedX = signed32(remote.worldPosition.x)
        const expectedY = signed32(remote.worldPosition.y)
        const expectedZ = signed32(remote.worldPosition.z)
        const error = Math.abs(actor.world.x - expectedX)
          + Math.abs(actor.world.y - expectedY)
          + Math.abs(actor.world.z - expectedZ)

        const now = performance.now()
        if (now - current.lastStatusAt >= STATUS_MS) {
          current.lastStatusAt = now
          console.info('[PokéRun resdiag] NATIVE COMM CUTOVER STATUS', {
            actor: hex(current.actor),
            modelId: current.modelId,
            ageMs: Math.round(now - current.createdAt),
            writes: current.writes,
            distinctRemotePositions: current.distinctRemotePositions,
            movementDrawStatusObserved: current.movementDrawStatusObserved,
            hidden: Boolean(hidden),
            expected: { x: expectedX, y: expectedY, z: expectedZ, direction: DIR_TO_FIELD[remote.direction] },
            actual: { ...actor, tcb: hex(actor.tcb), moveCodeVTable: hex(actor.moveCodeVTable) },
            actorError: error,
            healthy: actor.uid === NATIVE_COMM_UID
              && actor.moveCode === MOVE_CODE_COMM_ACTOR
              && actor.moveCodeVTable === MOVE_CODE_COMM_ACTOR_TABLE
              && isMainRamPointer(actor.tcb)
              && actor.faceDir === DIR_TO_FIELD[remote.direction]
              && error <= 0x10000,
          })
        }
        lastError = ''
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason)
        if (message !== lastError) {
          lastError = message
          console.info('[PokéRun resdiag] PROBE 10 RESULT', {
            ok: false,
            reason: message,
            recovery: message.includes('may still be live') ? 'Reload the game before retrying.' : 'Runtime will retry while the field is available.',
          })
        }
      } finally {
        busy = false
      }
    }

    void tick()
    const timer = window.setInterval(() => void tick(), UPDATE_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      const current = nativeRemote
      nativeRemote = null
      if (current && runtimeBridge.status === 'running') void deleteNativeRemote(runtimeBridge, probe, current)
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
