import { useEffect } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../core/protocol'
import { White2ActorSystemProbe } from './White2ActorSystem'

// White 2's FieldCommActor intentionally disables movement-bit terrain effects,
// which also bypasses ActorTerrainEffect_AddShadow. For PokéRun's visible remote
// trainer we explicitly start White 2's normal shadow field-effect task once.
const NATIVE_COMM_UID = 0x00fc
const FLD_ACT_GET_FIELD_EFFECTS = 0x02194f18
const FLDEFF_SHADOW_START = 0x021a3c30
const ACTOR_MOVEMENT_FLAGS = 0x04
const ACTOR_MOVEMENT_FLAG_SHADOW_STARTED = 0x4000
const NATIVE_STACK_RESERVE = 0x400
const POLL_MS = 100

function hex(value: number) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= 0x02000000 && value < 0x02400000 && (value & 3) === 0
}

export function White2NativeCommShadowRuntime({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return

    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    let cancelled = false
    let busy = false
    let boundActor = 0
    let lastError = ''

    async function tick() {
      if (cancelled || busy || runtimeBridge.status !== 'running') return
      busy = true
      try {
        const scan = await probe.scanHeap()
        const remote = scan.entries.find(entry => entry.uid === NATIVE_COMM_UID && entry.state === 'active')
        if (!remote) {
          boundActor = 0
          return
        }

        if (boundActor === remote.address) return

        const movementFlags = await runtimeBridge.read32(remote.address + ACTOR_MOVEMENT_FLAGS)
        if ((movementFlags & ACTOR_MOVEMENT_FLAG_SHADOW_STARTED) !== 0) {
          boundActor = remote.address
          return
        }

        const effectsCall = await runtimeBridge.callArm9Thumb4(
          FLD_ACT_GET_FIELD_EFFECTS,
          remote.address,
          0,
          0,
          0,
          NATIVE_STACK_RESERVE,
        )
        if (effectsCall.status !== 1 || !isMainRamPointer(effectsCall.result)) {
          throw new Error(`FldAct_GetFieldEffects failed for ${hex(remote.address)} (status ${effectsCall.status}, result ${hex(effectsCall.result)}).`)
        }

        const shadowCall = await runtimeBridge.callArm9Thumb4(
          FLDEFF_SHADOW_START,
          remote.address,
          effectsCall.result,
          0,
          0,
          NATIVE_STACK_RESERVE,
        )
        if (shadowCall.status !== 1) {
          throw new Error(`FldeffShadow_Start failed for ${hex(remote.address)} (status ${shadowCall.status}).`)
        }

        // Match ActorTerrainEffect_AddShadow: once the task exists, mark 0x4000
        // so no second shadow task is started for the same FieldActor.
        await runtimeBridge.write32(
          remote.address + ACTOR_MOVEMENT_FLAGS,
          (movementFlags | ACTOR_MOVEMENT_FLAG_SHADOW_STARTED) >>> 0,
        )

        boundActor = remote.address
        lastError = ''
        console.info('[PokéRun lifecycle] NATIVE COMM SHADOW READY', {
          actor: hex(remote.address),
          fieldEffects: hex(effectsCall.result),
          movementFlagsBefore: hex(movementFlags),
          movementFlagsAfter: hex((movementFlags | ACTOR_MOVEMENT_FLAG_SHADOW_STARTED) >>> 0),
          note: 'White 2 native FldeffShadow task is now following P2.',
        })
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason)
        if (message !== lastError) {
          lastError = message
          console.info('[PokéRun resdiag] NATIVE COMM SHADOW RESULT', {
            ok: false,
            reason: message,
          })
        }
      } finally {
        busy = false
      }
    }

    void tick()
    const timer = window.setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
