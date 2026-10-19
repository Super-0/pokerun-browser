import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity, MultiplayerWorldPosition } from '../core/protocol'
import { White2ActorSystemProbe } from './White2ActorSystem'

// Exact Pokémon White 2 US (IRDO) field/prop symbols. This module is only used
// behind White2ActorSystemProbe.supportsRom(), so none of these addresses are
// allowed to run against an unverified revision.
const WHITE2_G_GAME_SYSTEM = 0x02141134
const GAME_SYSTEM_FIELD = 0x20
const FIELD_GET_G3D_MAPPER = 0x02180514
const FIELD_G3D_MAPPER_GET_BM_SYSTEM = 0x02185330
const FIELD_PROP_HOLDER_GET_PROP_TYPE = 0x02183f68
const FIELD_PROP_CREATE_HANDLE_FROM_EXISTING = 0x02183fe8
const FIELD_PROP_HOLDER_GET_POS_ABS = 0x02183fc4
const FIELD_PROP_HOLDER_CALL_ANM_CMD = 0x02183f90
const FIELD_PROP_HANDLE_FREE = 0x02184124
const FIELD_PROP_HANDLE_CALL_ANM_CMD = 0x02184150
const FIELD_PROP_HANDLE_IS_ANM_FINISHED = 0x02184174

const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000
const NATIVE_STACK_RESERVE = 0x1000
const DOOR_PROP_TYPE = 2

// Swan's FieldPropSystem layout for White 2:
//   +0x04 m_G3DMapper
//   +0x268 m_ChunkPropHolders[288]
// Each FieldChunkPropHolder is 0x10 bytes and +0x0C is m_PropInstance.
const PROP_SYSTEM_MAPPER = 0x04
const PROP_SYSTEM_HOLDERS = 0x268
const PROP_HOLDER_SIZE = 0x10
const PROP_HOLDER_INSTANCE = 0x0c
const PROP_HOLDER_COUNT = 288

// One overworld tile is 0x10000 FX32 in the tested field. A building-model
// origin can sit several tiles away from its visible doorway, so do not require
// the old +/-2-tile area match. Still reject a type-2 prop that is implausibly
// far away so non-door warps cannot open an unrelated building across the map.
const MAX_DOOR_ORIGIN_DISTANCE_FX32 = 0x80000
const SCRATCH_SIZE = 0x20
const SCRATCH_OFFSET = 0xc0
const POS_OFFSET = 0x00

export type White2DoorAnimation = {
  matched: boolean
  handle: number | null
}

function signed32(value: number) {
  return value | 0
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 0x3) === 0
}

function hex(value: number) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

/**
 * Replays the native building-door prop animation near a remote map transition.
 *
 * White 2 keeps a fixed array of loaded FieldChunkPropHolders. We inspect that
 * native array directly instead of relying on a small area search around the
 * player's feet: a building prop's origin can be several tiles away from the
 * visible door. Only White 2's type-2 prop class is eligible, and a generous but
 * bounded distance check prevents unrelated map props from being animated.
 */
export class White2DoorTransitionPlayer {
  constructor(private readonly bridge: MelonDsBridge, private readonly rom: MultiplayerRomIdentity) {}

  private assertSupported() {
    if (!White2ActorSystemProbe.supportsRom(this.rom)) {
      throw new Error('White 2 door transitions are only enabled for the exact tested ROM fingerprint.')
    }
  }

  private async call(functionAddress: number, r0: number, r1: number, r2: number, r3: number, label: string) {
    const result = await this.bridge.callArm9Thumb4(functionAddress, r0, r1, r2, r3, NATIVE_STACK_RESERVE)
    if (result.status !== 1) {
      throw new Error(`${label} native call failed with status ${result.status} at PC ${hex(result.pc)}.`)
    }
    return result.result >>> 0
  }

  private async getPropSystem() {
    this.assertSupported()
    const gameSystem = await this.bridge.read32(WHITE2_G_GAME_SYSTEM)
    if (!isMainRamPointer(gameSystem)) throw new Error(`White 2 GameSystem pointer is invalid (${hex(gameSystem)}).`)
    const field = await this.bridge.read32(gameSystem + GAME_SYSTEM_FIELD)
    if (!isMainRamPointer(field)) throw new Error(`White 2 Field pointer is invalid (${hex(field)}).`)
    const mapper = await this.call(FIELD_GET_G3D_MAPPER, field, 0, 0, 0, 'Field_GetG3DMapper')
    if (!isMainRamPointer(mapper)) throw new Error(`White 2 G3D mapper pointer is invalid (${hex(mapper)}).`)
    const propSystem = await this.call(FIELD_G3D_MAPPER_GET_BM_SYSTEM, mapper, 0, 0, 0, 'FieldG3DMapper_GetBMSystem')
    if (!isMainRamPointer(propSystem)) throw new Error(`White 2 field-prop system pointer is invalid (${hex(propSystem)}).`)

    // Swan documents FieldPropSystem::m_G3DMapper at +0x04. Validate the native
    // getter before we ever walk the holder array; this catches a bad symbol or
    // wrong intermediate object without touching unrelated RAM.
    const ownerMapper = await this.bridge.read32(propSystem + PROP_SYSTEM_MAPPER)
    if (ownerMapper !== mapper) {
      throw new Error(`White 2 field-prop system failed mapper back-pointer validation (${hex(ownerMapper)} != ${hex(mapper)}).`)
    }
    return propSystem
  }

  private async withScratch<T>(callback: (address: number) => Promise<T>) {
    const scan = await new White2ActorSystemProbe(this.bridge).scanHeap()
    const free = [...scan.entries].reverse().find(entry => entry.state === 'zeroed')
    if (!free) throw new Error('White 2 door transition needs one zeroed actor slot for temporary native-call scratch.')
    const address = free.address + SCRATCH_OFFSET
    if (address + SCRATCH_SIZE > free.address + 0x100) throw new Error('White 2 door-transition scratch exceeds its reserved free actor slot.')
    const original = await this.bridge.readBytes(address, SCRATCH_SIZE)
    try {
      return await callback(address)
    } finally {
      await this.bridge.writeBytes(address, original)
    }
  }

  private async findNearestLoadedDoor(propSystem: number, world: MultiplayerWorldPosition, scratch: number) {
    let loadedCount = 0
    let type2Count = 0
    let bestHolder = 0
    let bestDistance = Number.POSITIVE_INFINITY

    for (let index = 0; index < PROP_HOLDER_COUNT; index += 1) {
      const holder = propSystem + PROP_SYSTEM_HOLDERS + index * PROP_HOLDER_SIZE
      const propInstance = await this.bridge.read32(holder + PROP_HOLDER_INSTANCE)
      if (!isMainRamPointer(propInstance)) continue
      loadedCount += 1

      const propType = await this.call(
        FIELD_PROP_HOLDER_GET_PROP_TYPE,
        holder,
        0,
        0,
        0,
        'FieldChunkPropHolder_GetPropType',
      )
      if (propType !== DOOR_PROP_TYPE) continue
      type2Count += 1

      await this.call(
        FIELD_PROP_HOLDER_GET_POS_ABS,
        holder,
        scratch + POS_OFFSET,
        0,
        0,
        'FieldChunkPropHolder_GetPosAbs',
      )
      const [x, z] = await Promise.all([
        this.bridge.read32(scratch + POS_OFFSET + 0x00),
        this.bridge.read32(scratch + POS_OFFSET + 0x08),
      ])
      const distance = Math.abs(signed32(x) - signed32(world.x)) + Math.abs(signed32(z) - signed32(world.z))
      if (distance < bestDistance) {
        bestDistance = distance
        bestHolder = holder
      }
    }

    if (!bestHolder || bestDistance > MAX_DOOR_ORIGIN_DISTANCE_FX32) {
      console.debug('[PokéRun] White 2 door lookup found no nearby type-2 prop.', {
        loadedCount,
        type2Count,
        nearestDistanceFx32: Number.isFinite(bestDistance) ? bestDistance : null,
        remoteWorld: world,
      })
      return 0
    }

    console.debug('[PokéRun] White 2 door lookup selected loaded type-2 prop.', {
      loadedCount,
      type2Count,
      distanceFx32: bestDistance,
      holder: hex(bestHolder),
      remoteWorld: world,
    })
    return bestHolder
  }

  async playNearestDoor(world: MultiplayerWorldPosition): Promise<White2DoorAnimation> {
    const propSystem = await this.getPropSystem()

    return this.withScratch(async scratch => {
      const bestHolder = await this.findNearestLoadedDoor(propSystem, world, scratch)
      if (!bestHolder) return { matched: false, handle: null }

      const handle = await this.call(
        FIELD_PROP_CREATE_HANDLE_FROM_EXISTING,
        propSystem,
        bestHolder,
        0,
        0,
        'FieldPropSystem_CreateHandleFromExisting',
      )
      if (isMainRamPointer(handle)) {
        await this.call(FIELD_PROP_HANDLE_CALL_ANM_CMD, handle, 0, 0, 0, 'FieldPropHandle_CallAnmCmd')
        return { matched: true, handle }
      }

      // A field can have all seven temporary prop handles occupied. In that case
      // still animate the matched static resource; there is simply no per-door
      // handle to service/free later.
      await this.call(FIELD_PROP_HOLDER_CALL_ANM_CMD, propSystem, bestHolder, 0, 0, 'FieldChunkPropHolder_CallAnmCmd')
      return { matched: true, handle: null }
    })
  }

  async isAnimationFinished(handle: number) {
    if (!isMainRamPointer(handle)) return true
    return (await this.call(FIELD_PROP_HANDLE_IS_ANM_FINISHED, handle, 0, 0, 0, 'FieldPropHandle_IsAnmFinished')) !== 0
  }

  async freeHandle(handle: number) {
    if (!isMainRamPointer(handle)) return
    await this.call(FIELD_PROP_HANDLE_FREE, handle, 0, 0, 0, 'FieldPropHandle_Free')
  }
}
