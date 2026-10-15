import { useState } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2ActorSystemProbe, type White2ActorHeapEntry } from '../multiplayer/games/White2ActorSystem'
import { PixelButton } from './PixelButton'

const ACTOR_SYSTEM_FIELD_BLACT = 0x28
const ACTOR_WPOS = 0x44
const FIELD_BLACT_SYSTEM = 0x04
const BLACT_SYSTEM_SCENE = 0x04
const BLACT_SYSTEM_ACTOR_HANDLES = 0x18
const BLACT_SYSTEM_ACTOR_COUNT = 0x1c
const BLACT_SCENE_ACTORS = 0x08
const BLACT_SCENE_CONFIG_ACTOR_COUNT = 0x0e
const BLACT_SIZE = 0x1c
const BLACT_POSITION = 0x04
const BLACT_HANDLE_SIZE = 0x28
const STANDARD_NPC_SCENE_VTABLE = 0x021cf92c
const SPECIAL_PLAYER_COMPANION_UID = 0x00fe
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000

type ResolvedBinding = {
  label: string
  slot: number
  uid: number
  modelId: number
  blActIndex: number
  blActAddress: number
  blActWords: number[]
  handleIndex: number
  handleAddress: number
  handleWords: number[]
}

type Result = {
  actorSystem: number
  fieldBlAct: number
  blActSystem: number
  player: ResolvedBinding
  npc: ResolvedBinding
}

function hex(value: number, width = 8) {
  return (value >>> 0).toString(16).toUpperCase().padStart(width, '0')
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

const HANDLE_WORD_LABELS = [
  '+00 BlActIdx',
  '+04 MatEntryIdx/field_6',
  '+08 field_8',
  '+0C field_C/field_E',
  '+10 field_10',
  '+14 field_14/field_16',
  '+18 field_18',
  '+1C field_1C/field_1E',
  '+20 Callback',
  '+24 CallbackData',
]

const BLACT_WORD_LABELS = [
  '+00 GeomFlags',
  '+04 Position.X',
  '+08 Position.Y',
  '+0C Position.Z',
  '+10 FaceIdx/ScaleX',
  '+14 Scale2/RotationY',
  '+18 MatFlags',
]

export function White2BlActHandleDiffProbe({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const supported = White2ActorSystemProbe.supportsRom(rom)

  async function resolveBinding(label: string, entry: White2ActorHeapEntry, sceneActors: number, sceneActorCount: number, actorHandles: number, handleCount: number): Promise<ResolvedBinding> {
    if (!bridge) throw new Error('WAIT FOR MELONDS TO FINISH BOOTING.')
    const [wposX, wposY, wposZ] = await Promise.all([
      bridge.read32(entry.address + ACTOR_WPOS + 0x00),
      bridge.read32(entry.address + ACTOR_WPOS + 0x04),
      bridge.read32(entry.address + ACTOR_WPOS + 0x08),
    ])

    let blActIndex = -1
    let bestDistance = Number.POSITIVE_INFINITY
    for (let index = 0; index < sceneActorCount; index += 1) {
      const address = sceneActors + index * BLACT_SIZE
      const [x, y, z] = await Promise.all([
        bridge.read32(address + BLACT_POSITION + 0x00),
        bridge.read32(address + BLACT_POSITION + 0x04),
        bridge.read32(address + BLACT_POSITION + 0x08),
      ])
      const distance = Math.abs(signed32(x) - signed32(wposX)) + Math.abs(signed32(y) - signed32(wposY)) + Math.abs(signed32(z) - signed32(wposZ))
      if (distance < bestDistance) {
        bestDistance = distance
        blActIndex = index
      }
    }
    if (blActIndex < 0) throw new Error(`${label} billboard actor could not be resolved.`)

    const blActAddress = sceneActors + blActIndex * BLACT_SIZE
    const blActWords = await Promise.all(Array.from({ length: BLACT_SIZE / 4 }, (_, index) => bridge.read32(blActAddress + index * 4)))

    let handleIndex = -1
    for (let index = 0; index < handleCount; index += 1) {
      const address = actorHandles + index * BLACT_HANDLE_SIZE
      if ((await bridge.read32(address)) === blActIndex) {
        handleIndex = index
        break
      }
    }
    if (handleIndex < 0) throw new Error(`${label} billboard handle could not be resolved.`)

    const handleAddress = actorHandles + handleIndex * BLACT_HANDLE_SIZE
    const handleWords = await Promise.all(Array.from({ length: BLACT_HANDLE_SIZE / 4 }, (_, index) => bridge.read32(handleAddress + index * 4)))

    return { label, slot: entry.index, uid: entry.uid, modelId: entry.modelId, blActIndex, blActAddress, blActWords, handleIndex, handleAddress, handleWords }
  }

  async function inspect() {
    if (!bridge || !supported) return
    setBusy(true)
    setStatus(null)
    setResult(null)
    const wasRunning = bridge.status === 'running'
    try {
      if (wasRunning) await bridge.pause()
      const scan = await new White2ActorSystemProbe(bridge).scanHeap()
      if (scan.suspiciousSlots.length) throw new Error('Handle diff blocked because suspicious actor slots are present.')
      const player = scan.entries.find(entry => entry.state === 'player')
      if (!player) throw new Error('Player actor was not found.')
      const npc = chooseStandardNpc(scan.entries, player)
      if (!npc) throw new Error('No standard live NPC actor is available on this map.')

      const fieldBlAct = await bridge.read32(scan.actorSystem + ACTOR_SYSTEM_FIELD_BLACT)
      if (!isMainRamPointer(fieldBlAct)) throw new Error(`FieldBlAct pointer is invalid (0x${hex(fieldBlAct)}).`)
      const blActSystem = await bridge.read32(fieldBlAct + FIELD_BLACT_SYSTEM)
      if (!isMainRamPointer(blActSystem)) throw new Error(`BlActSystem pointer is invalid (0x${hex(blActSystem)}).`)
      const [scene, actorHandles, actorCount] = await Promise.all([
        bridge.read32(blActSystem + BLACT_SYSTEM_SCENE),
        bridge.read32(blActSystem + BLACT_SYSTEM_ACTOR_HANDLES),
        bridge.read16(blActSystem + BLACT_SYSTEM_ACTOR_COUNT),
      ])
      if (!isMainRamPointer(scene) || !isMainRamPointer(actorHandles)) throw new Error('BlAct scene/handle pointers are invalid.')
      const [sceneActors, sceneActorCount] = await Promise.all([
        bridge.read32(scene + BLACT_SCENE_ACTORS),
        bridge.read16(scene + BLACT_SCENE_CONFIG_ACTOR_COUNT),
      ])
      if (!isMainRamPointer(sceneActors)) throw new Error('BlAct scene actor array pointer is invalid.')
      const handleCount = Math.min(actorCount, sceneActorCount)

      const [playerBinding, npcBinding] = await Promise.all([
        resolveBinding('PLAYER', player, sceneActors, sceneActorCount, actorHandles, handleCount),
        resolveBinding('NPC', npc, sceneActors, sceneActorCount, actorHandles, handleCount),
      ])
      setResult({ actorSystem: scan.actorSystem, fieldBlAct, blActSystem, player: playerBinding, npc: npcBinding })
      setStatus('PASS • PLAYER/NPC BILLBOARD HANDLE STATE CAPTURED WITHOUT WRITES')
    } catch (reason) {
      setStatus(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • BILLBOARD HANDLE DIFF FAILED.')
    } finally {
      if (wasRunning && bridge.status === 'paused') await bridge.resume()
      setBusy(false)
    }
  }

  function lines() {
    if (!result) return []
    const out = [
      'WHITE 2 BLACT PLAYER/NPC HANDLE DIFF',
      `ACTOR SYSTEM 0x${hex(result.actorSystem)} • FIELD BLACT 0x${hex(result.fieldBlAct)} • BLACT SYSTEM 0x${hex(result.blActSystem)}`,
    ]
    for (const binding of [result.player, result.npc]) {
      out.push(`${binding.label} SLOT ${binding.slot} UID ${binding.uid} MODEL ${binding.modelId} • BLACT ${binding.blActIndex} @0x${hex(binding.blActAddress)} • HANDLE ${binding.handleIndex} @0x${hex(binding.handleAddress)}`)
      binding.blActWords.forEach((word, index) => out.push(`${binding.label} BLACT ${BLACT_WORD_LABELS[index]} • 0x${hex(word)}`))
      binding.handleWords.forEach((word, index) => out.push(`${binding.label} HANDLE ${HANDLE_WORD_LABELS[index]} • 0x${hex(word)}`))
    }
    out.push('DIFFS')
    result.player.blActWords.forEach((word, index) => {
      const other = result.npc.blActWords[index]
      if (word !== other) out.push(`BLACT ${BLACT_WORD_LABELS[index]} • PLAYER 0x${hex(word)} • NPC 0x${hex(other)}`)
    })
    result.player.handleWords.forEach((word, index) => {
      const other = result.npc.handleWords[index]
      if (word !== other) out.push(`HANDLE ${HANDLE_WORD_LABELS[index]} • PLAYER 0x${hex(word)} • NPC 0x${hex(other)}`)
    })
    return out
  }

  async function copy() {
    const output = lines()
    if (!output.length) return
    try {
      await navigator.clipboard.writeText(output.join('\n'))
      setStatus('BLACT HANDLE DIFF COPIED.')
    } catch {
      setStatus('COPY FAILED: BROWSER CLIPBOARD PERMISSION WAS DENIED.')
    }
  }

  return <section className="white2-memory-research pixel-border">
    <h2>WHITE 2 BILLBOARD HANDLE DIFF</h2>
    <p>The material swap changed the visible character but produced Cheren/youngster frames instead of the protagonist. This read-only probe compares the full 0x28-byte BlActHandle and 0x1C-byte BlAct renderer record for the real player versus the borrowed NPC, looking for the remaining sprite/palette/controller selector.</p>
    <div className="memory-compare">
      <PixelButton tone="ghost" disabled={!bridge || !supported || busy} onClick={() => void inspect()}>{busy ? 'READING PLAYER/NPC HANDLE STATE...' : 'INSPECT PLAYER/NPC HANDLE DIFF'}</PixelButton>
      <PixelButton tone="ghost" disabled={!result || busy} onClick={() => void copy()}>COPY HANDLE DIFF</PixelButton>
    </div>
    {!supported && <span className="form-error">DISABLED FOR THIS ROM FINGERPRINT.</span>}
    {status && <span className={status.startsWith('FAIL') ? 'form-error' : 'memory-ok'}>{status}</span>}
    {result && <div className="memory-results">{lines().map((line, index) => <code key={index}>{line}</code>)}</div>}
    <span>THIS PROBE PERFORMS NO WRITES. THE UNKNOWN HANDLE FIELDS ARE LEFT UNTOUCHED UNTIL WE SEE WHICH VALUES DIFFER BETWEEN THE REAL PLAYER AND NPC.</span>
  </section>
}
