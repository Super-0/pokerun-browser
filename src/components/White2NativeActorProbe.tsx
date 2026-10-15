import { useEffect, useRef, useState } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2ActorSystemProbe } from '../multiplayer/games/White2ActorSystem'
import { White2NativeActorBridge } from '../multiplayer/games/White2NativeActor'

function hex(value: number) {
  return `0x${value.toString(16).toUpperCase().padStart(8, '0')}`
}

function delay(ms: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms))
}

/** Dev-only gate before replacing the borrowed-NPC multiplayer renderer. */
export function White2NativeActorProbe({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const [status, setStatus] = useState('NATIVE CALL GATE NOT VALIDATED')
  const [validated, setValidated] = useState(false)
  const [busy, setBusy] = useState(false)
  const spawnedRef = useRef<number | null>(null)
  const supported = White2ActorSystemProbe.supportsRom(rom)

  useEffect(() => {
    setValidated(false)
    setStatus(supported ? 'NATIVE CALL GATE NOT VALIDATED' : 'EXACT WHITE 2 ROM REQUIRED')
    spawnedRef.current = null
  }, [bridge, rom.gameId, rom.sha256, supported])

  useEffect(() => () => {
    const address = spawnedRef.current
    spawnedRef.current = null
    if (!bridge || !address || !supported) return
    void new White2NativeActorBridge(bridge, rom).deleteTestActor(address).catch(() => undefined)
  }, [bridge, rom.gameId, rom.sha256, supported])

  async function validate() {
    if (!bridge || !supported || busy) return
    setBusy(true)
    setValidated(false)
    setStatus('VALIDATING READ-ONLY FINDFIELDACTOR CALL...')
    try {
      const result = await new White2NativeActorBridge(bridge, rom).validateCallGate()
      setValidated(true)
      setStatus(`PASS • NATIVE CALL GATE • PLAYER ${hex(result.playerAddress)} • ACTOR SYSTEM ${hex(result.actorSystem)} • SP ${hex(result.stackPointer)}`)
    } catch (error) {
      setStatus(`FAIL • ${error instanceof Error ? error.message.toUpperCase() : String(error).toUpperCase()}`)
    } finally {
      setBusy(false)
    }
  }

  async function spawnTest() {
    if (!bridge || !supported || !validated || busy) return
    setBusy(true)
    const native = new White2NativeActorBridge(bridge, rom)
    try {
      setStatus('CREATING GAME-NATIVE DEDICATED TRAINER...')
      const spawned = await native.spawnTestActor()
      spawnedRef.current = spawned.actorAddress
      setStatus(`SPAWNED • ${hex(spawned.actorAddress)} • UID ${hex(spawned.uid)} • MODEL ${spawned.modelId} • TILE ${spawned.x},${spawned.z} • WATCH FOR 4 SECONDS`)
      await delay(4000)
      await native.deleteTestActor(spawned.actorAddress)
      spawnedRef.current = null
      setStatus(`PASS • DEDICATED NATIVE ACTOR CREATED + DELETED CLEANLY • ${hex(spawned.actorAddress)} • NO NPC BORROWED`)
    } catch (error) {
      const address = spawnedRef.current
      spawnedRef.current = null
      if (address) await native.deleteTestActor(address).catch(() => undefined)
      setStatus(`FAIL • ${error instanceof Error ? error.message.toUpperCase() : String(error).toUpperCase()}`)
    } finally {
      setBusy(false)
    }
  }

  return <section className="multiplayer-debug pixel-border">
    <h2>WHITE 2 DEDICATED NATIVE ACTOR • PHASE 1</h2>
    <p>This probe first calls White 2's own read-only actor lookup. Only after that passes can it create one temporary game-native trainer beside the player, leave it for four seconds, then call the game's own DeleteActor cleanup.</p>
    <div className="probe-actions">
      <button disabled={!bridge || !supported || busy} onClick={() => void validate()}>VALIDATE NATIVE CALL GATE</button>
      <button disabled={!bridge || !supported || !validated || busy} onClick={() => void spawnTest()}>SPAWN DEDICATED ACTOR 4S + DELETE</button>
    </div>
    <code>{status}</code>
  </section>
}
