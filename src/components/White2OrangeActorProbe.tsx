import { useEffect, useRef } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../multiplayer/core/MultiplayerPresence'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2ActorSystemProbe } from '../multiplayer/games/White2ActorSystem'

const POLL_MS = 500
const NATIVE_COMM_UID = 0x00fc
const YOUNGSTER_MODEL_ID = 11
const NEARBY_RADIUS = 2

function hex(value: number) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

export function White2OrangeActorProbe({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const presenceRef = useRef<MultiplayerPresenceSnapshot>({ local: null, remote: null })

  useEffect(() => multiplayerPresence.subscribe(snapshot => {
    presenceRef.current = snapshot
  }), [])

  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return
    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    let cancelled = false
    let busy = false
    let lastKey = ''

    async function capture() {
      if (cancelled || busy || runtimeBridge.status !== 'running') return
      const remote = presenceRef.current.remote
      if (!remote) return
      busy = true
      try {
        const scan = await probe.scanHeap()
        const interesting = scan.entries
          .filter(entry => entry.state === 'active' || entry.state === 'player')
          .filter(entry => {
            const nearRemote = Math.abs(entry.x - remote.x) <= NEARBY_RADIUS && Math.abs(entry.y - remote.y) <= NEARBY_RADIUS
            return nearRemote || entry.modelId === YOUNGSTER_MODEL_ID || entry.uid === NATIVE_COMM_UID
          })
          .map(entry => ({
            slot: entry.index,
            actor: hex(entry.address),
            state: entry.state,
            uid: entry.uid,
            modelId: entry.modelId,
            grid: { x: entry.x, y: entry.y, height: entry.height },
            faceDir: entry.faceDir,
            tcb: hex(entry.tcb),
            moveCodeVTable: hex(entry.moveCodeVTable),
          }))

        const key = JSON.stringify({
          remote: { mapId: remote.location.mapId, x: remote.x, y: remote.y },
          interesting: interesting.map(actor => [actor.slot, actor.uid, actor.modelId, actor.grid.x, actor.grid.y]),
        })
        if (key === lastKey) return
        lastKey = key

        console.info('[PokéRun resdiag] ORANGE ACTOR IDENTITY', {
          purpose: 'identify the orange sprite without changing any actor state',
          remote: {
            mapId: remote.location.mapId,
            grid: { x: remote.x, y: remote.y },
            worldPosition: remote.worldPosition ?? null,
          },
          expectedNativeP2: { uid: NATIVE_COMM_UID, modelId: 240 },
          knownYoungsterSignature: { modelId: YOUNGSTER_MODEL_ID },
          interestingActors: interesting,
          conclusionHint: 'If the orange sprite is UID 1 / model 11 while UID 0xFC / model 240 is also present, orange is the native Youngster, not P2.',
        })
      } catch {
        // Field pointers are expected to be temporarily unavailable during boot/transitions.
      } finally {
        busy = false
      }
    }

    void capture()
    const timer = window.setInterval(() => void capture(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
