import { useState } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2ActorSystemProbe, type White2ActorHeapEntry } from '../multiplayer/games/White2ActorSystem'
import { PixelButton } from './PixelButton'

const ACTOR_SYSTEM_FIELD_BLACT = 0x28
const ACTOR_WPOS = 0x44
const ACTOR_CONFIG = 0xe4

const FIELD_BLACT_SYSTEM = 0x04

const BLACT_SYSTEM_SCENE = 0x04
const BLACT_SYSTEM_TEX_MAT_MAP = 0x0c
const BLACT_SYSTEM_MATERIAL_COUNT = 0x10
const BLACT_SYSTEM_ACTOR_HANDLES = 0x18
const BLACT_SYSTEM_ACTOR_COUNT = 0x1c

const BLACT_SCENE_MATERIALS = 0x04
const BLACT_SCENE_ACTORS = 0x08
const BLACT_SCENE_CONFIG_MATERIAL_COUNT = 0x0c
const BLACT_SCENE_CONFIG_ACTOR_COUNT = 0x0e

const BLACT_SIZE = 0x1c
const BLACT_POSITION = 0x04
const BLACT_FACE_INDEX = 0x10
const BLACT_MAT_FLAGS = 0x18

const BLACT_HANDLE_SIZE = 0x28
const BLACT_HANDLE_ACTOR_INDEX = 0x00
const BLACT_HANDLE_MAT_ENTRY_INDEX = 0x04

const TEX_MAT_MAP_ENTRY_SIZE = 0x08
const TEX_MAT_MAP_MAT_INDEX = 0x00
const TEX_MAT_MAP_TEX_RESOURCE = 0x04

const BLACT_MATERIAL_SIZE = 0x28
const BLACT_MATERIAL_TEX_RESOURCE = 0x00
const BLACT_MATERIAL_ATLAS_X = 0x04
const BLACT_MATERIAL_ATLAS_Y = 0x06
const BLACT_MATERIAL_FACE_X = 0x08
const BLACT_MATERIAL_FACE_Y = 0x09

const STANDARD_NPC_SCENE_VTABLE = 0x021cf92c
const SPECIAL_PLAYER_COMPANION_UID = 0x00fe
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000

type BlActActor = {
  index: number
  address: number
  x: number
  y: number
  z: number
  faceIndex: number
  matFlags: number
}

type HandleBinding = {
  handleIndex: number
  address: number
  blActIndex: number
  matEntryIndex: number
  matIndex: number | null
  texResource: number | null
  materialAddress: number | null
  materialTexResource: number | null
  atlasX: number | null
  atlasY: number | null
  faceX: number | null
  faceY: number | null
}

type ActorBinding = {
  label: string
  slot: number
  uid: number
  fieldModelId: number
  wposX: number
  wposY: number
  wposZ: number
  entityType: number
  sceneNodeType: number
  billboardSize: number
  spriteAtlasSize: number
  spriteControllerType: number
  matched: BlActActor | null
  distance: number | null
  handles: HandleBinding[]
}

type Inspection = {
  actorSystem: number
  fieldBlAct: number
  blActSystem: number
  scene: number
  texMatMap: number
  materialCount: number
  actorHandles: number
  actorCount: number
  sceneMaterials: number
  sceneActors: number
  sceneMaterialCount: number
  sceneActorCount: number
  player: ActorBinding
  npc: ActorBinding
}

function hex(value: number, width = 8) {
  return value.toString(16).toUpperCase().padStart(width, '0')
}

function signed32(value: number) {
  return value | 0
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 0x3) === 0
}

function chooseStandardNpc(entries: White2ActorHeapEntry[], player: White2ActorHeapEntry) {
  return entries
    .filter(entry => entry.state === 'active' && entry.uid !== SPECIAL_PLAYER_COMPANION_UID && entry.sceneNodeVTable === STANDARD_NPC_SCENE_VTABLE)
    .sort((a, b) => (Math.abs(a.x - player.x) + Math.abs(a.y - player.y)) - (Math.abs(b.x - player.x) + Math.abs(b.y - player.y)))[0]
}

export function White2BlActBindingProbe({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [inspection, setInspection] = useState<Inspection | null>(null)
  const supported = White2ActorSystemProbe.supportsRom(rom)

  async function readSceneActors(sceneActors: number, count: number): Promise<BlActActor[]> {
    if (!bridge) return []
    const actors: BlActActor[] = []
    for (let index = 0; index < count; index += 1) {
      const address = sceneActors + index * BLACT_SIZE
      const [x, y, z, faceIndex, matFlags] = await Promise.all([
        bridge.read32(address + BLACT_POSITION + 0x00),
        bridge.read32(address + BLACT_POSITION + 0x04),
        bridge.read32(address + BLACT_POSITION + 0x08),
        bridge.read16(address + BLACT_FACE_INDEX),
        bridge.read16(address + BLACT_MAT_FLAGS),
      ])
      actors.push({ index, address, x, y, z, faceIndex, matFlags })
    }
    return actors
  }

  async function readHandleBindings(blActIndex: number, actorHandles: number, handleCount: number, texMatMap: number, materialCount: number, sceneMaterials: number): Promise<HandleBinding[]> {
    if (!bridge) return []
    const matches: HandleBinding[] = []
    for (let handleIndex = 0; handleIndex < handleCount; handleIndex += 1) {
      const address = actorHandles + handleIndex * BLACT_HANDLE_SIZE
      const [storedBlActIndex, matEntryIndex] = await Promise.all([
        bridge.read32(address + BLACT_HANDLE_ACTOR_INDEX),
        bridge.read16(address + BLACT_HANDLE_MAT_ENTRY_INDEX),
      ])
      if (storedBlActIndex !== blActIndex) continue

      let matIndex: number | null = null
      let texResource: number | null = null
      let materialAddress: number | null = null
      let materialTexResource: number | null = null
      let atlasX: number | null = null
      let atlasY: number | null = null
      let faceX: number | null = null
      let faceY: number | null = null

      if (matEntryIndex < materialCount) {
        const mapAddress = texMatMap + matEntryIndex * TEX_MAT_MAP_ENTRY_SIZE
        ;[matIndex, texResource] = await Promise.all([
          bridge.read16(mapAddress + TEX_MAT_MAP_MAT_INDEX),
          bridge.read32(mapAddress + TEX_MAT_MAP_TEX_RESOURCE),
        ])

        if (matIndex < materialCount) {
          materialAddress = sceneMaterials + matIndex * BLACT_MATERIAL_SIZE
          ;[materialTexResource, atlasX, atlasY, faceX, faceY] = await Promise.all([
            bridge.read32(materialAddress + BLACT_MATERIAL_TEX_RESOURCE),
            bridge.read16(materialAddress + BLACT_MATERIAL_ATLAS_X),
            bridge.read16(materialAddress + BLACT_MATERIAL_ATLAS_Y),
            bridge.read8(materialAddress + BLACT_MATERIAL_FACE_X),
            bridge.read8(materialAddress + BLACT_MATERIAL_FACE_Y),
          ])
        }
      }

      matches.push({ handleIndex, address, blActIndex: storedBlActIndex, matEntryIndex, matIndex, texResource, materialAddress, materialTexResource, atlasX, atlasY, faceX, faceY })
    }
    return matches
  }

  async function readBinding(label: string, entry: White2ActorHeapEntry, sceneActors: BlActActor[], actorHandles: number, handleCount: number, texMatMap: number, materialCount: number, sceneMaterials: number): Promise<ActorBinding> {
    if (!bridge) throw new Error('WAIT FOR MELONDS TO FINISH BOOTING.')
    const [wposX, wposY, wposZ, entityType, sceneNodeType, billboardSize, spriteAtlasSize, spriteControllerType] = await Promise.all([
      bridge.read32(entry.address + ACTOR_WPOS + 0x00),
      bridge.read32(entry.address + ACTOR_WPOS + 0x04),
      bridge.read32(entry.address + ACTOR_WPOS + 0x08),
      bridge.read8(entry.address + ACTOR_CONFIG + 0x02),
      bridge.read8(entry.address + ACTOR_CONFIG + 0x03),
      bridge.read8(entry.address + ACTOR_CONFIG + 0x07),
      bridge.read8(entry.address + ACTOR_CONFIG + 0x08),
      bridge.read8(entry.address + ACTOR_CONFIG + 0x09),
    ])

    const ranked = sceneActors
      .map(actor => ({ actor, distance: Math.abs(signed32(actor.x) - signed32(wposX)) + Math.abs(signed32(actor.y) - signed32(wposY)) + Math.abs(signed32(actor.z) - signed32(wposZ)) }))
      .sort((a, b) => a.distance - b.distance)
    const best = ranked[0] ?? null
    const matched = best?.actor ?? null
    const handles = matched ? await readHandleBindings(matched.index, actorHandles, handleCount, texMatMap, materialCount, sceneMaterials) : []

    return {
      label,
      slot: entry.index,
      uid: entry.uid,
      fieldModelId: entry.modelId,
      wposX,
      wposY,
      wposZ,
      entityType,
      sceneNodeType,
      billboardSize,
      spriteAtlasSize,
      spriteControllerType,
      matched,
      distance: best?.distance ?? null,
      handles,
    }
  }

  async function inspect() {
    if (!bridge || !supported) return
    setBusy(true)
    setStatus(null)
    setInspection(null)
    const wasRunning = bridge.status === 'running'

    try {
      if (wasRunning) await bridge.pause()
      const scan = await new White2ActorSystemProbe(bridge).scanHeap()
      if (scan.suspiciousSlots.length) throw new Error('Billboard binding inspection blocked because suspicious actor slots are present.')
      const player = scan.entries.find(entry => entry.state === 'player')
      if (!player) throw new Error('Player actor was not found.')
      const npc = chooseStandardNpc(scan.entries, player)
      if (!npc) throw new Error('No standard live NPC actor is available on this map.')

      const fieldBlAct = await bridge.read32(scan.actorSystem + ACTOR_SYSTEM_FIELD_BLACT)
      if (!isMainRamPointer(fieldBlAct)) throw new Error(`FieldBlAct pointer is invalid (0x${hex(fieldBlAct)}).`)
      const blActSystem = await bridge.read32(fieldBlAct + FIELD_BLACT_SYSTEM)
      if (!isMainRamPointer(blActSystem)) throw new Error(`BlActSystem pointer is invalid (0x${hex(blActSystem)}).`)

      const [scene, texMatMap, materialCount, actorHandles, actorCount] = await Promise.all([
        bridge.read32(blActSystem + BLACT_SYSTEM_SCENE),
        bridge.read32(blActSystem + BLACT_SYSTEM_TEX_MAT_MAP),
        bridge.read16(blActSystem + BLACT_SYSTEM_MATERIAL_COUNT),
        bridge.read32(blActSystem + BLACT_SYSTEM_ACTOR_HANDLES),
        bridge.read16(blActSystem + BLACT_SYSTEM_ACTOR_COUNT),
      ])
      if (!isMainRamPointer(scene)) throw new Error(`BlActScene pointer is invalid (0x${hex(scene)}).`)
      if (!isMainRamPointer(texMatMap)) throw new Error(`BlAct TexMatMap pointer is invalid (0x${hex(texMatMap)}).`)
      if (!isMainRamPointer(actorHandles)) throw new Error(`BlAct ActorHandles pointer is invalid (0x${hex(actorHandles)}).`)
      if (actorCount < 1 || actorCount > 256) throw new Error(`BlAct actor count is unexpected (${actorCount}).`)
      if (materialCount < 1 || materialCount > 512) throw new Error(`BlAct material count is unexpected (${materialCount}).`)

      const [sceneMaterials, sceneActors, sceneMaterialCount, sceneActorCount] = await Promise.all([
        bridge.read32(scene + BLACT_SCENE_MATERIALS),
        bridge.read32(scene + BLACT_SCENE_ACTORS),
        bridge.read16(scene + BLACT_SCENE_CONFIG_MATERIAL_COUNT),
        bridge.read16(scene + BLACT_SCENE_CONFIG_ACTOR_COUNT),
      ])
      if (!isMainRamPointer(sceneMaterials)) throw new Error(`BlActScene Materials pointer is invalid (0x${hex(sceneMaterials)}).`)
      if (!isMainRamPointer(sceneActors)) throw new Error(`BlActScene Actors pointer is invalid (0x${hex(sceneActors)}).`)
      if (sceneActorCount < 1 || sceneActorCount > 256) throw new Error(`BlActScene actor count is unexpected (${sceneActorCount}).`)

      const actors = await readSceneActors(sceneActors, sceneActorCount)
      const handleCount = Math.min(actorCount, sceneActorCount)
      const [playerBinding, npcBinding] = await Promise.all([
        readBinding('PLAYER', player, actors, actorHandles, handleCount, texMatMap, materialCount, sceneMaterials),
        readBinding('NPC', npc, actors, actorHandles, handleCount, texMatMap, materialCount, sceneMaterials),
      ])

      setInspection({ actorSystem: scan.actorSystem, fieldBlAct, blActSystem, scene, texMatMap, materialCount, actorHandles, actorCount, sceneMaterials, sceneActors, sceneMaterialCount, sceneActorCount, player: playerBinding, npc: npcBinding })
      setStatus('PASS • BILLBOARD / BLACT RENDER BINDINGS READ WITHOUT WRITES')
    } catch (reason) {
      setStatus(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • BLACT BINDING INSPECTION FAILED.')
    } finally {
      if (wasRunning && bridge.status === 'paused') await bridge.resume()
      setBusy(false)
    }
  }

  function bindingLines(binding: ActorBinding) {
    const matched = binding.matched
      ? `BLACT ${binding.matched.index} @0x${hex(binding.matched.address)} • DIST ${binding.distance} • POS 0x${hex(binding.matched.x)}/0x${hex(binding.matched.y)}/0x${hex(binding.matched.z)} • FACEIDX ${binding.matched.faceIndex} • MATFLAGS 0x${hex(binding.matched.matFlags, 4)}`
      : 'NO BLACT MATCH'
    const handles = binding.handles.length
      ? binding.handles.map(handle => `HANDLE ${handle.handleIndex} @0x${hex(handle.address)} • BLACT ${handle.blActIndex} • MATENTRY ${handle.matEntryIndex} • MAT ${handle.matIndex ?? 'N/A'} • TEXRES 0x${hex(handle.texResource ?? 0)} • MATERIAL @0x${hex(handle.materialAddress ?? 0)} TEXRES 0x${hex(handle.materialTexResource ?? 0)} • ATLAS ${handle.atlasX ?? 'N/A'}x${handle.atlasY ?? 'N/A'} FACE ${handle.faceX ?? 'N/A'}x${handle.faceY ?? 'N/A'}`)
      : ['NO HANDLE MATCH']
    return [
      `${binding.label} SLOT ${binding.slot} • UID ${binding.uid} • FIELD MODEL ${binding.fieldModelId} • WPOS 0x${hex(binding.wposX)}/0x${hex(binding.wposY)}/0x${hex(binding.wposZ)}`,
      `CONFIG ENTITY ${binding.entityType} • SCENENODE ${binding.sceneNodeType} • BILLBOARD ${binding.billboardSize} • ATLAS ${binding.spriteAtlasSize} • CONTROLLER ${binding.spriteControllerType}`,
      matched,
      ...handles,
    ]
  }

  async function copyInspection() {
    if (!inspection) return
    const lines = [
      'WHITE 2 NATIVE BILLBOARD / BLACT BINDING INSPECTION',
      `ACTOR SYSTEM 0x${hex(inspection.actorSystem)} • FIELD BLACT 0x${hex(inspection.fieldBlAct)}`,
      `BLACT SYSTEM 0x${hex(inspection.blActSystem)} • SCENE 0x${hex(inspection.scene)}`,
      `TEXMATMAP 0x${hex(inspection.texMatMap)} • MATERIALS ${inspection.materialCount} • HANDLES ${inspection.actorCount} @0x${hex(inspection.actorHandles)}`,
      `SCENE MATERIALS ${inspection.sceneMaterialCount} @0x${hex(inspection.sceneMaterials)} • ACTORS ${inspection.sceneActorCount} @0x${hex(inspection.sceneActors)}`,
      ...bindingLines(inspection.player),
      ...bindingLines(inspection.npc),
    ]
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setStatus('BLACT BINDING INSPECTION COPIED.')
    } catch {
      setStatus('COPY FAILED: BROWSER CLIPBOARD PERMISSION WAS DENIED.')
    }
  }

  return <section className="white2-memory-research pixel-border">
    <h2>WHITE 2 NATIVE BILLBOARD / BLACT INSPECTOR</h2>
    <p>The G3D actor entries for both the trainer and NPC were 0xFFFF0000, which is the sentinel for no FieldG3DObj binding. This reads White 2's separate billboard actor system, correlates live billboard positions back to the FieldActor WPos, and follows the matched BlAct handle into its texture/material binding. This probe performs no writes.</p>
    <div className="memory-compare">
      <PixelButton tone="ghost" disabled={!bridge || !supported || busy} onClick={() => void inspect()}>{busy ? 'READING BILLBOARD BINDINGS...' : 'INSPECT BILLBOARD / BLACT BINDINGS'}</PixelButton>
      <PixelButton tone="ghost" disabled={!inspection || busy} onClick={() => void copyInspection()}>COPY BLACT BINDINGS</PixelButton>
    </div>
    {!supported && <span className="form-error">DISABLED FOR THIS ROM FINGERPRINT.</span>}
    {status && <span className={status.startsWith('FAIL') ? 'form-error' : 'memory-ok'}>{status}</span>}
    {inspection && <div className="memory-results">
      <code>FIELD BLACT 0x{hex(inspection.fieldBlAct)} • BLACT SYSTEM 0x{hex(inspection.blActSystem)} • SCENE 0x{hex(inspection.scene)}</code>
      <code>MATERIALS {inspection.materialCount} • HANDLES {inspection.actorCount} • SCENE ACTORS {inspection.sceneActorCount}</code>
      {bindingLines(inspection.player).map((line, index) => <code key={`p-${index}`}>{line}</code>)}
      {bindingLines(inspection.npc).map((line, index) => <code key={`n-${index}`}>{line}</code>)}
    </div>}
    <span>IF PLAYER AND NPC RESOLVE TO DIFFERENT MATERIAL ENTRIES, THE NEXT CONTROLLED TEST CAN SWAP ONLY THE NPC'S BILLBOARD MATERIAL/HANDLE BINDING AND RESTORE IT.</span>
  </section>
}
