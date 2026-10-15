import { useState } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2ActorSystemProbe, type White2ActorHeapEntry } from '../multiplayer/games/White2ActorSystem'
import { PixelButton } from './PixelButton'

const ACTOR_SYSTEM_FIELD_BLACT = 0x28
const ACTOR_UID = 0x08
const ACTOR_MODEL_ID = 0x0c
const ACTOR_WPOS = 0x44
const ACTOR_TCB = 0x84

const FIELD_BLACT_SYSTEM = 0x04
const BLACT_SYSTEM_SCENE = 0x04
const BLACT_SYSTEM_ACTOR_HANDLES = 0x18
const BLACT_SYSTEM_ACTOR_COUNT = 0x1c
const BLACT_SCENE_ACTORS = 0x08
const BLACT_SCENE_CONFIG_ACTOR_COUNT = 0x0e

const BLACT_SIZE = 0x1c
const BLACT_GEOM_FLAGS = 0x00
const BLACT_POSITION = 0x04
const BLACT_FACE_INDEX = 0x10
const BLACT_MAT_FLAGS = 0x18

const HANDLE_SIZE = 0x28
const HANDLE_BLACT_INDEX = 0x00
const HANDLE_MAT_ENTRY = 0x04
const HANDLE_FIELD_8 = 0x08

const STANDARD_NPC_SCENE_VTABLE = 0x021cf92c
const SPECIAL_PLAYER_COMPANION_UID = 0x00fe
const PLAYER_UID = 0x00ff
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000
const TEST_MS = 2000
const UPDATE_MS = 40

type Binding = {
  actor: White2ActorHeapEntry
  blActIndex: number
  blActAddress: number
  handleIndex: number
  handleAddress: number
}

type RenderState = {
  matEntry: number
  controllerWord: number
  geomFlags: number
  faceIndex: number
  matFlags: number
}

type OriginalNpcState = RenderState & {
  uid: number
  modelId: number
  tcb: number
}

function hex(value: number, width = 8) {
  return (value >>> 0).toString(16).toUpperCase().padStart(width, '0')
}

function signed32(value: number) {
  return value | 0
}

function delay(ms: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms))
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 0x3) === 0
}

function chooseStandardNpc(entries: White2ActorHeapEntry[], player: White2ActorHeapEntry) {
  return entries
    .filter(entry => entry.state === 'active' && entry.uid !== SPECIAL_PLAYER_COMPANION_UID && entry.sceneNodeVTable === STANDARD_NPC_SCENE_VTABLE)
    .sort((a, b) => (Math.abs(a.x - player.x) + Math.abs(a.y - player.y)) - (Math.abs(b.x - player.x) + Math.abs(b.y - player.y)))[0]
}

export function White2TrainerControllerProbe({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const supported = White2ActorSystemProbe.supportsRom(rom)

  async function resolveBinding(entry: White2ActorHeapEntry, sceneActors: number, actorCount: number, actorHandles: number, handleCount: number): Promise<Binding> {
    if (!bridge) throw new Error('melonDS bridge is unavailable.')
    const [wposX, wposY, wposZ] = await Promise.all([
      bridge.read32(entry.address + ACTOR_WPOS + 0x00),
      bridge.read32(entry.address + ACTOR_WPOS + 0x04),
      bridge.read32(entry.address + ACTOR_WPOS + 0x08),
    ])

    let bestIndex = -1
    let bestAddress = 0
    let bestDistance = Number.POSITIVE_INFINITY
    for (let index = 0; index < actorCount; index += 1) {
      const address = sceneActors + index * BLACT_SIZE
      const [x, y, z] = await Promise.all([
        bridge.read32(address + BLACT_POSITION + 0x00),
        bridge.read32(address + BLACT_POSITION + 0x04),
        bridge.read32(address + BLACT_POSITION + 0x08),
      ])
      const distance = Math.abs(signed32(x) - signed32(wposX)) + Math.abs(signed32(y) - signed32(wposY)) + Math.abs(signed32(z) - signed32(wposZ))
      if (distance < bestDistance) {
        bestDistance = distance
        bestIndex = index
        bestAddress = address
      }
    }
    if (bestIndex < 0) throw new Error(`Could not resolve billboard actor for slot ${entry.index}.`)

    const matches: Array<{ index: number; address: number }> = []
    for (let index = 0; index < handleCount; index += 1) {
      const address = actorHandles + index * HANDLE_SIZE
      if ((await bridge.read32(address + HANDLE_BLACT_INDEX)) === bestIndex) matches.push({ index, address })
    }
    if (matches.length !== 1) throw new Error(`Expected one billboard handle for BlAct ${bestIndex}, found ${matches.length}.`)
    return { actor: entry, blActIndex: bestIndex, blActAddress: bestAddress, handleIndex: matches[0].index, handleAddress: matches[0].address }
  }

  async function prepare() {
    if (!bridge) throw new Error('melonDS bridge is unavailable.')
    const scan = await new White2ActorSystemProbe(bridge).scanHeap()
    if (scan.suspiciousSlots.length) throw new Error('Controller test blocked because suspicious actor slots are present.')
    const player = scan.entries.find(entry => entry.state === 'player')
    if (!player || player.uid !== PLAYER_UID) throw new Error('Live player actor was not found.')
    const npc = chooseStandardNpc(scan.entries, player)
    if (!npc) throw new Error('No standard live NPC is available for the controller test.')

    const fieldBlAct = await bridge.read32(scan.actorSystem + ACTOR_SYSTEM_FIELD_BLACT)
    if (!isMainRamPointer(fieldBlAct)) throw new Error(`FieldBlAct pointer is invalid (0x${hex(fieldBlAct)}).`)
    const blActSystem = await bridge.read32(fieldBlAct + FIELD_BLACT_SYSTEM)
    if (!isMainRamPointer(blActSystem)) throw new Error(`BlActSystem pointer is invalid (0x${hex(blActSystem)}).`)
    const [scene, actorHandles, handleCount] = await Promise.all([
      bridge.read32(blActSystem + BLACT_SYSTEM_SCENE),
      bridge.read32(blActSystem + BLACT_SYSTEM_ACTOR_HANDLES),
      bridge.read16(blActSystem + BLACT_SYSTEM_ACTOR_COUNT),
    ])
    if (!isMainRamPointer(scene) || !isMainRamPointer(actorHandles)) throw new Error('Billboard scene/handle pointers are invalid.')
    const [sceneActors, actorCount] = await Promise.all([
      bridge.read32(scene + BLACT_SCENE_ACTORS),
      bridge.read16(scene + BLACT_SCENE_CONFIG_ACTOR_COUNT),
    ])
    if (!isMainRamPointer(sceneActors)) throw new Error('Billboard actor array pointer is invalid.')

    const [playerBinding, npcBinding] = await Promise.all([
      resolveBinding(player, sceneActors, actorCount, actorHandles, handleCount),
      resolveBinding(npc, sceneActors, actorCount, actorHandles, handleCount),
    ])
    return { playerBinding, npcBinding }
  }

  async function captureRender(binding: Binding): Promise<RenderState> {
    if (!bridge) throw new Error('melonDS bridge is unavailable.')
    const [matEntry, controllerWord, geomFlags, faceIndex, matFlags] = await Promise.all([
      bridge.read16(binding.handleAddress + HANDLE_MAT_ENTRY),
      bridge.read32(binding.handleAddress + HANDLE_FIELD_8),
      bridge.read16(binding.blActAddress + BLACT_GEOM_FLAGS),
      bridge.read16(binding.blActAddress + BLACT_FACE_INDEX),
      bridge.read16(binding.blActAddress + BLACT_MAT_FLAGS),
    ])
    return { matEntry, controllerWord, geomFlags, faceIndex, matFlags }
  }

  async function identityMatches(binding: Binding, original: OriginalNpcState) {
    if (!bridge) return false
    const [uid, modelId, tcb, owner] = await Promise.all([
      bridge.read16(binding.actor.address + ACTOR_UID),
      bridge.read16(binding.actor.address + ACTOR_MODEL_ID),
      bridge.read32(binding.actor.address + ACTOR_TCB),
      bridge.read32(binding.handleAddress + HANDLE_BLACT_INDEX),
    ])
    return uid === original.uid && modelId === original.modelId && tcb === original.tcb && owner === binding.blActIndex
  }

  async function applyPlayerState(binding: Binding, player: RenderState) {
    if (!bridge) return
    await Promise.all([
      bridge.write16(binding.handleAddress + HANDLE_MAT_ENTRY, player.matEntry),
      bridge.write32(binding.handleAddress + HANDLE_FIELD_8, player.controllerWord),
      bridge.write16(binding.blActAddress + BLACT_GEOM_FLAGS, player.geomFlags),
      bridge.write16(binding.blActAddress + BLACT_FACE_INDEX, player.faceIndex),
      bridge.write16(binding.blActAddress + BLACT_MAT_FLAGS, player.matFlags),
    ])
  }

  async function restore(binding: Binding, original: OriginalNpcState) {
    if (!bridge || !(await identityMatches(binding, original))) return false
    await Promise.all([
      bridge.write16(binding.handleAddress + HANDLE_MAT_ENTRY, original.matEntry),
      bridge.write32(binding.handleAddress + HANDLE_FIELD_8, original.controllerWord),
      bridge.write16(binding.blActAddress + BLACT_GEOM_FLAGS, original.geomFlags),
      bridge.write16(binding.blActAddress + BLACT_FACE_INDEX, original.faceIndex),
      bridge.write16(binding.blActAddress + BLACT_MAT_FLAGS, original.matFlags),
    ])
    const restored = await captureRender(binding)
    return restored.matEntry === original.matEntry
      && restored.controllerWord === original.controllerWord
      && restored.geomFlags === original.geomFlags
      && restored.faceIndex === original.faceIndex
      && restored.matFlags === original.matFlags
  }

  async function run() {
    if (!bridge || !supported) return
    setBusy(true)
    setResult(null)
    const wasRunning = bridge.status === 'running'
    let npcBinding: Binding | null = null
    let original: OriginalNpcState | null = null

    try {
      if (!wasRunning) throw new Error('Trainer +0x08 controller test requires melonDS to be running.')
      await bridge.pause()
      const { playerBinding, npcBinding: resolvedNpc } = await prepare()
      npcBinding = resolvedNpc
      const [playerRender, npcRender] = await Promise.all([captureRender(playerBinding), captureRender(resolvedNpc)])
      original = { ...npcRender, uid: resolvedNpc.actor.uid, modelId: resolvedNpc.actor.modelId, tcb: resolvedNpc.actor.tcb }
      if (playerRender.controllerWord === npcRender.controllerWord) throw new Error(`Player and NPC handle +0x08 values are already equal (0x${hex(playerRender.controllerWord)}).`)
      if (!isMainRamPointer(playerRender.controllerWord) || !isMainRamPointer(npcRender.controllerWord)) throw new Error(`Handle +0x08 values do not both look like aligned main-RAM pointers (${hex(npcRender.controllerWord)}→${hex(playerRender.controllerWord)}).`)

      await applyPlayerState(resolvedNpc, playerRender)
      await bridge.resume()
      const deadline = Date.now() + TEST_MS
      while (Date.now() < deadline) {
        if (!(await identityMatches(resolvedNpc, original))) throw new Error('Borrowed NPC changed identity during the +0x08 controller test.')
        await applyPlayerState(resolvedNpc, playerRender)
        await delay(UPDATE_MS)
      }
      await bridge.pause()

      const observed = await bridge.read32(resolvedNpc.handleAddress + HANDLE_FIELD_8)
      const restored = await restore(resolvedNpc, original)
      if (!restored) throw new Error('Original NPC billboard state could not be verified after restoration.')

      setResult(`PASS • HANDLE +0x08 CONTROLLER-LIKE TEST • NPC SLOT ${resolvedNpc.actor.index} / BLACT ${resolvedNpc.blActIndex} • 0x${hex(npcRender.controllerWord)}→0x${hex(playerRender.controllerWord)} • OBSERVED 0x${hex(observed)} • +0x0C UNTOUCHED • ORIGINAL NPC STATE RESTORED`)
    } catch (reason) {
      if (npcBinding && original) {
        try {
          if (bridge.status === 'running') await bridge.pause()
          await restore(npcBinding, original)
        } catch { /* guarded best-effort restore */ }
      }
      setResult(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • TRAINER +0x08 CONTROLLER TEST FAILED.')
    } finally {
      if (wasRunning && bridge.status === 'paused') await bridge.resume()
      setBusy(false)
    }
  }

  return <section className="white2-memory-research pixel-border">
    <h2>WHITE 2 TRAINER +0x08 CONTROLLER</h2>
    <p>The full +0x0C word changed successfully but did not affect the borrowed protagonist's size, so +0x0C is ruled out as the scale source. The remaining clean handle difference is +0x08, which looks pointer/controller-like. This test copies only +0x08 in addition to the already-proven protagonist render state; +0x0C is left untouched.</p>
    <div className="memory-compare">
      <PixelButton tone="danger" disabled={!bridge || !supported || busy} onClick={() => void run()}>{busy ? 'TESTING +0x08 CONTROLLER + RESTORING...' : 'TEST PLAYER +0x08 CONTROLLER 2S + RESTORE'}</PixelButton>
    </div>
    {!supported && <span className="form-error">DISABLED FOR THIS ROM FINGERPRINT.</span>}
    {result && <span className={result.startsWith('PASS') ? 'memory-ok' : 'form-error'}>{result}</span>}
    <span>WATCH ONLY THE BORROWED PROTAGONIST'S VISUAL SIZE FOR TWO SECONDS. DOES +0x08 MAKE IT MATCH THE REAL PLAYER? THIS POINTER WAS ALREADY REVERSIBLY WRITTEN IN AN EARLIER TEST, BUT THIS RUN ISOLATES ITS EFFECT ON SIZE.</span>
  </section>
}
