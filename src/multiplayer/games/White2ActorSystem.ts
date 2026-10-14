import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../core/protocol'
import { TESTED_WHITE2_SHA256 } from './White2LiveStateAdapter'

// Pokémon White 2 (IRDO) symbols/struct layout from the public Swan reverse-engineering headers.
// This probe is intentionally read-only: native actor creation is not enabled until we validate
// the live actor heap and a safe creation/destruction path on the exact tested ROM revision.
const WHITE2_G_GAME_SYSTEM = 0x02141134

// Swan GameSystem layout:
// 0x18 CurrentEvent, 0x1C m_GameData, 0x20 m_Field.
// Keep this explicit because confusing m_Field for m_GameData can still produce
// plausible-looking pointers before failing later in the actor-system chain.
const GAME_SYSTEM_GAME_DATA = 0x1c
const GAME_DATA_ACTOR_SYSTEM = 0x1a8

const ACTOR_SYSTEM_CAPACITY = 0x04
const ACTOR_SYSTEM_COUNT = 0x06
const ACTOR_SYSTEM_HEAP = 0x1c

const FIELD_ACTOR_SIZE = 0x100
const ACTOR_FLAGS = 0x00
const ACTOR_UID = 0x08
const ACTOR_ZONE_ID = 0x0a
const ACTOR_MODEL_ID = 0x0c
const ACTOR_FACE_DIR = 0x18
const ACTOR_GPOS = 0x3c

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

export type White2ActorSystemSnapshot = {
  gameSystem: number
  gameData: number
  actorSystem: number
  actorHeap: number
  capacity: number
  count: number
  playerActor: White2ActorSummary | null
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 0x3) === 0
}

function hex(value: number) {
  return `0x${value.toString(16).padStart(8, '0').toUpperCase()}`
}

/**
 * Read-only discovery of White 2's live FieldActorSystem.
 *
 * Swan documents GameSystem -> GameData -> FieldActorSystem and a 0x100-byte
 * FieldActor layout. The probe validates every pointer before walking the heap
 * and only exposes diagnostics. It never writes to emulated RAM.
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
    const height = rawHeight & 0x8000 ? rawHeight - 0x10000 : rawHeight
    return { index, address, flags, uid, zoneId, modelId, faceDir, x, height, y }
  }
}
