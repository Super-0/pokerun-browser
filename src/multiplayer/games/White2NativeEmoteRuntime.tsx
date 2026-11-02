import { useEffect, useRef } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence } from '../core/MultiplayerPresence'
import type { MultiplayerEmoteKind, MultiplayerRomIdentity } from '../core/protocol'
import { White2ActorSystemProbe } from './White2ActorSystem'

const NATIVE_COMM_UID = 0x00fc
const FLD_ACT_GET_FIELD_EFFECTS = 0x02194f18
const FLDEFF_EMOTION_BUBBLE_START_HELD = 0x021b3f9c
const NATIVE_STACK_RESERVE = 0x400

// White 2's native emotion-bubble assets are:
// 0 = !, 1 = ?, 2 = music note, 3 = ellipsis.
// Keep the current social protocol stable during the native-render probe; the
// menu/protocol names will be cut over after the native effect is proven.
function nativeKind(kind: MultiplayerEmoteKind) {
  if (kind === 'surprised') return 0
  if (kind === 'hello') return 2
  if (kind === 'cheer') return 2
  return 3
}

function hex(value: number) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= 0x02000000 && value < 0x02400000 && (value & 3) === 0
}

export function White2NativeEmoteRuntime({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const handledLocal = useRef('')
  const handledRemote = useRef('')

  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return

    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    let cancelled = false
    let busy = false

    async function play(actor: number, kind: MultiplayerEmoteKind, source: 'local' | 'remote', id: string) {
      const effectsCall = await runtimeBridge.callArm9Thumb4(
        FLD_ACT_GET_FIELD_EFFECTS,
        actor,
        0,
        0,
        0,
        NATIVE_STACK_RESERVE,
      )
      if (effectsCall.status !== 1 || !isMainRamPointer(effectsCall.result)) {
        throw new Error(`FldAct_GetFieldEffects failed for ${hex(actor)} (status ${effectsCall.status}, result ${hex(effectsCall.result)}).`)
      }

      const effectCall = await runtimeBridge.callArm9Thumb4(
        FLDEFF_EMOTION_BUBBLE_START_HELD,
        effectsCall.result,
        actor,
        nativeKind(kind),
        1,
        NATIVE_STACK_RESERVE,
      )
      if (effectCall.status !== 1 || !isMainRamPointer(effectCall.result)) {
        throw new Error(`FldeffEmotionBubble_StartHeld failed for ${hex(actor)} (status ${effectCall.status}, result ${hex(effectCall.result)}).`)
      }

      console.info('[PokéRun interaction] NATIVE WHITE 2 EMOTE', {
        source,
        id,
        protocolKind: kind,
        nativeKind: nativeKind(kind),
        actor: hex(actor),
        fieldEffects: hex(effectsCall.result),
        task: hex(effectCall.result),
        lifecycle: 'auto-end',
      })
    }

    const unsubscribe = multiplayerPresence.subscribe(snapshot => {
      if (cancelled || busy || runtimeBridge.status !== 'running') return
      const localEmote = snapshot.local?.emote
      const remoteEmote = snapshot.remote?.emote
      const wantsLocal = localEmote && localEmote.id !== handledLocal.current
      const wantsRemote = remoteEmote && remoteEmote.id !== handledRemote.current
      if (!wantsLocal && !wantsRemote) return

      busy = true
      void (async () => {
        try {
          const scan = await probe.scanHeap()
          if (cancelled) return

          if (wantsLocal && localEmote) {
            // Mark before invoking the native call so a failing field effect does
            // not loop every presence update and destabilize the field runtime.
            handledLocal.current = localEmote.id
            if (scan.playerActor) {
              await play(scan.playerActor.address, localEmote.kind, 'local', localEmote.id)
            } else {
              console.info('[PokéRun interaction] NATIVE LOCAL EMOTE SKIPPED', { id: localEmote.id, reason: 'player actor unavailable' })
            }
          }

          if (wantsRemote && remoteEmote) {
            handledRemote.current = remoteEmote.id
            const remote = scan.entries.find(entry => entry.uid === NATIVE_COMM_UID && entry.state === 'active')
            if (remote) {
              await play(remote.address, remoteEmote.kind, 'remote', remoteEmote.id)
            } else {
              console.info('[PokéRun interaction] NATIVE REMOTE EMOTE SKIPPED', { id: remoteEmote.id, reason: 'remote FieldCommActor unavailable' })
            }
          }
        } catch (reason) {
          console.info('[PokéRun interaction] NATIVE EMOTE FAILED', {
            reason: reason instanceof Error ? reason.message : String(reason),
          })
        } finally {
          busy = false
        }
      })()
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [bridge, rom.gameId, rom.sha256])

  // During the native-emote probe, keep the existing HTML menu as the selector
  // but explicitly suppress its old emote renderer. The menu itself is the next
  // native subsystem to replace after this field-effect call is proven.
  return <style>{`.w2-emote-bubble { display: none !important; }`}</style>
}
