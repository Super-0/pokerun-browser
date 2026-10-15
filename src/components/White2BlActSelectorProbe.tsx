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
const BLACT_GEOM_FLAGS = 0x00
const BLACT_POSITION = 0x04
const BLACT_FACE_INDEX = 0x10
const BLACT_MAT_FLAGS = 0x18

const HANDLE_SIZE = 0x28
const HANDLE_BLACT_INDEX = 0x00
const HANDLE_MAT_ENTRY = 0x04
const HANDLE_FIELD_8 = 0x08
const HANDLE_FIELD_C = 0x0c

const STANDARD_NPC_SCENE_VTABLE = 0x021cf92c
const SPECIAL_PLAYER_COMPANION_UID = 0x00fe
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000
const TEST_MS = 1500
const REAPPLY_MS = 40

type Binding = {
  actor: White2ActorHeapEntry
  blActIndex: number
  blActAddress: number
  handleIndex: number
  handleAddress: number
}

type OriginalNpcRenderState = {
  matEntry: number
  field8: number
  fieldC: number
  geomFlags: number
  faceIndex: number
  matFlags: number
}

type TestKind = 'fieldC' | 'field8'

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

export function White2BlActSelectorProbe({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const [busy, setBusy] = useState<TestKind | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const supported = White2ActorSystemProbe.supportsRom(rom)

  async function resolveBinding(entry: White2ActorHeapEntry, sceneActors: number, actorCount: number, actorHandles: number, handleCount: number): Promise<Binding> {
    if (!bridge) throw new Error('melonDS bridge is unavailable.')
    const [wposX, wposY, wposZ] = await Promise.all([
      bridge.read32(entry.address + ACTOR_WPOS + 0x00),
      bridge.read32(entry.address + ACTOR_WPOS + 0x04),
      bridge.read32(entry.address + ACTOR_WPOS + 0x08),
    ])

    let blActIndex = -1
    let blActAddress = 0
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
        blActIndex = index
        blActAddress = address
      }
    }
    if (blActIndex < 0) throw new Error(`Could not resolve billboard actor for slot ${entry.index}.`)

    const handles: Array<{ index: number; address: number }> = []
    for (let index = 0; index < handleCount; index += 1) {
      const address = actorHandles + index * HANDLE_SIZE
      if ((await bridge.read32(address + HANDLE_BLACT_INDEX)) === blActIndex) handles.push({ index, address })
    }
    if (handles.length !== 1) throw new Error(`Expected one billboard handle for BlAct ${blActIndex}, found ${handles.length}.`)

    return { actor: entry, blActIndex, blActAddress, handleIndex: handles[0].index, handleAddress: handles[0].address }
  }

  async function captureRenderState(binding: Binding): Promise<OriginalNpcRenderState> {
    if (!bridge) throw new Error('melonDS bridge is unavailable.')
    const [matEntry, field8, fieldC, geomFlags, faceIndex, matFlags] = await Promise.all([
      bridge.read16(binding.handleAddress + HANDLE_MAT_ENTRY),
      bridge.read32(binding.handleAddress + HANDLE_FIELD_8),
      bridge.read32(binding.handleAddress + HANDLE_FIELD_C),
      bridge.read16(binding.blActAddress + BLACT_GEOM_FLAGS),
      bridge.read16(binding.blActAddress + BLACT_FACE_INDEX),
      bridge.read16(binding.blActAddress + BLACT_MAT_FLAGS),
    ])
    return { matEntry, field8, fieldC, geomFlags, faceIndex, matFlags }
  }

  async function applyState(binding: Binding, state: OriginalNpcRenderState, kind: TestKind) {
    if (!bridge) return
    await Promise.all([
      bridge.write16(binding.handleAddress + HANDLE_MAT_ENTRY, state.matEntry),
      bridge.write16(binding.blActAddress + BLACT_GEOM_FLAGS, state.geomFlags),
      bridge.write16(binding.blActAddress + BLACT_FACE_INDEX, state.faceIndex),
      bridge.write16(binding.blActAddress + BLACT_MAT_FLAGS, state.matFlags),
      kind === 'field8'
        ? bridge.write32(binding.handleAddress + HANDLE_FIELD_8, state.field8)
        : bridge.write32(binding.handleAddress + HANDLE_FIELD_C, state.fieldC),
    ])
  }

  async function restore(binding: Binding, original: OriginalNpcRenderState) {
    if (!bridge) return false
    const owner = await bridge.read32(binding.handleAddress + HANDLE_BLACT_INDEX)
    if (owner !== binding.blActIndex) return false
    await Promise.all([
      bridge.write16(binding.handleAddress + HANDLE_MAT_ENTRY, original.matEntry),
      bridge.write32(binding.handleAddress + HANDLE_FIELD_8, original.field8),
      bridge.write32(binding.handleAddress + HANDLE_FIELD_C, original.fieldC),
      bridge.write16(binding.blActAddress + BLACT_GEOM_FLAGS, original.geomFlags),
      bridge.write16(binding.blActAddress + BLACT_FACE_INDEX, original.faceIndex),
      bridge.write16(binding.blActAddress + BLACT_MAT_FLAGS, original.matFlags),
    ])
    const [matEntry, field8, fieldC, geomFlags, faceIndex, matFlags] = await Promise.all([
      bridge.read16(binding.handleAddress + HANDLE_MAT_ENTRY),
      bridge.read32(binding.handleAddress + HANDLE_FIELD_8),
      bridge.read32(binding.handleAddress + HANDLE_FIELD_C),
      bridge.read16(binding.blActAddress + BLACT_GEOM_FLAGS),
      bridge.read16(binding.blActAddress + BLACT_FACE_INDEX),
      bridge.read16(binding.blActAddress + BLACT_MAT_FLAGS),
    ])
    return matEntry === original.matEntry && field8 === original.field8 && fieldC === original.fieldC && geomFlags === original.geomFlags && faceIndex === original.faceIndex && matFlags === original.matFlags
  }

  async function run(kind: TestKind) {
    if (!bridge || !supported) return
    setBusy(kind)
    setResult(null)
    const wasRunning = bridge.status === 'running'
    let npcBinding: Binding | null = null
    let original: OriginalNpcRenderState | null = null

    try {
      if (!wasRunning) throw new Error('Billboard selector test requires melonDS to be running.')
      await bridge.pause()
      const scan = await new White2ActorSystemProbe(bridge).scanHeap()
      if (scan.suspiciousSlots.length) throw new Error('Selector test blocked because suspicious actor slots are present.')
      const player = scan.entries.find(entry => entry.state === 'player')
      if (!player) throw new Error('Player actor was not found.')
      const npc = chooseStandardNpc(scan.entries, player)
      if (!npc) throw new Error('No standard live NPC is available on this map.')

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

      const [playerBinding, resolvedNpc] = await Promise.all([
        resolveBinding(player, sceneActors, actorCount, actorHandles, handleCount),
        resolveBinding(npc, sceneActors, actorCount, actorHandles, handleCount),
      ])
      npcBinding = resolvedNpc
      const [playerState, npcState] = await Promise.all([
        captureRenderState(playerBinding),
        captureRenderState(resolvedNpc),
      ])
      original = npcState

      const owner = await bridge.read32(resolvedNpc.handleAddress + HANDLE_BLACT_INDEX)
      if (owner !== resolvedNpc.blActIndex) throw new Error('NPC billboard handle ownership changed before the test.')

      const target: OriginalNpcRenderState = {
        matEntry: playerState.matEntry,
        field8: playerState.field8,
        fieldC: playerState.fieldC,
        geomFlags: playerState.geomFlags,
        faceIndex: playerState.faceIndex,
        matFlags: playerState.matFlags,
      }

      await applyState(resolvedNpc, target, kind)
      await bridge.resume()
      const deadline = Date.now() + TEST_MS
      while (Date.now() < deadline) {
        const ownerNow = await bridge.read32(resolvedNpc.handleAddress + HANDLE_BLACT_INDEX)
        if (ownerNow !== resolvedNpc.blActIndex) throw new Error('NPC billboard handle changed ownership during the selector test.')
        await applyState(resolvedNpc, target, kind)
        await delay(REAPPLY_MS)
      }
      await bridge.pause()

      const observed = kind === 'field8'
        ? await bridge.read32(resolvedNpc.handleAddress + HANDLE_FIELD_8)
        : await bridge.read32(resolvedNpc.handleAddress + HANDLE_FIELD_C)
      const restored = await restore(resolvedNpc, npcState)
      if (!restored) throw new Error('Original NPC billboard state could not be verified after restoration.')

      const label = kind === 'field8' ? 'HANDLE +08 CONTROLLER-LIKE WORD' : 'HANDLE +0C OBJECT-CODE-LIKE WORD'
      const from = kind === 'field8' ? npcState.field8 : npcState.fieldC
      const to = kind === 'field8' ? playerState.field8 : playerState.fieldC
      setResult(`PASS • ${label} • NPC SLOT ${npc.index} / BLACT ${resolvedNpc.blActIndex} • 0x${hex(from)}→0x${hex(to)} • OBSERVED 0x${hex(observed)} • PLAYER MAT/GEOM/MATFLAGS/FACE ALSO APPLIED • ORIGINAL NPC STATE RESTORED`)
    } catch (reason) {
      if (npcBinding && original) {
        try {
          if (bridge.status === 'running') await bridge.pause()
          await restore(npcBinding, original)
        } catch { /* guarded best-effort restore */ }
      }
      setResult(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • BILLBOARD SELECTOR TEST FAILED.')
    } finally {
      if (wasRunning && bridge.status === 'paused') await bridge.resume()
      setBusy(null)
    }
  }

  return <section className="white2-memory-research pixel-border">
    <h2>WHITE 2 BILLBOARD SPRITE SELECTOR TESTS</h2>
    <p>The player/NPC handle diff narrowed the unresolved appearance selector to two strong candidates: +0x08 is pointer-like and differs with SpriteControllerType; +0x0C differs as 0x00030030 vs 0x00030028 and may carry an object/sprite code. Each test also applies the player's known material entry, face, geometry flags and material flags, then restores the NPC exactly.</p>
    <div className="memory-compare">
      <PixelButton tone="danger" disabled={!bridge || !supported || busy !== null} onClick={() => void run('fieldC')}>{busy === 'fieldC' ? 'TESTING +0C + RESTORING...' : 'TEST +0C OBJECT-CODE-LIKE WORD 1.5S'}</PixelButton>
      <PixelButton tone="danger" disabled={!bridge || !supported || busy !== null} onClick={() => void run('field8')}>{busy === 'field8' ? 'TESTING +08 + RESTORING...' : 'TEST +08 CONTROLLER-LIKE WORD 1.5S'}</PixelButton>
    </div>
    {!supported && <span className="form-error">DISABLED FOR THIS ROM FINGERPRINT.</span>}
    {result && <span className={result.startsWith('PASS') ? 'memory-ok' : 'form-error'}>{result}</span>}
    <span>WATCH THE BORROWED NPC DURING EACH TEST. RUN +0C FIRST. IF ONE TEST PRODUCES THE ACTUAL PROTAGONIST INSTEAD OF CHEREN/YOUNGSTER, THAT FIELD IS PART OF THE LIVE SPRITE SELECTOR.</span>
  </section>
}
