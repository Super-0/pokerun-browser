import { useEffect, useMemo, useState } from 'react'
import {
  MULTIPLAYER_PROTOCOL_VERSION,
  type MultiplayerConnectionState,
  type MultiplayerDirection,
  type MultiplayerMessage,
  type MultiplayerPlayer,
  type MultiplayerPlayerState,
  type MultiplayerRomIdentity,
  type MultiplayerRoom,
  type MultiplayerWorldPosition,
} from '../core/protocol'
import { BroadcastChannelTransport } from '../transports/BroadcastChannelTransport'

const TILE_WORLD = 0x10000
const STEP_MS = 40
const SUBSTEPS_PER_TILE = 6

type FakeRemoteSnapshot = {
  connection: MultiplayerConnectionState
  phase: string
  roomCode: string
  gameStarted: boolean
  hostState: MultiplayerPlayerState | null
  fakeState: MultiplayerPlayerState | null
  script: string | null
}

type Listener = (snapshot: FakeRemoteSnapshot) => void
type StripProtocolBase<T> = T extends unknown ? Omit<T, 'version' | 'senderId' | 'sentAt'> : never
type OutboundMessage = StripProtocolBase<MultiplayerMessage>

function sleep(ms: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms))
}

function worldFromGrid(x: number, y: number, height = 0x1000f): MultiplayerWorldPosition {
  return {
    x: Math.round((x + 0.5) * TILE_WORLD),
    y: height,
    z: Math.round((y + 0.5) * TILE_WORLD),
  }
}

function sameRom(a: MultiplayerRomIdentity, b: MultiplayerRomIdentity) {
  return a.status === b.status && a.gameId === b.gameId && a.sha256 === b.sha256
}

/**
 * Dev-only headless second player. It speaks the real multiplayer protocol over
 * the normal transport, but never creates a second emulator and never touches
 * MultiplayerPresence. That makes one visible White 2 instance see a deterministic
 * remote player without contaminating the local player's in-page presence state.
 */
class FakeRemotePeer {
  readonly playerId = `fake-remote-${crypto.randomUUID()}`
  private readonly transport = new BroadcastChannelTransport()
  private readonly listeners = new Set<Listener>()
  private unsubscribeMessage: (() => void) | null = null
  private unsubscribeConnection: (() => void) | null = null
  private room: MultiplayerRoom | null = null
  private roomCode = ''
  private startId = ''
  private sequence = 0
  private hostPlayerId = ''
  private hostState: MultiplayerPlayerState | null = null
  private fakeState: MultiplayerPlayerState | null = null
  private lastRomKey = ''
  private readyRequested = false
  private scriptGeneration = 0
  private script: string | null = null
  private snapshot: FakeRemoteSnapshot = {
    connection: 'disconnected',
    phase: 'WAITING FOR HOST ROOM',
    roomCode: '',
    gameStarted: false,
    hostState: null,
    fakeState: null,
    script: null,
  }

  connect() {
    if (this.unsubscribeMessage || this.unsubscribeConnection) return
    this.unsubscribeMessage = this.transport.onMessage(message => this.receive(message))
    this.unsubscribeConnection = this.transport.onConnectionChange(connection => {
      this.update({ connection, phase: connection === 'connected' ? this.snapshot.phase : connection.toUpperCase() })
    })
    this.transport.connect()
  }

  dispose() {
    this.stopScript()
    if (this.roomCode) this.send({ type: 'PLAYER_LEAVE', roomCode: this.roomCode, playerId: this.playerId })
    this.unsubscribeMessage?.()
    this.unsubscribeConnection?.()
    this.unsubscribeMessage = null
    this.unsubscribeConnection = null
    this.transport.disconnect()
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => this.listeners.delete(listener)
  }

  join(roomCode: string) {
    const normalized = roomCode.trim().toUpperCase()
    if (!/^[A-Z2-9]{6}$/.test(normalized) || normalized === this.roomCode) return
    if (this.roomCode) this.send({ type: 'PLAYER_LEAVE', roomCode: this.roomCode, playerId: this.playerId })

    this.stopScript()
    this.roomCode = normalized
    this.room = null
    this.startId = ''
    this.sequence = 0
    this.hostPlayerId = ''
    this.hostState = null
    this.fakeState = null
    this.lastRomKey = ''
    this.readyRequested = false
    this.update({ roomCode: normalized, gameStarted: false, hostState: null, fakeState: null, phase: `JOINING ${normalized}` })

    this.send({
      type: 'ROOM_JOIN',
      roomCode: normalized,
      player: this.fakePlayer({ gameId: 'white2', status: 'missing' }),
    })
  }

  resetBesideHost() {
    if (!this.hostState || !this.startId) return
    this.stopScript()
    const host = this.hostState
    const hostWorld = host.worldPosition ?? worldFromGrid(host.x, host.y)
    const state: MultiplayerPlayerState = {
      location: { ...host.location },
      x: host.x + 1,
      y: host.y,
      direction: 'west',
      movementState: 'idle',
      worldPosition: { x: hostWorld.x + TILE_WORLD, y: hostWorld.y, z: hostWorld.z },
    }
    this.publish(state)
    this.update({ phase: 'FAKE REMOTE RESET BESIDE HOST' })
  }

  async walk(direction: MultiplayerDirection, tiles = 1) {
    const generation = this.beginScript(`WALK ${direction.toUpperCase()} ×${tiles}`)
    await this.walkInternal(direction, tiles, generation)
    if (generation === this.scriptGeneration) this.finishScript('FAKE REMOTE IDLE')
  }

  async runSouthTest() {
    const generation = this.beginScript('SOUTH WALK TEST')
    if (!this.ensureFakeState()) return this.finishScript('WAITING FOR HOST GAME STATE')
    this.resetStateBesideHostWithoutStopping()
    await sleep(250)
    if (generation !== this.scriptGeneration) return
    await this.walkInternal('south', 4, generation)
    await sleep(500)
    if (generation !== this.scriptGeneration) return
    await this.walkInternal('north', 4, generation)
    if (generation === this.scriptGeneration) this.finishScript('SOUTH TEST COMPLETE')
  }

  async runOffscreenReturnTest() {
    const generation = this.beginScript('OFFSCREEN + RETURN TEST')
    if (!this.ensureFakeState()) return this.finishScript('WAITING FOR HOST GAME STATE')
    this.resetStateBesideHostWithoutStopping()
    await sleep(300)
    if (generation !== this.scriptGeneration) return
    await this.walkInternal('east', 6, generation)
    await sleep(900)
    if (generation !== this.scriptGeneration) return
    await this.walkInternal('west', 6, generation)
    if (generation === this.scriptGeneration) this.finishScript('OFFSCREEN TEST COMPLETE')
  }

  stopScript() {
    this.scriptGeneration += 1
    this.script = null
    if (this.fakeState && this.startId) this.publish({ ...this.fakeState, movementState: 'idle' })
    this.update({ script: null })
  }

  private beginScript(label: string) {
    this.stopScript()
    const generation = ++this.scriptGeneration
    this.script = label
    this.update({ script: label, phase: label })
    return generation
  }

  private finishScript(phase: string) {
    this.script = null
    if (this.fakeState && this.startId) this.publish({ ...this.fakeState, movementState: 'idle' })
    this.update({ script: null, phase })
  }

  private ensureFakeState() {
    if (this.fakeState) return true
    if (!this.hostState || !this.startId) return false
    this.resetStateBesideHostWithoutStopping()
    return Boolean(this.fakeState)
  }

  private resetStateBesideHostWithoutStopping() {
    if (!this.hostState || !this.startId) return
    const host = this.hostState
    const hostWorld = host.worldPosition ?? worldFromGrid(host.x, host.y)
    this.publish({
      location: { ...host.location },
      x: host.x + 1,
      y: host.y,
      direction: 'west',
      movementState: 'idle',
      worldPosition: { x: hostWorld.x + TILE_WORLD, y: hostWorld.y, z: hostWorld.z },
    })
  }

  private async walkInternal(direction: MultiplayerDirection, tiles: number, generation: number) {
    if (!this.ensureFakeState()) return
    const dx = direction === 'east' ? 1 : direction === 'west' ? -1 : 0
    const dy = direction === 'south' ? 1 : direction === 'north' ? -1 : 0

    for (let tile = 0; tile < tiles; tile += 1) {
      const start = this.fakeState!
      const startWorld = start.worldPosition ?? worldFromGrid(start.x, start.y)
      for (let step = 1; step <= SUBSTEPS_PER_TILE; step += 1) {
        if (generation !== this.scriptGeneration) return
        const fraction = step / SUBSTEPS_PER_TILE
        const finalStep = step === SUBSTEPS_PER_TILE
        this.publish({
          ...start,
          x: finalStep ? start.x + dx : start.x,
          y: finalStep ? start.y + dy : start.y,
          direction,
          movementState: 'moving',
          worldPosition: {
            x: Math.round(startWorld.x + dx * TILE_WORLD * fraction),
            y: startWorld.y,
            z: Math.round(startWorld.z + dy * TILE_WORLD * fraction),
          },
        })
        await sleep(STEP_MS)
      }
    }
  }

  private receive(message: MultiplayerMessage) {
    if (message.senderId === this.playerId || message.version !== MULTIPLAYER_PROTOCOL_VERSION) return

    if (message.type === 'ROOM_STATE' && message.room.code === this.roomCode) {
      this.room = message.room
      const me = message.room.players.find(player => player.id === this.playerId)
      const host = message.room.players.find(player => player.id !== this.playerId)
      if (!me) {
        this.update({ phase: 'ROOM REJECTED OR FULL' })
        return
      }

      if (host) this.hostPlayerId = host.id
      if (host?.rom.status === 'verified' && !sameRom(me.rom, host.rom)) {
        const romKey = `${host.rom.gameId}:${host.rom.sha256 ?? ''}`
        if (romKey !== this.lastRomKey) {
          this.lastRomKey = romKey
          this.readyRequested = false
          this.send({ type: 'PLAYER_ROM', roomCode: this.roomCode, playerId: this.playerId, rom: { ...host.rom, fileName: 'FAKE REMOTE • DEV ONLY' } })
          this.update({ phase: 'MIRRORING HOST ROM FINGERPRINT' })
        }
      } else if (me.rom.status === 'verified' && host?.rom.status === 'verified' && !me.ready && !this.readyRequested) {
        this.readyRequested = true
        this.send({ type: 'PLAYER_READY', roomCode: this.roomCode, playerId: this.playerId, ready: true })
        this.update({ phase: 'FAKE REMOTE READYING' })
      } else if (me.ready && !message.room.gameStart) {
        this.update({ phase: 'FAKE REMOTE READY • WAITING FOR HOST START' })
      }

      if (message.room.gameStart) this.activateStart(message.room.gameStart.startId)
      return
    }

    if (!this.roomCode || message.roomCode !== this.roomCode) return

    if (message.type === 'GAME_START') {
      this.activateStart(message.start.startId)
      return
    }

    if (message.type === 'GAME_STATE' && message.playerId !== this.playerId && (!this.startId || message.startId === this.startId)) {
      this.hostPlayerId = message.playerId
      this.hostState = message.state
      this.update({ hostState: message.state })
      if (this.startId && !this.fakeState) {
        this.resetStateBesideHostWithoutStopping()
        this.update({ phase: 'FAKE REMOTE ACTIVE BESIDE HOST' })
      }
    }
  }

  private activateStart(startId: string) {
    if (this.startId === startId) return
    this.startId = startId
    this.sequence = 0
    this.fakeState = null
    this.update({ gameStarted: true, fakeState: null, phase: 'GAME STARTED • WAITING FOR HOST POSITION' })
  }

  private publish(state: MultiplayerPlayerState) {
    if (!this.roomCode || !this.startId) return
    this.fakeState = state
    this.send({
      type: 'GAME_STATE',
      roomCode: this.roomCode,
      startId: this.startId,
      sequence: ++this.sequence,
      playerId: this.playerId,
      state,
    })
    this.update({ fakeState: state })
  }

  private fakePlayer(rom: MultiplayerRomIdentity): MultiplayerPlayer {
    return { id: this.playerId, label: 'FAKE REMOTE', ready: false, rom }
  }

  private send(message: OutboundMessage) {
    this.transport.send({
      ...message,
      version: MULTIPLAYER_PROTOCOL_VERSION,
      senderId: this.playerId,
      sentAt: Date.now(),
    } as MultiplayerMessage)
  }

  private update(change: Partial<FakeRemoteSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change }
    this.listeners.forEach(listener => listener(this.snapshot))
  }
}

export function FakeRemotePeerPanel({ roomCodeStorageKey }: { roomCodeStorageKey: string }) {
  const peer = useMemo(() => new FakeRemotePeer(), [])
  const [snapshot, setSnapshot] = useState<FakeRemoteSnapshot>({
    connection: 'disconnected',
    phase: 'WAITING FOR HOST ROOM',
    roomCode: '',
    gameStarted: false,
    hostState: null,
    fakeState: null,
    script: null,
  })

  useEffect(() => {
    const unsubscribe = peer.subscribe(setSnapshot)
    peer.connect()
    const timer = window.setInterval(() => {
      const roomCode = localStorage.getItem(roomCodeStorageKey)?.trim().toUpperCase() ?? ''
      if (roomCode) peer.join(roomCode)
    }, 100)
    return () => {
      window.clearInterval(timer)
      unsubscribe()
      peer.dispose()
    }
  }, [peer, roomCodeStorageKey])

  const controlsDisabled = !snapshot.gameStarted || !snapshot.hostState
  const fake = snapshot.fakeState
  const host = snapshot.hostState

  return <aside style={{
    position: 'fixed',
    right: 12,
    top: 12,
    zIndex: 10001,
    width: 286,
    padding: 10,
    background: 'rgba(244, 249, 252, 0.97)',
    border: '2px solid #35546b',
    boxShadow: '3px 3px 0 rgba(0,0,0,0.18)',
    color: '#243f54',
    fontSize: 11,
  }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <b>FAKE REMOTE PEER</b>
      <span>{snapshot.connection.toUpperCase()}</span>
    </div>
    <div style={{ marginTop: 4 }}>{snapshot.phase}</div>
    <div style={{ marginTop: 4, opacity: 0.75 }}>
      ROOM {snapshot.roomCode || '------'} • {snapshot.gameStarted ? 'GAME STARTED' : 'LOBBY'}
    </div>
    <div style={{ marginTop: 4, opacity: 0.75 }}>
      HOST {host ? `${host.location.mapId} • ${host.x},${host.y}` : 'WAITING'}<br/>
      FAKE {fake ? `${fake.location.mapId} • ${fake.x},${fake.y} • ${fake.direction.toUpperCase()}` : 'WAITING'}
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 10 }}>
      <button disabled={controlsDisabled} onClick={() => peer.resetBesideHost()}>RESET BESIDE ME</button>
      <button disabled={controlsDisabled} onClick={() => peer.stopScript()}>STOP</button>
      <button disabled={controlsDisabled} onClick={() => void peer.runSouthTest()}>SOUTH WALK TEST</button>
      <button disabled={controlsDisabled} onClick={() => void peer.runOffscreenReturnTest()}>OFFSCREEN + RETURN</button>
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 5, marginTop: 8 }}>
      <span/>
      <button disabled={controlsDisabled} onClick={() => void peer.walk('north')}>↑ N</button>
      <span/>
      <button disabled={controlsDisabled} onClick={() => void peer.walk('west')}>← W</button>
      <button disabled={controlsDisabled} onClick={() => void peer.walk('south')}>↓ S</button>
      <button disabled={controlsDisabled} onClick={() => void peer.walk('east')}>→ E</button>
    </div>

    <div style={{ marginTop: 8, opacity: 0.7 }}>
      One real emulator. The fake guest sends the same protocol packets as Player 2.
      {snapshot.script ? <><br/><b>RUNNING: {snapshot.script}</b></> : null}
    </div>
  </aside>
}