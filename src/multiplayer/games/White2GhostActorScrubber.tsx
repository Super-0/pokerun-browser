import { useEffect } from 'react'
import type { Arm9NativeCallResult, MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../core/protocol'
import { White2ActorSystemProbe } from './White2ActorSystem'

// One-time DEV repair for a stale actor that was accidentally persisted into the
// test save during early multiplayer experiments. The signature is intentionally
// exact so a legitimate map actor can never be selected just because it shares
// a UID or model.
const DELETE_ACTOR = 0x02166980
const GFL_TCB_MGR_ADD_TASK = 0x0203a640
const MMSYS_TCB_MGR = 0x24

const ACTOR_MOVE_CODE = 0x0e

const GHOST_UID = 1
const GHOST_MODEL_ID = 11
const GHOST_MOVE_CODE = 2
const GHOST_ZONE_ID = 0
const GHOST_X = 54
const GHOST_Z = 713

const FIELD_ACTOR_SIZE = 0x100
const TASK_DATA_OFFSET = 0x94
const TASK_CODE_OFFSET = 0xd0
const TASK_SCRATCH_SIZE = FIELD_ACTOR_SIZE - TASK_DATA_OFFSET
const TASK_RESULT_OFFSET = 0x1c
const TASK_STATUS_OFFSET = 0x20
const TASK_TIMEOUT_FRAMES = 300
const NATIVE_STACK_RESERVE = 0x400
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000

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

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 3) === 0
}

function assertCall(call: Arm9NativeCallResult, label: string) {
  if (call.status !== 1) throw new Error(`${label} failed (status ${call.status}, PC ${hex(call.pc)}).`)
}

async function scheduledDelete(
  bridge: MelonDsBridge,
  probe: White2ActorSystemProbe,
  actor: number,
) {
  const scan = await probe.scanHeap()
  const zeroed = scan.entries.filter(entry => entry.state === 'zeroed').sort((a, b) => a.index - b.index)
  if (!zeroed.length) throw new Error('Ghost scrubber needs one free FieldActor slot for task scratch.')

  const scratchSlot = zeroed[zeroed.length - 1]
  const dataAddress = scratchSlot.address + TASK_DATA_OFFSET
  const codeAddress = scratchSlot.address + TASK_CODE_OFFSET
  const original = await bridge.readBytes(dataAddress, TASK_SCRATCH_SIZE)
  const tcbManager = await bridge.read32(scan.actorSystem + MMSYS_TCB_MGR)
  if (!isMainRamPointer(tcbManager)) throw new Error(`Ghost scrubber TCB manager is invalid (${hex(tcbManager)}).`)

  const scratch = new Uint8Array(TASK_SCRATCH_SIZE)
  const view = new DataView(scratch.buffer)
  view.setUint32(0x00, (DELETE_ACTOR | 1) >>> 0, true)
  view.setUint32(0x04, actor >>> 0, true)
  for (let i = 1; i < 6; i += 1) view.setUint32(0x04 + i * 4, 0, true)
  scratch.set(SIX_ARG_FIELD_TASK_TRAMPOLINE, TASK_CODE_OFFSET - TASK_DATA_OFFSET)

  let scheduled = false
  let completed = false
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
    assertCall(add, 'GFL_TCBMgrAddTask(Ghost scrubber)')
    scheduled = true

    while (frames < TASK_TIMEOUT_FRAMES) {
      if ((await bridge.read32(dataAddress + TASK_STATUS_OFFSET)) === 1) {
        completed = true
        return {
          result: await bridge.read32(dataAddress + TASK_RESULT_OFFSET),
          task: add.result >>> 0,
          frames,
        }
      }
      await delay(16)
    }
    throw new Error('Ghost scrubber delete task did not finish; reload the game before retrying.')
  } finally {
    unsubscribe()
    if (!scheduled || completed) await bridge.writeBytes(dataAddress, original)
  }
}

async function findGhost(bridge: MelonDsBridge, probe: White2ActorSystemProbe) {
  const scan = await probe.scanHeap()
  const player = scan.entries.find(entry => entry.state === 'player')
  if (!player || (player.modelId !== 231 && player.modelId !== 240) || !isMainRamPointer(player.tcb)) {
    return { stable: false, actor: null as number | null, signature: null as object | null }
  }

  for (const entry of scan.entries) {
    if (entry.state !== 'active') continue
    if (entry.uid !== GHOST_UID || entry.modelId !== GHOST_MODEL_ID || entry.zoneId !== GHOST_ZONE_ID) continue
    if (entry.x !== GHOST_X || entry.y !== GHOST_Z) continue
    const moveCode = await bridge.read16(entry.address + ACTOR_MOVE_CODE)
    if (moveCode !== GHOST_MOVE_CODE) continue
    return {
      stable: true,
      actor: entry.address,
      signature: {
        slot: entry.index,
        actor: hex(entry.address),
        uid: entry.uid,
        modelId: entry.modelId,
        moveCode,
        zoneId: entry.zoneId,
        grid: { x: entry.x, z: entry.y },
        flags: hex(entry.flags),
        movementFlags: hex(entry.movementFlags),
      },
    }
  }

  return { stable: true, actor: null as number | null, signature: null as object | null }
}

export function White2GhostActorScrubber({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return
    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    let cancelled = false
    let busy = false
    let done = false
    let cleanStableScans = 0
    let lastError = ''

    async function tick() {
      if (cancelled || busy || done || runtimeBridge.status !== 'running') return
      busy = true
      try {
        const match = await findGhost(runtimeBridge, probe)
        if (!match.stable) return

        if (!match.actor) {
          cleanStableScans += 1
          if (cleanStableScans >= 4) {
            done = true
            console.info('[PokéRun lifecycle] GHOST ACTOR SCRUBBER CLEAN', {
              signature: { uid: GHOST_UID, modelId: GHOST_MODEL_ID, moveCode: GHOST_MOVE_CODE, zoneId: GHOST_ZONE_ID, x: GHOST_X, z: GHOST_Z },
              note: 'No stale PokéRun-era actor matching the exact ghost signature is present in the live field.',
            })
          }
          return
        }

        cleanStableScans = 0
        console.info('[PokéRun lifecycle] GHOST ACTOR SCRUBBER MATCH', match.signature)
        const deleteTask = await scheduledDelete(runtimeBridge, probe, match.actor)
        await delay(150)
        const verify = await findGhost(runtimeBridge, probe)
        if (verify.actor) throw new Error(`Ghost actor still exists after DeleteActor at ${hex(verify.actor)}.`)

        done = true
        console.info('[PokéRun lifecycle] GHOST ACTOR SCRUBBER REMOVED', {
          removed: match.signature,
          deleteTask,
          nextStep: 'Use White 2 normal in-game Save, then fully reload. A clean save should log GHOST ACTOR SCRUBBER CLEAN instead of REMOVED.',
        })
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason)
        if (message !== lastError) {
          lastError = message
          console.info('[PokéRun resdiag] GHOST ACTOR SCRUBBER RESULT', { ok: false, reason: message })
        }
      } finally {
        busy = false
      }
    }

    void tick()
    const timer = window.setInterval(() => void tick(), 500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
