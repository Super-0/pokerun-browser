import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../core/protocol'
import { TESTED_WHITE2_SHA256 } from './White2LiveStateAdapter'

// Pokémon White 2 (IRDO) symbols/struct layout from the public Swan reverse-engineering headers.
// This module stays read-only until we have identified a genuinely unused actor slot or a safe
// native creation/destruction path on the exact tested ROM fingerprint.
const WHITE2_G_GAME_SYSTEM = 0x02141134

// Swan GameSystem layout:
// 0x18 CurrentEvent, 0x1C m_GameData, 0x20 m_Field.
const GAME_SYSTEM_GAME_DATA = 0x1c
const GAME_DATA_ACTOR_SYSTEM = 0x1a8

const ACTOR_SYSTEM_CAPACITY = 0x04
const ACTOR_SYSTEM_COUNT = 0x06
const ACTOR_SYSTEM_HEAP = 0x1c

const FIELD_ACTOR_SIZE = 0x100
const ACTOR_FLAGS = 0x00
const ACTOR_MOVEMENT_FLAGS = 0x04
const ACTOR_UID = 0x08
const ACTOR_ZONE_ID = 0x0a
const ACTOR_MODEL_ID = 0x0c
const ACTOR_FACE_DIR = 0x18
const ACTOR_GPOS = 0x3c
// Offsets below come directly from the Swan FieldActor layout after the tile/model fields.
const ACTOR_TCB = 0x80
const ACTOR_SYSTEM_BACKPTR = 0x84
const ACTOR_MOVE_CODE_VTABLE = 0x88
const ACTOR_SCENE_NODE_VTABLE = 0x8c

const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000
const PLAYER_ACTOR_UID = 0x00ff

export type White2ActorSummary = {
  index: number
  address: number
  flags: number
  uid: number
  zoneId: number
  modelId: number
  faceDir: number
  x: number
  height: number
  y: number
}

export type White2ActorSlotState = 'player' | 'active' | 'zeroed' | 'detached' | 'suspicious'

export type White2ActorHeapEntry = White2ActorSummary & {
  movementFlags: number
  tcb: number
  actorSystemBackptr: number
  moveCodeVTable: number
  sceneNodeVTable: number
  state: White2ActorSlotState
}

export type White2ActorSystemSnapshot = {
  gameSystem: number
  gameData: number
  actorSystem: number
  actorHeap: number
  capacity: number
  count: number
  playerActor: White2ActorSummary | null
}

export type White2ActorHeapScan = White2ActorSystemSnapshot & {
  entries: White2ActorHeapEntry[]
  playerSlots: number[]
  activeSlots: number[]
  zeroedSlots: number[]
  detachedSlots: number[]
  suspiciousSlots: number[]
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 0x3) === 0
}

function hex(value: number) {
  return `0x${value.toString(16).padStart(8, '0').toUpperCase()}`
}

function signed16(value: number) {
  return value & 0x8000 ? value - 0x10000 : value
}

/**
 * Read-only discovery of White 2's live FieldActorSystem.
 *
 * Swan documents GameSystem -> GameData -> FieldActorSystem and a 0x100-byte
 * FieldActor layout. Pointer validation happens before any heap walk. No writes
 * are exposed from this class.
 */
export class White2ActorSystemProbe {
  constructor(private readonly bridge: MelonDsBridge) {}

  static supportsRom(rom: MultiplayerRomIdentity) {
    return rom.gameId === 'white2' && rom.sha256?.toLowerCase() === TESTED_WHITE2_SHA256
  }

  async inspect(): Promise<White2ActorSystemSnapshot> {
    const gameSystem = await this.bridge.read32(WHITE2_G_GAME_SYSTEM)
    if (!isMainRamPointer(gameSystem)) throw new Error(`White 2 GameSystem pointer is invalid (${hex(gameSystem)}).`)

    const gameData = await this.bridge.read32(gameSystem + GAME_SYSTEM_GAME_DATA)
    if (!isMainRamPointer(gameData)) throw new Error(`White 2 GameData pointer is invalid (${hex(gameData)}).`)

    const actorSystem = await this.bridge.read32(gameData + GAME_DATA_ACTOR_SYSTEM)
    if (!isMainRamPointer(actorSystem)) throw new Error(`White 2 actor-system pointer is invalid (${hex(actorSystem)}).`)

    const [capacity, count, actorHeap] = await Promise.all([
      this.bridge.read16(actorSystem + ACTOR_SYSTEM_CAPACITY),
      this.bridge.read16(actorSystem + ACTOR_SYSTEM_COUNT),
      this.bridge.read32(actorSystem + ACTOR_SYSTEM_HEAP),
    ])

    if (capacity < 1 || capacity > 64) throw new Error(`White 2 actor capacity is outside the expected range (${capacity}).`)
    if (count > capacity) throw new Error(`White 2 actor count ${count} exceeds capacity ${capacity}.`)
    if (!isMainRamPointer(actorHeap)) throw new Error(`White 2 actor-heap pointer is invalid (${hex(actorHeap)}).`)
    if (actorHeap + capacity * FIELD_ACTOR_SIZE > MAIN_RAM_END) throw new Error('White 2 actor heap extends outside main RAM.')

    let playerActor: White2ActorSummary | null = null
    for (let index = 0; index < capacity; index += 1) {
      const address = actorHeap + index * FIELD_ACTOR_SIZE
      const uid = await this.bridge.read16(address + ACTOR_UID)
      if (uid !== PLAYER_ACTOR_UID) continue
      playerActor = await this.readActor(index, address, uid)
      break
    }

    return { gameSystem, gameData, actorSystem, actorHeap, capacity, count, playerActor }
  }

  /**
   * One-shot inventory of every allocated FieldActor slot. This deliberately is
   * not part of the 1 Hz probe because it performs substantially more bus reads.
   * "zeroed" is a strong free-slot candidate, not permission to write to it.
   */
  async scanHeap(): Promise<White2ActorHeapScan> {
    const snapshot = await this.inspect()
    const entries: White2ActorHeapEntry[] = []

    for (let index = 0; index < snapshot.capacity; index += 1) {
      const address = snapshot.actorHeap + index * FIELD_ACTOR_SIZE
      entries.push(await this.readHeapEntry(index, address, snapshot.actorSystem))
    }

    const slots = (state: White2ActorSlotState) => entries.filter(entry => entry.state === state).map(entry => entry.index)
    return {
      ...snapshot,
      entries,
      playerSlots: slots('player'),
      activeSlots: slots('active'),
      zeroedSlots: slots('zeroed'),
      detachedSlots: slots('detached'),
      suspiciousSlots: slots('suspicious'),
    }
  }

  private async readActor(index: number, address: number, uid: number): Promise<White2ActorSummary> {
    const [flags, zoneId, modelId, faceDir, x, rawHeight, y] = await Promise.all([
      this.bridge.read32(address + ACTOR_FLAGS),
      this.bridge.read16(address + ACTOR_ZONE_ID),
      this.bridge.read16(address + ACTOR_MODEL_ID),
      this.bridge.read16(address + ACTOR_FACE_DIR),
      this.bridge.read16(address + ACTOR_GPOS + 0x00),
      this.bridge.read16(address + ACTOR_GPOS + 0x02),
      this.bridge.read16(address + ACTOR_GPOS + 0x04),
    ])
    return { index, address, flags, uid, zoneId, modelId, faceDir, x, height: signed16(rawHeight), y }
  }

  private async readHeapEntry(index: number, address: number, actorSystem: number): Promise<White2ActorHeapEntry> {
    const [flags, movementFlags, uid, zoneId, modelId, faceDir, x, rawHeight, y, tcb, actorSystemBackptr, moveCodeVTable, sceneNodeVTable] = await Promise.all([
      this.bridge.read32(address + ACTOR_FLAGS),
      this.bridge.read32(address + ACTOR_MOVEMENT_FLAGS),
      this.bridge.read16(address + ACTOR_UID),
      this.bridge.read16(address + ACTOR_ZONE_ID),
      this.bridge.read16(address + ACTOR_MODEL_ID),
      this.bridge.read16(address + ACTOR_FACE_DIR),
      this.bridge.read16(address + ACTOR_GPOS + 0x00),
      this.bridge.read16(address + ACTOR_GPOS + 0x02),
      this.bridge.read16(address + ACTOR_GPOS + 0x04),
      this.bridge.read32(address + ACTOR_TCB),
      this.bridge.read32(address + ACTOR_SYSTEM_BACKPTR),
      this.bridge.read32(address + ACTOR_MOVE_CODE_VTABLE),
      this.bridge.read32(address + ACTOR_SCENE_NODE_VTABLE),
    ])

    const height = signed16(rawHeight)
    const runtimePointersZero = tcb === 0 && actorSystemBackptr === 0 && moveCodeVTable === 0 && sceneNodeVTable === 0
    const keyDataZero = flags === 0 && movementFlags === 0 && uid === 0 && zoneId === 0 && modelId === 0 && faceDir === 0 && x === 0 && rawHeight === 0 && y === 0

    let state: White2ActorSlotState
    if (uid === PLAYER_ACTOR_UID && actorSystemBackptr === actorSystem) state = 'player'
    else if (runtimePointersZero && keyDataZero) state = 'zeroed'
    else if (runtimePointersZero) state = 'detached'
    else if (actorSystemBackptr === actorSystem) state = 'active'
    else state = 'suspicious'

    return { index, address, flags, movementFlags, uid, zoneId, modelId, faceDir, x, height, y, tcb, actorSystemBackptr, moveCodeVTable, sceneNodeVTable, state }
  }
}
