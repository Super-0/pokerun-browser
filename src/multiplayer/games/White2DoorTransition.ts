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
const FIELD_PROP_FIND_PROPS_IN_AREA = 0x02183e80
const FIELD_PROP_CREATE_HANDLE_FROM_EXISTING = 0x02183fe8
const FIELD_PROP_HOLDER_GET_POS_ABS = 0x02183fc4
const FIELD_PROP_HOLDER_CALL_ANM_CMD = 0x02183f90
const FIELD_PROP_HANDLE_FREE = 0x02184124
const FIELD_PROP_HANDLE_CALL_ANM_CMD = 0x02184150
const FIELD_PROP_HANDLE_IS_ANM_FINISHED = 0x02184174
const GFL_HEAP_FREE = 0x0203a278

const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000
const NATIVE_STACK_RESERVE = 0x1000
const DOOR_PROP_TYPE = 2
// White 2's own field effect code searches +/- 0x20000 FX32 around the
// relevant position for type-2 building props, so mirror that radius.
const DOOR_SEARCH_RADIUS_FX32 = 0x20000
const MAX_FOUND_PROPS = 0x20 // FindPropsInArea allocates a 0x80-byte pointer list.
const SCRATCH_SIZE = 0x30
const SCRATCH_OFFSET = 0xc0
const COUNT_OFFSET = 0x10
const POS_OFFSET = 0x14

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
 * White 2 already has all door models/resources loaded in the destination field.
 * We find the same type-2 prop class used by the game's field effects, create a
 * temporary per-prop handle, and ask White 2 to play animation 0. The handle is
 * later released after the native animation finishes. No map geometry or prop
 * resources are replaced by PokéRun.
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

  async playNearestDoor(world: MultiplayerWorldPosition): Promise<White2DoorAnimation> {
    const propSystem = await this.getPropSystem()

    return this.withScratch(async scratch => {
      const minZ = (signed32(world.z) - DOOR_SEARCH_RADIUS_FX32) >>> 0
      const maxZ = (signed32(world.z) + DOOR_SEARCH_RADIUS_FX32) >>> 0
      const minX = (signed32(world.x) - DOOR_SEARCH_RADIUS_FX32) >>> 0
      const maxX = (signed32(world.x) + DOOR_SEARCH_RADIUS_FX32) >>> 0
      // FieldPropAreaBounds is { minZ, maxZ, minX, maxX }.
      await Promise.all([
        this.bridge.write32(scratch + 0x00, minZ),
        this.bridge.write32(scratch + 0x04, maxZ),
        this.bridge.write32(scratch + 0x08, minX),
        this.bridge.write32(scratch + 0x0c, maxX),
        this.bridge.write32(scratch + COUNT_OFFSET, 0),
      ])

      let propsArray = 0
      try {
        propsArray = await this.call(
          FIELD_PROP_FIND_PROPS_IN_AREA,
          propSystem,
          scratch,
          DOOR_PROP_TYPE,
          scratch + COUNT_OFFSET,
          'FieldPropSystem_FindPropsInArea',
        )
        const rawCount = await this.bridge.read32(scratch + COUNT_OFFSET)
        const count = Math.min(rawCount >>> 0, MAX_FOUND_PROPS)
        if (!propsArray || count === 0 || !isMainRamPointer(propsArray)) return { matched: false, handle: null }

        let bestHolder = 0
        let bestDistance = Number.POSITIVE_INFINITY
        for (let index = 0; index < count; index += 1) {
          const holder = await this.bridge.read32(propsArray + index * 4)
          if (!isMainRamPointer(holder)) continue
          await this.call(FIELD_PROP_HOLDER_GET_POS_ABS, holder, scratch + POS_OFFSET, 0, 0, 'FieldChunkPropHolder_GetPosAbs')
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

        // A field can have all seven temporary prop handles occupied. In that
        // case still animate the matched static door resource rather than doing
        // nothing; there is simply no per-door handle to clean up later.
        await this.call(FIELD_PROP_HOLDER_CALL_ANM_CMD, propSystem, bestHolder, 0, 0, 'FieldChunkPropHolder_CallAnmCmd')
        return { matched: true, handle: null }
      } finally {
        if (propsArray && isMainRamPointer(propsArray)) {
          await this.call(GFL_HEAP_FREE, propsArray, 0, 0, 0, 'GFL_HeapFree').catch(() => undefined)
        }
      }
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
