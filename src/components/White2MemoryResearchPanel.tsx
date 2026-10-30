import { useEffect } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2ActorSystemProbe } from '../multiplayer/games/White2ActorSystem'
import { POKERUN_NATIVE_TEST_UID } from '../multiplayer/games/White2NativeActor'

// FieldActor offsets from the White 2 decomp/reconstruction.
const ACTOR_FLAGS = 0x00
const ACTOR_MOVEMENT_FLAGS = 0x04
const ACTOR_UID = 0x08
const ACTOR_ZONE_ID = 0x0a
const ACTOR_MODEL_ID = 0x0c
const ACTOR_MOVE_CODE = 0x0e
const ACTOR_EVENT_TYPE = 0x10
const ACTOR_SPAWN_FLAG = 0x12
const ACTOR_SCRIPT_ID = 0x14
const ACTOR_DEFAULT_DIR = 0x16
const ACTOR_FACE_DIR = 0x18
const ACTOR_USER_PARAM_0 = 0x20
const ACTOR_USER_PARAM_1 = 0x22
const ACTOR_USER_PARAM_2 = 0x24
const ACTOR_DRAW_STATUS = 0x2a
const ACTOR_AREA_WIDTH = 0x2c
const ACTOR_AREA_HEIGHT = 0x2e
const ACTOR_WPOS = 0x44
const ACTOR_TCB = 0x84
const ACTOR_MOVE_CODE_VTABLE = 0x8c
const ACTOR_POSITION_WORK = 0x94
const ACTOR_POSITION_WORK_SIZE = 0x10

// White 2's native field-communication actor recipe.
// FIELD_COMM_ACTOR_NPC uses UID 0xFC and MOVE_CODE_COMM_ACTOR (0x44).
const NATIVE_COMM_UID = 0x00fc
const MOVE_CODE_COMM_ACTOR = 0x44
const NATIVE_COMM_SCRIPT_ID = 0x07d0
const NATIVE_COMM_AREA_WIDTH = 4
const NATIVE_COMM_AREA_HEIGHT = 4

// Set by FieldCommActor_Add in this order:
//   FldAct_SetHeightCalcDisabled(TRUE) -> actor flag 0x200
//   FldAct_SetMapAttrDisabled(TRUE)     -> actor flag 0x400
//   SetActorFlag32(TRUE)               -> actor flag 0x20
//   SetActorCollisionEnabled(FALSE)     -> actor flag 0x80
//   FldAct_SetIgnoreDisableAll(TRUE)    -> movement flag 0x80000
//   FldAct_SetMoveBitAttrEffectOff(TRUE)-> movement flag 0x100000
const FLAG_PERSISTENT = 0x00000020
const FLAG_COLLISION_DISABLED = 0x00000080
const FLAG_HEIGHT_CALC_DISABLED = 0x00000200
const FLAG_MAP_ATTR_DISABLED = 0x00000400
const MOVE_FLAG_IGNORE_DISABLE_ALL = 0x00080000
const MOVE_FLAG_ATTR_EFFECT_OFF = 0x00100000

const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000
const POLL_MS = 150
const STABLE_MS = 700

function hex(value: number) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

function signed32(value: number) {
  return value | 0
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 3) === 0
}

function hasBit(value: number, bit: number) {
  return ((value >>> 0) & (bit >>> 0)) !== 0
}

function missingActorFlags(flags: number) {
  const missing: string[] = []
  if (!hasBit(flags, FLAG_PERSISTENT)) missing.push('0x20 SetActorFlag32 / persistent')
  if (!hasBit(flags, FLAG_COLLISION_DISABLED)) missing.push('0x80 collision disabled')
  if (!hasBit(flags, FLAG_HEIGHT_CALC_DISABLED)) missing.push('0x200 height calculation disabled')
  if (!hasBit(flags, FLAG_MAP_ATTR_DISABLED)) missing.push('0x400 map attributes disabled')
  return missing
}

function missingMovementFlags(flags: number) {
  const missing: string[] = []
  if (!hasBit(flags, MOVE_FLAG_IGNORE_DISABLE_ALL)) missing.push('0x80000 ignore DisableAll')
  if (!hasBit(flags, MOVE_FLAG_ATTR_EFFECT_OFF)) missing.push('0x100000 movement terrain effects disabled')
  return missing
}

async function captureRemoteParity(bridge: MelonDsBridge, actorAddress: number) {
  const [
    flags,
    movementFlags,
    uid,
    zoneId,
    modelId,
    moveCode,
    eventType,
    spawnFlag,
    scriptId,
    defaultDir,
    faceDir,
    userParam0,
    userParam1,
    userParam2,
    drawStatus,
    areaWidth,
    areaHeight,
    worldX,
    worldY,
    worldZ,
    tcb,
    moveCodeVTable,
    positionWorkBytes,
  ] = await Promise.all([
    bridge.read32(actorAddress + ACTOR_FLAGS),
    bridge.read32(actorAddress + ACTOR_MOVEMENT_FLAGS),
    bridge.read16(actorAddress + ACTOR_UID),
    bridge.read16(actorAddress + ACTOR_ZONE_ID),
    bridge.read16(actorAddress + ACTOR_MODEL_ID),
    bridge.read16(actorAddress + ACTOR_MOVE_CODE),
    bridge.read16(actorAddress + ACTOR_EVENT_TYPE),
    bridge.read16(actorAddress + ACTOR_SPAWN_FLAG),
    bridge.read16(actorAddress + ACTOR_SCRIPT_ID),
    bridge.read16(actorAddress + ACTOR_DEFAULT_DIR),
    bridge.read16(actorAddress + ACTOR_FACE_DIR),
    bridge.read16(actorAddress + ACTOR_USER_PARAM_0),
    bridge.read16(actorAddress + ACTOR_USER_PARAM_1),
    bridge.read16(actorAddress + ACTOR_USER_PARAM_2),
    bridge.read16(actorAddress + ACTOR_DRAW_STATUS),
    bridge.read16(actorAddress + ACTOR_AREA_WIDTH),
    bridge.read16(actorAddress + ACTOR_AREA_HEIGHT),
    bridge.read32(actorAddress + ACTOR_WPOS + 0x00),
    bridge.read32(actorAddress + ACTOR_WPOS + 0x04),
    bridge.read32(actorAddress + ACTOR_WPOS + 0x08),
    bridge.read32(actorAddress + ACTOR_TCB),
    bridge.read32(actorAddress + ACTOR_MOVE_CODE_VTABLE),
    bridge.readBytes(actorAddress + ACTOR_POSITION_WORK, ACTOR_POSITION_WORK_SIZE),
  ])

  const workView = new DataView(positionWorkBytes.buffer, positionWorkBytes.byteOffset, positionWorkBytes.byteLength)
  const positionWork = [0, 4, 8, 12].map(offset => workView.getUint32(offset, true))
  const linkedPointerCount = positionWork.filter(isMainRamPointer).length

  const checks = {
    nativeCommUid: uid === NATIVE_COMM_UID,
    nativeCommMoveCode: moveCode === MOVE_CODE_COMM_ACTOR,
    nativeCommScriptId: scriptId === NATIVE_COMM_SCRIPT_ID,
    nativeCommArea: areaWidth === NATIVE_COMM_AREA_WIDTH && areaHeight === NATIVE_COMM_AREA_HEIGHT,
    persistentFlag: hasBit(flags, FLAG_PERSISTENT),
    collisionDisabled: hasBit(flags, FLAG_COLLISION_DISABLED),
    heightCalcDisabled: hasBit(flags, FLAG_HEIGHT_CALC_DISABLED),
    mapAttrDisabled: hasBit(flags, FLAG_MAP_ATTR_DISABLED),
    ignoreDisableAll: hasBit(movementFlags, MOVE_FLAG_IGNORE_DISABLE_ALL),
    moveBitAttrEffectOff: hasBit(movementFlags, MOVE_FLAG_ATTR_EFFECT_OFF),
    nativeFourPointerWorkBlockShape: linkedPointerCount === 4,
    nativeUpdaterStillAttached: tcb !== 0,
  }

  return {
    current: {
      actor: hex(actorAddress),
      uid: { value: uid, hex: hex(uid) },
      zoneId,
      modelId,
      moveCode: { value: moveCode, hex: hex(moveCode) },
      eventType,
      spawnFlag,
      scriptId: { value: scriptId, hex: hex(scriptId) },
      defaultDir,
      faceDir,
      userParams: [userParam0, userParam1, userParam2],
      drawStatus,
      area: { width: areaWidth, height: areaHeight },
      world: { x: signed32(worldX), y: signed32(worldY), z: signed32(worldZ) },
      flags: hex(flags),
      movementFlags: hex(movementFlags),
      tcb: hex(tcb),
      moveCodeVTable: hex(moveCodeVTable),
      positionWork: positionWork.map((value, index) => ({
        slot: index,
        offset: `+0x${(ACTOR_POSITION_WORK + index * 4).toString(16).toUpperCase()}`,
        value: hex(value),
        plausibleMainRamPointer: isMainRamPointer(value),
      })),
    },
    nativeWhite2Recipe: {
      source: 'src/ov036/field_comm_actor.c :: FIELD_COMM_ACTOR_NPC + FieldCommActor_Add',
      uid: hex(NATIVE_COMM_UID),
      moveCode: { value: MOVE_CODE_COMM_ACTOR, hex: hex(MOVE_CODE_COMM_ACTOR), name: 'MOVE_CODE_COMM_ACTOR' },
      eventType: 0,
      spawnFlag: 0,
      scriptId: hex(NATIVE_COMM_SCRIPT_ID),
      defaultDir: 0,
      userParams: [0, 0, 0],
      area: { width: NATIVE_COMM_AREA_WIDTH, height: NATIVE_COMM_AREA_HEIGHT },
      positionWork: [
        'pointer to remote direction (u16*)',
        'pointer to remote world position (VecFx32*)',
        'pointer to remote hidden state (u32*)',
        'pointer to FldCommActEntry',
      ],
      actorFlagsRequired: {
        persistent: hex(FLAG_PERSISTENT),
        collisionDisabled: hex(FLAG_COLLISION_DISABLED),
        heightCalcDisabled: hex(FLAG_HEIGHT_CALC_DISABLED),
        mapAttrDisabled: hex(FLAG_MAP_ATTR_DISABLED),
      },
      movementFlagsRequired: {
        ignoreDisableAll: hex(MOVE_FLAG_IGNORE_DISABLE_ALL),
        moveBitAttrEffectOff: hex(MOVE_FLAG_ATTR_EFFECT_OFF),
      },
      ownership: 'native FieldActor updater remains attached and FieldCommActor_Move consumes the four live pointers each frame',
    },
    checks,
    missing: {
      actorFlags: missingActorFlags(flags),
      movementFlags: missingMovementFlags(movementFlags),
      templateFields: [
        ...(uid === NATIVE_COMM_UID ? [] : [`UID ${hex(uid)} vs native ${hex(NATIVE_COMM_UID)}`]),
        ...(moveCode === MOVE_CODE_COMM_ACTOR ? [] : [`moveCode ${hex(moveCode)} vs native ${hex(MOVE_CODE_COMM_ACTOR)}`]),
        ...(scriptId === NATIVE_COMM_SCRIPT_ID ? [] : [`scriptId ${hex(scriptId)} vs native ${hex(NATIVE_COMM_SCRIPT_ID)}`]),
        ...(areaWidth === NATIVE_COMM_AREA_WIDTH && areaHeight === NATIVE_COMM_AREA_HEIGHT
          ? []
          : [`area ${areaWidth}x${areaHeight} vs native ${NATIVE_COMM_AREA_WIDTH}x${NATIVE_COMM_AREA_HEIGHT}`]),
        ...(linkedPointerCount === 4 ? [] : [`position work has ${linkedPointerCount}/4 plausible live RAM pointers`]),
        ...(tcb !== 0 ? [] : ['native updater TCB is detached']),
      ],
    },
    interpretation: {
      currentArchitecture: 'generic actor + detached native updater + PokéRun-owned movement/render playback',
      nativeArchitecture: 'MOVE_CODE_COMM_ACTOR + four live state pointers + White 2-owned movement/draw/visibility update',
      nextDecision: 'Use this parity report to decide which native comm-actor behaviors to reproduce/adopt in one-variable experiments.',
    },
  }
}

/**
 * Probe 4: read-only comparison between PokéRun's injected remote FieldActor and
 * White 2's own field-communication actor recipe. No emulated memory is written.
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
        const remotes = scan.entries.filter(entry => entry.uid === POKERUN_NATIVE_TEST_UID)
        const remote = remotes.length === 1 ? remotes[0] : null
        if (!remote) {
          readyKey = ''
          readySince = 0
          return
        }

        const key = `${scan.actorSystem}:${remote.address}:${remote.modelId}:${remote.tcb}`
        if (key !== readyKey) {
          readyKey = key
          readySince = performance.now()
          return
        }
        if (capturedKey === key || performance.now() - readySince < STABLE_MS) return

        const report = await captureRemoteParity(runtimeBridge, remote.address)
        capturedKey = key
        console.info('[PokéRun resdiag] NATIVE COMM ACTOR PARITY', report)
      } catch (reason) {
        console.info('[PokéRun resdiag] PROBE 4 WAITING', {
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
