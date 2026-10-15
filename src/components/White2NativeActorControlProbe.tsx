import { useState } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2ActorSystemProbe, type White2ActorHeapEntry } from '../multiplayer/games/White2ActorSystem'
import { PixelButton } from './PixelButton'

const ACTOR_FACE_DIR = 0x18
const ACTOR_WPOS = 0x44
const STANDARD_NPC_SCENE_VTABLE = 0x021cf92c
const SPECIAL_PLAYER_COMPANION_UID = 0x00fe
const FX32_ONE = 4096
const TILE_WORLD_UNITS = 16
const TILE_FX32 = FX32_ONE * TILE_WORLD_UNITS
const TEST_MS = 1500
const REAPPLY_MS = 40
const DIR_LEFT = 2

type OriginalActorPose = {
  slot: number
  address: number
  uid: number
  modelId: number
  tcb: number
  face: number
  wposX: number
  wposY: number
  wposZ: number
}

function hex(value: number) {
  return value.toString(16).toUpperCase().padStart(8, '0')
}

function sameActor(entry: White2ActorHeapEntry | undefined, original: OriginalActorPose) {
  return !!entry && entry.state === 'active' && entry.uid === original.uid && entry.modelId === original.modelId && entry.tcb === original.tcb
}

/**
 * DEV-only proof that PokéRun can drive a second, independent native FieldActor.
 *
 * This deliberately does NOT create an actor or change ModelID/GPos. It borrows a
 * normal live NPC for 1.5 seconds, changes only WPos + FaceDir, then restores the
 * exact original values. Collision, scripts and grid position remain untouched.
 */
export function White2NativeActorControlProbe({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const supported = White2ActorSystemProbe.supportsRom(rom)

  async function restorePose(original: OriginalActorPose) {
    if (!bridge) return false
    const scan = await new White2ActorSystemProbe(bridge).scanHeap()
    const entry = scan.entries[original.slot]
    if (!sameActor(entry, original)) return false
    await Promise.all([
      bridge.write16(original.address + ACTOR_FACE_DIR, original.face),
      bridge.write32(original.address + ACTOR_WPOS + 0x00, original.wposX),
      bridge.write32(original.address + ACTOR_WPOS + 0x04, original.wposY),
      bridge.write32(original.address + ACTOR_WPOS + 0x08, original.wposZ),
    ])
    return (await bridge.read16(original.address + ACTOR_FACE_DIR)) === original.face &&
      (await bridge.read32(original.address + ACTOR_WPOS + 0x00)) === original.wposX &&
      (await bridge.read32(original.address + ACTOR_WPOS + 0x04)) === original.wposY &&
      (await bridge.read32(original.address + ACTOR_WPOS + 0x08)) === original.wposZ
  }

  async function runProbe() {
    if (!bridge || !supported) return
    setBusy(true)
    setResult(null)
    const wasRunning = bridge.status === 'running'
    let timer: number | null = null
    let original: OriginalActorPose | null = null

    try {
      if (!wasRunning) throw new Error('Native actor control test requires melonDS to be running.')
      await bridge.pause()

      const actorSystem = new White2ActorSystemProbe(bridge)
      const scan = await actorSystem.scanHeap()
      if (scan.suspiciousSlots.length) throw new Error('Native actor control test blocked because suspicious actor slots are present.')
      const player = scan.playerActor
      if (!player) throw new Error('Native actor control test blocked because the player actor was not found.')

      const candidates = scan.entries
        .filter(entry => entry.state === 'active' && entry.uid !== SPECIAL_PLAYER_COMPANION_UID && entry.sceneNodeVTable === STANDARD_NPC_SCENE_VTABLE)
        .sort((a, b) => (Math.abs(a.x - player.x) + Math.abs(a.y - player.y)) - (Math.abs(b.x - player.x) + Math.abs(b.y - player.y)))
      const candidate = candidates[0]
      if (!candidate) throw new Error('No standard live NPC actor is available on this map. Try the MAP 428 room from the lifecycle trace.')

      const [face, wposX, wposY, wposZ, playerWPosX, playerWPosY, playerWPosZ] = await Promise.all([
        bridge.read16(candidate.address + ACTOR_FACE_DIR),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x00),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x04),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x08),
        bridge.read32(player.address + ACTOR_WPOS + 0x00),
        bridge.read32(player.address + ACTOR_WPOS + 0x04),
        bridge.read32(player.address + ACTOR_WPOS + 0x08),
      ])

      original = { slot: candidate.index, address: candidate.address, uid: candidate.uid, modelId: candidate.modelId, tcb: candidate.tcb, face, wposX, wposY, wposZ }
      const targetX = (playerWPosX + TILE_FX32) >>> 0
      const targetY = playerWPosY >>> 0
      const targetZ = playerWPosZ >>> 0

      const applyTarget = async () => {
        await Promise.all([
          bridge.write16(candidate.address + ACTOR_FACE_DIR, DIR_LEFT),
          bridge.write32(candidate.address + ACTOR_WPOS + 0x00, targetX),
          bridge.write32(candidate.address + ACTOR_WPOS + 0x04, targetY),
          bridge.write32(candidate.address + ACTOR_WPOS + 0x08, targetZ),
        ])
      }

      await applyTarget()
      const initialReadback = await Promise.all([
        bridge.read16(candidate.address + ACTOR_FACE_DIR),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x00),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x04),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x08),
      ])
      if (initialReadback[0] !== DIR_LEFT || initialReadback[1] !== targetX || initialReadback[2] !== targetY || initialReadback[3] !== targetZ) {
        throw new Error('Native NPC WPos/facing write did not read back correctly.')
      }

      await bridge.resume()
      timer = window.setInterval(() => { void applyTarget() }, REAPPLY_MS)
      await new Promise<void>(resolve => window.setTimeout(resolve, TEST_MS))
      window.clearInterval(timer)
      timer = null
      await bridge.pause()

      const afterScan = await actorSystem.scanHeap()
      const afterEntry = afterScan.entries[candidate.index]
      if (!sameActor(afterEntry, original)) throw new Error(`Slot ${candidate.index} changed identity while the native actor test was running; original pose was not written into the replacement actor.`)

      const observed = await Promise.all([
        bridge.read32(candidate.address + ACTOR_WPOS + 0x00),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x04),
        bridge.read32(candidate.address + ACTOR_WPOS + 0x08),
      ])
      const restored = await restorePose(original)
      if (!restored) throw new Error(`Native NPC slot ${candidate.index} could not be verified after restoring its original pose.`)

      setResult(`PASS • NATIVE NPC SLOT ${candidate.index} • UID ${candidate.uid} • MODEL ${candidate.modelId} • MOVED BESIDE PLAYER FOR ${TEST_MS}MS • OBSERVED WPOS 0x${hex(observed[0])}/0x${hex(observed[1])}/0x${hex(observed[2])} • ORIGINAL POSE RESTORED`)
    } catch (reason) {
      if (timer !== null) window.clearInterval(timer)
      if (original) {
        try {
          if (bridge.status === 'running') await bridge.pause()
          await restorePose(original)
        } catch { /* best-effort restore; identity guard prevents touching a replacement actor */ }
      }
      setResult(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • NATIVE ACTOR CONTROL TEST FAILED.')
    } finally {
      if (wasRunning && bridge.status === 'paused') await bridge.resume()
      setBusy(false)
    }
  }

  return <section className="white2-memory-research pixel-border">
    <h2>WHITE 2 NATIVE SECOND-ACTOR CONTROL</h2>
    <p>This is the next proof before native partner spawning: temporarily move an already-live standard NPC beside the player using only that NPC's native WPos and FaceDir, then restore it. Model, grid position, collision and script fields are not changed.</p>
    <div className="memory-compare">
      <PixelButton tone="danger" disabled={!bridge || !supported || busy} onClick={() => void runProbe()}>{busy ? 'MOVING NPC + RESTORING...' : 'MOVE NEAREST NPC BESIDE PLAYER 1.5S + RESTORE'}</PixelButton>
    </div>
    {!supported && <span className="form-error">DISABLED FOR THIS ROM FINGERPRINT.</span>}
    {result && <span className={result.startsWith('PASS') ? 'memory-ok' : 'form-error'}>{result}</span>}
    <span>WATCH THE TOP SCREEN. A REAL IN-GAME NPC SHOULD SNAP ONE TILE TO YOUR RIGHT FOR 1.5 SECONDS, FACE LEFT, THEN RETURN. STAND STILL AND DO NOT CROSS A MAP BOUNDARY DURING THE TEST.</span>
  </section>
}
