import { useState } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2ActorSystemProbe } from '../multiplayer/games/White2ActorSystem'
import { PixelButton } from './PixelButton'

const ACTOR_SYSTEM_FIELD_BLACT = 0x28
const ACTOR_WPOS = 0x44
const ACTOR_UID = 0x08
const ACTOR_FACE_DIR = 0x18
const ACTOR_MOTION_DIR = 0x1a
const ACTOR_TCB = 0x84
const FIELD_BLACT_SYSTEM = 0x04
const BLACT_SYSTEM_SCENE = 0x04
const BLACT_SCENE_ACTORS = 0x08
const BLACT_SCENE_CONFIG_ACTOR_COUNT = 0x0e
const BLACT_SIZE = 0x1c
const BLACT_POSITION = 0x04
const BLACT_FACE_INDEX = 0x10
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000
const SAMPLE_MS = 10_000
const SAMPLE_INTERVAL_MS = 50

const DIR_NAME: Record<number, string> = {
  0: 'NORTH',
  1: 'SOUTH',
  2: 'WEST',
  3: 'EAST',
}

type Sample = {
  faceDir: number
  motionDir: number
  blActFace: number
  x: number
  z: number
  moving: boolean
}

type Result = {
  playerSlot: number
  blActIndex: number
  samples: Sample[]
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

function delay(ms: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms))
}

function uniqueSorted(values: number[]) {
  return [...new Set(values)].sort((a, b) => a - b)
}

export function White2TrainerBillboardFaceProbe({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const supported = White2ActorSystemProbe.supportsRom(rom)

  async function runSampler() {
    if (!bridge || !supported) return
    setBusy(true)
    setStatus(null)
    setResult(null)
    const wasRunning = bridge.status === 'running'

    try {
      if (!wasRunning) throw new Error('Trainer frame sampler requires melonDS to be running.')
      await bridge.pause()

      const scan = await new White2ActorSystemProbe(bridge).scanHeap()
      const player = scan.entries.find(entry => entry.state === 'player')
      if (!player) throw new Error('Player actor was not found.')

      const fieldBlAct = await bridge.read32(scan.actorSystem + ACTOR_SYSTEM_FIELD_BLACT)
      if (!isMainRamPointer(fieldBlAct)) throw new Error(`FieldBlAct pointer is invalid (0x${hex(fieldBlAct)}).`)
      const blActSystem = await bridge.read32(fieldBlAct + FIELD_BLACT_SYSTEM)
      if (!isMainRamPointer(blActSystem)) throw new Error(`BlActSystem pointer is invalid (0x${hex(blActSystem)}).`)
      const scene = await bridge.read32(blActSystem + BLACT_SYSTEM_SCENE)
      if (!isMainRamPointer(scene)) throw new Error(`BlActScene pointer is invalid (0x${hex(scene)}).`)
      const [sceneActors, actorCount] = await Promise.all([
        bridge.read32(scene + BLACT_SCENE_ACTORS),
        bridge.read16(scene + BLACT_SCENE_CONFIG_ACTOR_COUNT),
      ])
      if (!isMainRamPointer(sceneActors)) throw new Error(`BlAct actor array pointer is invalid (0x${hex(sceneActors)}).`)
      if (actorCount < 1 || actorCount > 256) throw new Error(`BlAct actor count is unexpected (${actorCount}).`)

      const [wposX, wposY, wposZ, uid, tcb] = await Promise.all([
        bridge.read32(player.address + ACTOR_WPOS + 0x00),
        bridge.read32(player.address + ACTOR_WPOS + 0x04),
        bridge.read32(player.address + ACTOR_WPOS + 0x08),
        bridge.read16(player.address + ACTOR_UID),
        bridge.read32(player.address + ACTOR_TCB),
      ])

      let bestIndex = -1
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
        }
      }
      if (bestIndex < 0) throw new Error('Could not resolve the player billboard actor.')

      const blActAddress = sceneActors + bestIndex * BLACT_SIZE
      await bridge.resume()

      const samples: Sample[] = []
      const deadline = Date.now() + SAMPLE_MS
      let previousX = wposX
      let previousZ = wposZ

      while (Date.now() < deadline) {
        const [uidNow, tcbNow, faceDir, motionDir, x, z, blActFace] = await Promise.all([
          bridge.read16(player.address + ACTOR_UID),
          bridge.read32(player.address + ACTOR_TCB),
          bridge.read16(player.address + ACTOR_FACE_DIR),
          bridge.read16(player.address + ACTOR_MOTION_DIR),
          bridge.read32(player.address + ACTOR_WPOS + 0x00),
          bridge.read32(player.address + ACTOR_WPOS + 0x08),
          bridge.read16(blActAddress + BLACT_FACE_INDEX),
        ])
        if (uidNow !== uid || tcbNow !== tcb) throw new Error('Player actor changed identity during sampling; cross no map boundaries while sampling.')
        const moving = x !== previousX || z !== previousZ
        samples.push({ faceDir, motionDir, blActFace, x, z, moving })
        previousX = x
        previousZ = z
        await delay(SAMPLE_INTERVAL_MS)
      }

      setResult({ playerSlot: player.index, blActIndex: bestIndex, samples })
      setStatus(`PASS • CAPTURED ${samples.length} PLAYER BILLBOARD FRAME SAMPLES OVER ${SAMPLE_MS / 1000}S`)
    } catch (reason) {
      setStatus(reason instanceof Error ? `FAIL • ${reason.message.toUpperCase()}` : 'FAIL • TRAINER FRAME SAMPLER FAILED.')
    } finally {
      if (wasRunning && bridge.status === 'paused') await bridge.resume()
      setBusy(false)
    }
  }

  function summaryLines() {
    if (!result) return []
    const lines = [
      'WHITE 2 PLAYER BILLBOARD FRAME MAP',
      `PLAYER SLOT ${result.playerSlot} • BLACT ${result.blActIndex} • SAMPLES ${result.samples.length}`,
    ]
    for (const direction of [0, 1, 2, 3]) {
      const dirSamples = result.samples.filter(sample => sample.faceDir === direction)
      const idle = uniqueSorted(dirSamples.filter(sample => !sample.moving).map(sample => sample.blActFace))
      const moving = uniqueSorted(dirSamples.filter(sample => sample.moving).map(sample => sample.blActFace))
      const motions = uniqueSorted(dirSamples.map(sample => sample.motionDir))
      lines.push(`${DIR_NAME[direction]} • N ${dirSamples.length} • IDLE FACES ${idle.length ? idle.join(',') : 'NONE'} • MOVING FACES ${moving.length ? moving.join(',') : 'NONE'} • MOTIONDIR ${motions.length ? motions.join(',') : 'NONE'}`)
    }
    const other = result.samples.filter(sample => !(sample.faceDir in DIR_NAME))
    if (other.length) lines.push(`OTHER FACEDIR VALUES • ${uniqueSorted(other.map(sample => sample.faceDir)).join(',')}`)
    return lines
  }

  async function copyResult() {
    const lines = summaryLines()
    if (!lines.length) return
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setStatus('PLAYER BILLBOARD FRAME MAP COPIED.')
    } catch {
      setStatus('COPY FAILED: BROWSER CLIPBOARD PERMISSION WAS DENIED.')
    }
  }

  return <section className="white2-memory-research pixel-border">
    <h2>WHITE 2 TRAINER BILLBOARD FRAME SAMPLER</h2>
    <p>The material swap proved that the native NPC can render with the trainer atlas. This read-only sampler learns which BlAct FaceIdx values White 2 uses for each player direction so the remote proxy can use coherent trainer frames instead of inheriting an NPC animation controller.</p>
    <div className="memory-compare">
      <PixelButton tone="ghost" disabled={!bridge || !supported || busy} onClick={() => void runSampler()}>{busy ? 'SAMPLING PLAYER FRAMES 10S...' : 'LEARN PLAYER SPRITE FRAMES 10S'}</PixelButton>
      <PixelButton tone="ghost" disabled={!result || busy} onClick={() => void copyResult()}>COPY PLAYER FRAME MAP</PixelButton>
    </div>
    {!supported && <span className="form-error">DISABLED FOR THIS ROM FINGERPRINT.</span>}
    {status && <span className={status.startsWith('FAIL') ? 'form-error' : 'memory-ok'}>{status}</span>}
    {result && <div className="memory-results">{summaryLines().map((line, index) => <code key={index}>{line}</code>)}</div>}
    <span>DURING THE 10-SECOND SAMPLE, TAP/STEP NORTH, SOUTH, WEST AND EAST WITHOUT CROSSING A MAP BOUNDARY. A FEW STEPS IN EACH DIRECTION IS ENOUGH.</span>
  </section>
}
