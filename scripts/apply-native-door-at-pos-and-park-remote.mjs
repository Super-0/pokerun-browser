import fs from 'node:fs'

const doorPath = 'src/multiplayer/games/White2DoorTransition.ts'
const trainerPath = 'src/multiplayer/games/White2DedicatedTrainerRuntime.tsx'

const doorSource = `import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity, MultiplayerWorldPosition } from '../core/protocol'
import { White2ActorSystemProbe } from './White2ActorSystem'

// Exact Pokemon White 2 US (IRDO) symbols from the matched w2_us overlay-36 map.
const WHITE2_G_GAME_SYSTEM = 0x02141134
const GAME_SYSTEM_FIELD = 0x20
const FIELD_GET_G3D_MAPPER = 0x02180514
const FIELD_G3D_MAPPER_GET_BM_SYSTEM = 0x02185330
const FIELD_PROP_CREATE_HANDLE_AT_POS = 0x0218409c
const FIELD_PROP_HANDLE_FREE = 0x02184124
const FIELD_PROP_HANDLE_CALL_ANM_CMD = 0x02184150
const FIELD_PROP_HANDLE_IS_ANM_FINISHED = 0x02184174

const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000
const NATIVE_STACK_RESERVE = 0x1000
const PROP_SYSTEM_MAPPER = 0x04
const SCRATCH_SIZE = 0x20
const SCRATCH_OFFSET = 0xc0
const DOOR_PROP_ID = 1

export type White2DoorAnimation = {
  matched: boolean
  handle: number | null
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 0x3) === 0
}

function hex(value: number) {
  return \`0x\${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}\`
}

/**
 * Replays White 2's real entrance-door path.
 * The retail game does not classify doors by a generic prop type here; it calls
 * FieldPropSystem_CreateHandleAtPos(system, 1, position), then animation 0/command 0.
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
      throw new Error(\`\${label} native call failed with status \${result.status} at PC \${hex(result.pc)}.\`)
    }
    return result.result >>> 0
  }

  private async getPropSystem() {
    this.assertSupported()
    const gameSystem = await this.bridge.read32(WHITE2_G_GAME_SYSTEM)
    if (!isMainRamPointer(gameSystem)) throw new Error(\`White 2 GameSystem pointer is invalid (\${hex(gameSystem)}).\`)
    const field = await this.bridge.read32(gameSystem + GAME_SYSTEM_FIELD)
    if (!isMainRamPointer(field)) throw new Error(\`White 2 Field pointer is invalid (\${hex(field)}).\`)
    const mapper = await this.call(FIELD_GET_G3D_MAPPER, field, 0, 0, 0, 'Field_GetG3DMapper')
    if (!isMainRamPointer(mapper)) throw new Error(\`White 2 G3D mapper pointer is invalid (\${hex(mapper)}).\`)
    const propSystem = await this.call(FIELD_G3D_MAPPER_GET_BM_SYSTEM, mapper, 0, 0, 0, 'FieldG3DMapper_GetBMSystem')
    if (!isMainRamPointer(propSystem)) throw new Error(\`White 2 field-prop system pointer is invalid (\${hex(propSystem)}).\`)
    const ownerMapper = await this.bridge.read32(propSystem + PROP_SYSTEM_MAPPER)
    if (ownerMapper !== mapper) {
      throw new Error(\`White 2 field-prop system failed mapper back-pointer validation (\${hex(ownerMapper)} != \${hex(mapper)}).\`)
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

  async playNearestDoor(world: MultiplayerWorldPosition): Promise<White2DoorAnimation> {
    const propSystem = await this.getPropSystem()
    return this.withScratch(async scratch => {
      await Promise.all([
        this.bridge.write32(scratch + 0x00, world.x >>> 0),
        this.bridge.write32(scratch + 0x04, world.y >>> 0),
        this.bridge.write32(scratch + 0x08, world.z >>> 0),
      ])

      const handle = await this.call(
        FIELD_PROP_CREATE_HANDLE_AT_POS,
        propSystem,
        DOOR_PROP_ID,
        scratch,
        0,
        'FieldPropSystem_CreateHandleAtPos',
      )

      if (!isMainRamPointer(handle)) {
        console.info('[PokéRun door] HANDLE AT POS MISS', { propId: DOOR_PROP_ID, world })
        return { matched: false, handle: null }
      }

      console.info('[PokéRun door] HANDLE AT POS MATCH', { propId: DOOR_PROP_ID, handle: hex(handle), world })
      await this.call(FIELD_PROP_HANDLE_CALL_ANM_CMD, handle, 0, 0, 0, 'FieldPropHandle_CallAnmCmd')
      return { matched: true, handle }
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
`

fs.writeFileSync(doorPath, doorSource)

let trainer = fs.readFileSync(trainerPath, 'utf8')

if (!trainer.includes('const REMOTE_PARK_OFFSET_FX32')) {
  const anchor = 'const REMOTE_TELEPORT_SNAP_FX32 = 2 * 0x10000\n'
  if (!trainer.includes(anchor)) throw new Error('Remote teleport constant anchor not found.')
  trainer = trainer.replace(anchor, anchor + 'const REMOTE_PARK_OFFSET_FX32 = 32 * 0x10000\n')
}

if (!trainer.includes('async function parkRemoteActorOffscreen')) {
  const releaseAnchor = '    async function releaseActor('
  const index = trainer.indexOf(releaseAnchor)
  if (index < 0) throw new Error('releaseActor anchor not found.')
  const helper = `    async function parkRemoteActorOffscreen(current: DedicatedBinding) {\n      const [worldX, worldY, worldZ, gridX, gridY] = await Promise.all([\n        runtimeBridge.read32(current.actorAddress + ACTOR_WPOS + 0x00),\n        runtimeBridge.read32(current.actorAddress + ACTOR_WPOS + 0x04),\n        runtimeBridge.read32(current.actorAddress + ACTOR_WPOS + 0x08),\n        runtimeBridge.read16(current.actorAddress + ACTOR_GPOS + 0x00),\n        runtimeBridge.read16(current.actorAddress + ACTOR_GPOS + 0x04),\n      ])\n      const hiddenX = (signed32(worldX) + REMOTE_PARK_OFFSET_FX32) >>> 0\n      const hiddenZ = (signed32(worldZ) + REMOTE_PARK_OFFSET_FX32) >>> 0\n      await Promise.all([\n        runtimeBridge.write16(current.actorAddress + ACTOR_GPOS + 0x00, (gridX + 32) & 0xffff),\n        runtimeBridge.write16(current.actorAddress + ACTOR_GPOS + 0x04, (gridY + 32) & 0xffff),\n        runtimeBridge.write32(current.actorAddress + ACTOR_WPOS + 0x00, hiddenX),\n        runtimeBridge.write32(current.actorAddress + ACTOR_WPOS + 0x04, worldY >>> 0),\n        runtimeBridge.write32(current.actorAddress + ACTOR_WPOS + 0x08, hiddenZ),\n        runtimeBridge.write32(current.blActAddress + BLACT_POSITION + 0x00, hiddenX),\n        runtimeBridge.write32(current.blActAddress + BLACT_POSITION + 0x04, (signed32(worldY) + playerBillboardYOffset) >>> 0),\n        runtimeBridge.write32(current.blActAddress + BLACT_POSITION + 0x08, hiddenZ),\n      ])\n      renderedWorld = { x: hiddenX, y: worldY >>> 0, z: hiddenZ }\n      lastRenderAdvanceAt = Date.now()\n      console.info('[PokéRun lifecycle] PARK REMOTE • DIFFERENT MAP', { actor: current.actorAddress })\n    }\n\n`
  trainer = trainer.slice(0, index) + helper + trainer.slice(index)
}

const mismatchStart = '      if (local.location.mapId !== remote.location.mapId) {'
const mismatchIndex = trainer.indexOf(mismatchStart)
if (mismatchIndex < 0) throw new Error('Remote-map mismatch branch not found.')
const mismatchEndMarker = '      const currentMapId = local.location.mapId\n'
const mismatchEnd = trainer.indexOf(mismatchEndMarker, mismatchIndex)
if (mismatchEnd < 0) throw new Error('Remote-map mismatch branch end not found.')

const mismatchReplacement = `      if (local.location.mapId !== remote.location.mapId) {\n        // Keep the dedicated actor owned by this still-loaded local field. Native\n        // deletion can briefly reveal its underlying NPC renderer; parking it\n        // off-camera avoids that flash and lets us reuse the same actor when P2\n        // returns, just like same-map distance retention.\n        stableMapId = local.location.mapId\n        stableMapSince = now\n        if (binding) {\n          await parkRemoteActorOffscreen(binding)\n          rangeLatched = true\n        } else {\n          rangeLatched = false\n        }\n        return\n      }\n\n`

trainer = trainer.slice(0, mismatchIndex) + mismatchReplacement + trainer.slice(mismatchEnd)
fs.writeFileSync(trainerPath, trainer)

console.log('Replaced door scanning with White 2 CreateHandleAtPos(propId=1) and parked remote actors across remote-only map changes.')
