import { useEffect, useState } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../core/protocol'
import { White2ActorSystemProbe } from './White2ActorSystem'
import { White2NativeCommCutoverRuntime } from './White2NativeCommCutoverRuntime'

// Probe 10 stabilization gate. White 2 briefly swaps the real player to
// temporary field object codes during boot/save-style field setup. The native
// comm actor keeps the model it was created with, so creating P2 during one of
// those transient frames can permanently bind that temporary animation/model.
// Wait until the local player has held a normal overworld hero/heroine model
// and the field scheduler is valid before mounting the cutover runtime.
const OBJ_CODE_HERO = 231
const OBJ_CODE_HEROINE = 240
const MMSYS_TCB_MGR = 0x24
const POLL_MS = 100
const STABLE_MS = 900
const MAIN_RAM_START = 0x02000000
const MAIN_RAM_END = 0x02400000

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= MAIN_RAM_START && value < MAIN_RAM_END && (value & 3) === 0
}

function isNormalPlayerModel(modelId: number) {
  return modelId === OBJ_CODE_HERO || modelId === OBJ_CODE_HEROINE
}

export function White2NativeCommStableCutoverRuntime({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setReady(false)
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return

    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    let cancelled = false
    let busy = false
    let stableModel: number | null = null
    let stableSince = 0

    async function poll() {
      if (cancelled || busy || ready || runtimeBridge.status !== 'running') return
      busy = true
      try {
        const scan = await probe.scanHeap()
        const player = scan.entries.find(entry => entry.state === 'player')
        const tcbManager = await runtimeBridge.read32(scan.actorSystem + MMSYS_TCB_MGR)
        const modelId = player?.modelId ?? -1
        const healthy = Boolean(
          player
          && isNormalPlayerModel(modelId)
          && isMainRamPointer(player.tcb)
          && player.actorSystemBackptr === scan.actorSystem
          && isMainRamPointer(player.sceneNodeVTable)
          && isMainRamPointer(tcbManager)
        )

        if (!healthy) {
          stableModel = null
          stableSince = 0
          return
        }

        const now = performance.now()
        if (stableModel !== modelId) {
          stableModel = modelId
          stableSince = now
          return
        }

        if (now - stableSince < STABLE_MS) return

        console.info('[PokéRun lifecycle] NATIVE COMM CUTOVER GATE READY', {
          modelId,
          stableMs: Math.round(now - stableSince),
          actorSystem: `0x${scan.actorSystem.toString(16).toUpperCase().padStart(8, '0')}`,
          tcbManager: `0x${tcbManager.toString(16).toUpperCase().padStart(8, '0')}`,
          note: 'Normal overworld hero/heroine model is stable; Probe 10 may create native P2 now.',
        })
        if (!cancelled) setReady(true)
      } catch {
        stableModel = null
        stableSince = 0
      } finally {
        busy = false
      }
    }

    void poll()
    const timer = window.setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [bridge, rom.gameId, rom.sha256, ready])

  return ready ? <White2NativeCommCutoverRuntime bridge={bridge} rom={rom}/> : null
}
