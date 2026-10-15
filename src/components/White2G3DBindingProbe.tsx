import { useState } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2ActorSystemProbe, type White2ActorHeapEntry } from '../multiplayer/games/White2ActorSystem'
import { PixelButton } from './PixelButton'

const ACTOR_SYSTEM_G3D_SYSTEM = 0x2c
const ACTOR_G3D_SYSTEM_OBJ_SYSTEM = 0x04
const ACTOR_G3D_SYSTEM_CAPACITY = 0x08
const ACTOR_G3D_SYSTEM_ENTRIES = 0x0c

const G3D_OBJ_SYSTEM_RES_GROUP_COUNT = 0x04
const G3D_OBJ_SYSTEM_OBJECT_COUNT = 0x06
const G3D_OBJ_SYSTEM_RES_GROUPS = 0x08
const G3D_OBJ_SYSTEM_OBJECTS = 0x0c

const G3D_ENTRY_SIZE = 0x04
const G3D_OBJECT_SIZE = 0x68
const G3D_OBJECT_FLAGS = 0x00
const G3D_OBJECT_RES_GROUP_ID = 0x04
const G3D_OBJECT_MODEL_INDEX = 0x06
const G3D_OBJECT_TRANSLATION = 0x08
const G3D_OBJECT_ACTOR = 0x44

const STANDARD_NPC_SCENE_VTABLE = 0x021cf92c
const SPECIAL_PLAYER_COMPANION_UID = 0x00fe
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000

type BindingInfo = {
  label: string
  slot: number
  uid: number
  actorModelId: number
  entryAddress: number
  entryRaw: number
  resGroupIndex: number
  objCode: number
  objectAddress: number | null
  objectFlags: number | null
  objectResGroupId: number | null
  objectModelIndex: number | null
  objectActorPtr: number | null
  tx: number | null
  ty: number | null
  tz: number | null
}

type Inspection = {
  actorSystem: number
  actorG3DSystem: number
  actorG3DCapacity: number
  entries: number
  objectSystem: number
  resGroupCount: number
  objectCount: number
  resGroups: number
  objects: number
  player: BindingInfo
  npc: BindingInfo
}

function hex(value: number, width = 8) {
  return value.toString(16).toUpperCase().padStart(width, '0')
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 0x3) === 0
}

function chooseStandardNpc(entries: White2ActorHeapEntry[], player: White2ActorHeapEntry) {
  return entries
    .filter(entry => entry.state === 'active' && entry.uid !== SPECIAL_PLAYER_COMPANION_UID && entry.sceneNodeVTable === STANDARD_NPC_SCENE_VTABLE)
    .sort((a, b) => (Math.abs(a.x - player.x) + Math.abs(a.y - player.y)) - (Math.abs(b.x - player.x) + Math.abs(b.y - player.y)))[0]
}

export function White2G3DBindingProbe({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [inspection, setInspection] = useState<Inspection | null>(null)
  const supported = White2ActorSystemProbe.supportsRom(rom)

  async function readBinding(label: string, entry: White2ActorHeapEntry, entries: number, objects: number, objectCount: number): Promise<BindingInfo> {
    if (!bridge) throw new Error('WAIT FOR MELONDS TO FINISH BOOTING.')
    const entryAddress = entries + entry.index * G3D_ENTRY_SIZE
    const entryRaw = await bridge.read32(entryAddress)
    const resGroupIndex = entryRaw & 0xffff
    const objCode = (entryRaw >>> 16) & 0xffff

    let objectAddress: number | null = null
    let objectFlags: number | null = null
    let objectResGroupId: number | null = null
    let objectModelIndex: number | null = null
    let objectActorPtr: number | null = null
    let tx: number | null = null
    let ty: number | null = null
    let tz: number | null = null

    if (objCode < objectCount) {
      objectAddress = objects + objCode * G3D_OBJECT_SIZE
      ;[objectFlags, objectResGroupId, objectModelIndex, tx, ty, tz, objectActorPtr] = await Promise.all([
        bridge.read32(objectAddress + G3D_OBJECT_FLAGS),
        bridge.read16(objectAddress + G3D_OBJECT_RES_GROUP_ID),
        bridge.read16(objectAddress + G3D_OBJECT_MODEL_INDEX),
        bridge.read32(objectAddress + G3D_OBJECT_TRANSLATION + 0x00),
        bridge.read32(objectAddress + G3D_OBJECT_TRANSLATION + 0x04),
        bridge.read32(objectAddress + G3D_OBJECT_TRANSLATION + 0x08),
        bridge.read32(objectAddress + G3D_OBJECT_ACTOR),
      ])
    }

    return {
      label,
      slot: entry.index,
      uid: entry.uid,
      actorModelId: entry.modelId,
      entryAddress,
      entryRaw,
      resGroupIndex,
      objCode,
      objectAddress,
      objectFlags,
      objectResGroupId,
      objectModelIndex,
      objectActorPtr,
      tx,
      ty,
      tz,
    }
  }

  async function inspectBindings() {
    if (!bridge || !supported) return
    setBusy(true)
    setStatus(null)
    setInspection(null)
    const wasRunning = bridge.status === 'running'

    try {
      if (wasRunning) await bridge.pause()
      const scan = await new White2ActorSystemProbe(bridge).scanHeap()
      if (scan.suspiciousSlots.length) throw new Error('G3D binding inspection blocked because suspicious actor slots are present.')

      const player = scan.entries.find(entry => entry.state === 'player')
      if (!player) throw new Error('Player actor was not found.')
      const npc = chooseStandardNpc(scan.entries, player)
      if (!npc) throw new Error('No standard live NPC actor is available on this map.')

      const actorG3DSystem = await bridge.read32(scan.actorSystem + ACTOR_SYSTEM_G3D_SYSTEM)
      if (!isMainRamPointer(actorG3DSystem)) throw new Error(`FieldActorG3DSystem pointer is invalid (0x${hex(actorG3DSystem)}).`)

      const [objectSystem, actorG3DCapacity, entries] = await Promise.all([
        bridge.read32(actorG3DSystem + ACTOR_G3D_SYSTEM_OBJ_SYSTEM),
        bridge.read16(actorG3DSystem + ACTOR_G3D_SYSTEM_CAPACITY),
        bridge.read32(actorG3DSystem + ACTOR_G3D_SYSTEM_ENTRIES),
      ])
      if (!isMainRamPointer(objectSystem)) throw new Error(`FieldG3DObjSystem pointer is invalid (0x${hex(objectSystem)}).`)
      if (!isMainRamPointer(entries)) throw new Error(`FieldActorG3DObjEntry array pointer is invalid (0x${hex(entries)}).`)
      if (actorG3DCapacity < 1 || actorG3DCapacity > 64) throw new Error(`FieldActorG3DSystem capacity is unexpected (${actorG3DCapacity}).`)

      const [resGroupCount, objectCount, resGroups, objects] = await Promise.all([
        bridge.read16(objectSystem + G3D_OBJ_SYSTEM_RES_GROUP_COUNT),
        bridge.read16(objectSystem + G3D_OBJ_SYSTEM_OBJECT_COUNT),
        bridge.read32(objectSystem + G3D_OBJ_SYSTEM_RES_GROUPS),
        bridge.read32(objectSystem + G3D_OBJ_SYSTEM_OBJECTS),
      ])
      if (!isMainRamPointer(objects)) throw new Error(`FieldG3DObj array pointer is invalid (0x${hex(objects)}).`)
      if (resGroups !== 0 && !isMainRamPointer(resGroups)) throw new Error(`FieldG3DObj resource-group pointer is invalid (0x${hex(resGroups)}).`)
      if (objectCount > 512) throw new Error(`FieldG3DObj object count is unexpectedly large (${objectCount}).`)
      if (resGroupCount > 512) throw new Error(`FieldG3DObj resource-group count is unexpectedly large (${resGroupCount}).`)

      const [playerBinding, npcBinding] = await Promise.all([
        readBinding('PLAYER', player, entries, objects, objectCount),
        readBinding('NPC', npc, entries, objects, objectCount),
      ])

      setInspection({
        actorSystem: scan.actorSystem,
        actorG3DSystem,
        actorG3DCapacity,
        entries,
        objectSystem,
        resGroupCount,
        objectCount,
        resGroups,
        objects,
        player: playerBinding,
        npc: npcBinding,
      })
      setStatus('PASS • NATIVE G3D BINDINGS READ WITHOUT WRITES')
    } catch (reason) {
      setStatus(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • G3D BINDING INSPECTION FAILED.')
    } finally {
      if (wasRunning && bridge.status === 'paused') await bridge.resume()
      setBusy(false)
    }
  }

  function bindingLine(binding: BindingInfo) {
    const object = binding.objectAddress === null
      ? `OBJ ${binding.objCode} OUTSIDE OBJECT COUNT`
      : `OBJ ${binding.objCode} @ 0x${hex(binding.objectAddress)} • FLAGS 0x${hex(binding.objectFlags ?? 0)} • RG ${binding.objectResGroupId} • MODELIDX ${binding.objectModelIndex} • G3DACTOR 0x${hex(binding.objectActorPtr ?? 0)} • T 0x${hex(binding.tx ?? 0)}/0x${hex(binding.ty ?? 0)}/0x${hex(binding.tz ?? 0)}`
    return `${binding.label} SLOT ${binding.slot} • UID ${binding.uid} • FIELD MODEL ${binding.actorModelId} • ENTRY @0x${hex(binding.entryAddress)} RAW 0x${hex(binding.entryRaw)} • RESGROUP ${binding.resGroupIndex} • ${object}`
  }

  async function copyInspection() {
    if (!inspection) return
    const lines = [
      'WHITE 2 NATIVE G3D BINDING INSPECTION',
      `ACTOR SYSTEM 0x${hex(inspection.actorSystem)}`,
      `ACTOR G3D SYSTEM 0x${hex(inspection.actorG3DSystem)} • CAP ${inspection.actorG3DCapacity} • ENTRIES 0x${hex(inspection.entries)}`,
      `G3D OBJ SYSTEM 0x${hex(inspection.objectSystem)} • RESGROUPS ${inspection.resGroupCount} @ 0x${hex(inspection.resGroups)} • OBJECTS ${inspection.objectCount} @ 0x${hex(inspection.objects)}`,
      bindingLine(inspection.player),
      bindingLine(inspection.npc),
    ]
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setStatus('G3D BINDING INSPECTION COPIED.')
    } catch {
      setStatus('COPY FAILED: BROWSER CLIPBOARD PERMISSION WAS DENIED.')
    }
  }

  return <section className="white2-memory-research pixel-border">
    <h2>WHITE 2 NATIVE G3D BINDING INSPECTOR</h2>
    <p>The ModelID field did not change the visible NPC, so this reads the renderer-side FieldActorG3DSystem and FieldG3DObj binding for the live player and nearest standard NPC. This probe performs no writes.</p>
    <div className="memory-compare">
      <PixelButton tone="ghost" disabled={!bridge || !supported || busy} onClick={() => void inspectBindings()}>{busy ? 'READING G3D BINDINGS...' : 'INSPECT NATIVE G3D BINDINGS'}</PixelButton>
      <PixelButton tone="ghost" disabled={!inspection || busy} onClick={() => void copyInspection()}>COPY G3D BINDINGS</PixelButton>
    </div>
    {!supported && <span className="form-error">DISABLED FOR THIS ROM FINGERPRINT.</span>}
    {status && <span className={status.startsWith('FAIL') ? 'form-error' : 'memory-ok'}>{status}</span>}
    {inspection && <div className="memory-results">
      <code>ACTOR G3D SYSTEM 0x{hex(inspection.actorG3DSystem)} • CAP {inspection.actorG3DCapacity} • ENTRIES 0x{hex(inspection.entries)}</code>
      <code>G3D OBJ SYSTEM 0x{hex(inspection.objectSystem)} • RESGROUPS {inspection.resGroupCount} @ 0x{hex(inspection.resGroups)} • OBJECTS {inspection.objectCount} @ 0x{hex(inspection.objects)}</code>
      <code>{bindingLine(inspection.player)}</code>
      <code>{bindingLine(inspection.npc)}</code>
    </div>}
    <span>NEXT STEP DEPENDS ON THESE VALUES: IF THE PLAYER AND NPC USE DIFFERENT OBJ/RESOURCE BINDINGS, WE CAN TEST A REVERSIBLE RENDER-BINDING SWAP INSTEAD OF GUESSING AT MODELID.</span>
  </section>
}
