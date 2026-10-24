import { useEffect, useMemo, useState } from 'react'
import {
  MULTIPLAYER_PROTOCOL_VERSION,
  type MultiplayerConnectionState,
  type MultiplayerMapTransition,
  type MultiplayerMessage,
  type MultiplayerPlayer,
  type MultiplayerPlayerState,
  type MultiplayerRomIdentity,
  type MultiplayerRoom,
  type MultiplayerWorldPosition,
} from '../core/protocol'
import { BroadcastChannelTransport } from '../transports/BroadcastChannelTransport'

const TILE_WORLD = 0x10000
const MAX_REPLAY_IDLE_GAP_MS = 1000
const DOOR_APPROACH_STEP_MS = 40
const DOOR_APPROACH_MIN_STEPS = 6
const DOOR_APPROACH_READY_HOLD_MS = 120

type RecordedPathFrame = {
  elapsedMs: number
  state: MultiplayerPlayerState
}

type FakeRemoteSnapshot = {
  connection: MultiplayerConnectionState
  phase: string
  roomCode: string
  gameStarted: boolean
  hostState: MultiplayerPlayerState | null
  fakeState: MultiplayerPlayerState | null
  script: string | null
  recordingPath: boolean
  recordedFrames: number
  recordedDurationMs: number
  doorCaptureArmed: boolean
  capturedDoorTransition: MultiplayerMapTransition | null
}

type Listener = (snapshot: FakeRemoteSnapshot) => void
type StripProtocolBase<T> = T extends unknown ? Omit<T, 'version' | 'senderId' | 'sentAt'> : never
type OutboundMessage = StripProtocolBase<MultiplayerMessage>

function sleep(ms: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms))
}

function cloneTransition(transition: MultiplayerMapTransition): MultiplayerMapTransition {
  return {
    ...transition,
    fromWorldPosition: transition.fromWorldPosition ? { ...transition.fromWorldPosition } : undefined,
    toWorldPosition: transition.toWorldPosition ? { ...transition.toWorldPosition } : undefined,
  }
}

function clonePlayerState(state: MultiplayerPlayerState): MultiplayerPlayerState {
  return {
    ...state,
    location: { ...state.location },
    worldPosition: state.worldPosition ? { ...state.worldPosition } : undefined,
    transition: state.transition ? cloneTransition(state.transition) : undefined,
  }
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

class FakeRemoteDoorPeer {
  readonly playerId = `fake-remote-${crypto.randomUUID()}`
  private readonly transport = new BroadcastChannelTransport()
  private readonly listeners = new Set<Listener>()
  private unsubscribeMessage: (() => void) | null = null
  private unsubscribeConnection: (() => void) | null = null
  private room: MultiplayerRoom | null = null
  private roomCode = ''
  private startId = ''
  private sequence = 0
  private hostState: MultiplayerPlayerState | null = null
  private fakeState: MultiplayerPlayerState | null = null
  private lastRomKey = ''
  private readyRequested = false
  private scriptGeneration = 0
  private script: string | null = null
  private recordingPath = false
  private recordingStartedAt = 0
  private recordingMapId: MultiplayerPlayerState['location']['mapId'] | null = null
  private recordedPath: RecordedPathFrame[] = []
  private doorCaptureArmed = false
  private capturedDoorTransition: MultiplayerMapTransition | null = null
  private snapshot: FakeRemoteSnapshot = {
    connection: 'disconnected',
    phase: 'WAITING FOR HOST ROOM',
    roomCode: '',
    gameStarted: false,
    hostState: null,
    fakeState: null,
    script: null,
    recordingPath: false,
    recordedFrames: 0,
    recordedDurationMs: 0,
    doorCaptureArmed: false,
    capturedDoorTransition: null,
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
    this.recordingPath = false
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
    this.clearRecordedPath()
    this.roomCode = normalized
    this.room = null
    this.startId = ''
    this.sequence = 0
    this.hostState = null
    this.fakeState = null
    this.lastRomKey = ''
    this.readyRequested = false
    this.doorCaptureArmed = false
    this.capturedDoorTransition = null
    this.update({
      roomCode: normalized,
      gameStarted: false,
      hostState: null,
      fakeState: null,
      doorCaptureArmed: false,
      capturedDoorTransition: null,
      phase: `JOINING ${normalized}`,
    })

    this.send({
      type: 'ROOM_JOIN',
      roomCode: normalized,
      player: this.fakePlayer({ gameId: 'white2', status: 'missing' }),
    })
  }

  startPathRecording() {
    if (!this.hostState || !this.startId) {
      this.update({ phase: 'WAITING FOR HOST GAME STATE' })
      return
    }
    this.stopScript()
    const initial = clonePlayerState(this.hostState)
    this.recordingPath = true
    this.recordingStartedAt = performance.now()
    this.recordingMapId = initial.location.mapId
    this.recordedPath = [{ elapsedMs: 0, state: initial }]
    this.update({
      recordingPath: true,
      recordedFrames: 1,
      recordedDurationMs: 0,
      phase: `RECORDING LEGAL PATH • MAP ${String(initial.location.mapId)}`,
    })
  }

  stopPathRecording(phase = 'LEGAL PATH RECORDING STOPPED') {
    if (!this.recordingPath) return
    this.recordingPath = false
    const duration = this.recordedPath[this.recordedPath.length - 1]?.elapsedMs ?? 0
    this.update({
      recordingPath: false,
      recordedFrames: this.recordedPath.length,
      recordedDurationMs: duration,
      phase,
    })
  }

  clearRecordedPath() {
    this.recordingPath = false
    this.recordingStartedAt = 0
    this.recordingMapId = null
    this.recordedPath = []
    this.update({ recordingPath: false, recordedFrames: 0, recordedDurationMs: 0 })
  }

  async replayRecordedPath() {
    if (this.recordingPath) this.stopPathRecording()
    if (!this.startId || this.recordedPath.length < 2) {
      this.update({ phase: 'RECORD AT LEAST TWO HOST STATES FIRST' })
      return
    }

    const frames = this.recordedPath.map(frame => ({ elapsedMs: frame.elapsedMs, state: clonePlayerState(frame.state) }))
    const generation = this.beginScript(`REPLAY LEGAL PATH • ${frames.length} STATES`)
    this.publish(frames[0].state)

    for (let index = 1; index < frames.length; index += 1) {
      const gap = Math.max(0, frames[index].elapsedMs - frames[index - 1].elapsedMs)
      await sleep(Math.min(MAX_REPLAY_IDLE_GAP_MS, gap))
      if (generation !== this.scriptGeneration) return
      this.publish(frames[index].state)
    }

    if (generation === this.scriptGeneration) this.finishScript(`LEGAL PATH REPLAY COMPLETE • ${frames.length} STATES`)
  }

  armDoorTransitionCapture() {
    if (!this.startId || !this.hostState) {
      this.update({ phase: 'WAITING FOR HOST GAME STATE' })
      return
    }
    this.stopScript()
    this.doorCaptureArmed = true
    this.capturedDoorTransition = null
    this.update({
      doorCaptureArmed: true,
      capturedDoorTransition: null,
      phase: 'DOOR CAPTURE ARMED • WALK HOST THROUGH A BUILDING DOOR',
    })
  }

  clearDoorTransitionCapture() {
    this.doorCaptureArmed = false
    this.capturedDoorTransition = null
    this.update({
      doorCaptureArmed: false,
      capturedDoorTransition: null,
      phase: 'DOOR TRANSITION CAPTURE CLEARED',
    })
  }

  async replayCapturedDoorDeparture() {
    const transition = this.capturedDoorTransition
    const host = this.hostState
    if (!transition || !this.startId || !host) {
      this.update({ phase: 'CAPTURE A HOST DOOR TRANSITION FIRST' })
      return
    }
    if (host.location.mapId !== transition.fromMapId) {
      this.update({ phase: `RETURN HOST TO MAP ${String(transition.fromMapId)} BEFORE REPLAY` })
      return
    }

    const generation = this.beginScript(`REMOTE DOOR DEPARTURE • ${String(transition.fromMapId)} → ${String(transition.toMapId)}`)
    const fromWorld = transition.fromWorldPosition ?? worldFromGrid(transition.fromX, transition.fromY)
    const toWorld = transition.toWorldPosition ?? worldFromGrid(transition.toX, transition.toY, fromWorld.y)
    const replayTransition = cloneTransition(transition)
    replayTransition.id = `fake-door:${this.playerId}:${Date.now()}`

    const current = this.fakeState
    if (current && current.location.mapId === transition.fromMapId && current.worldPosition) {
      const startWorld = current.worldPosition
      const deltaX = (fromWorld.x | 0) - (startWorld.x | 0)
      const deltaZ = (fromWorld.z | 0) - (startWorld.z | 0)
      const distanceTiles = Math.max(Math.abs(deltaX), Math.abs(deltaZ)) / TILE_WORLD
      const steps = Math.max(DOOR_APPROACH_MIN_STEPS, Math.ceil(distanceTiles * 6))

      for (let step = 1; step <= steps; step += 1) {
        if (generation !== this.scriptGeneration) return
        const fraction = step / steps
        const finalStep = step === steps
        this.publish({
          location: { mapId: transition.fromMapId },
          x: finalStep ? transition.fromX : current.x,
          y: finalStep ? transition.fromY : current.y,
          direction: transition.fromDirection,
          movementState: 'moving',
          worldPosition: {
            x: Math.round((startWorld.x | 0) + deltaX * fraction) >>> 0,
            y: fromWorld.y >>> 0,
            z: Math.round((startWorld.z | 0) + deltaZ * fraction) >>> 0,
          },
        })
        await sleep(DOOR_APPROACH_STEP_MS)
      }
    } else {
      this.publish({
        location: { mapId: transition.fromMapId },
        x: transition.fromX,
        y: transition.fromY,
        direction: transition.fromDirection,
        movementState: 'moving',
        worldPosition: { ...fromWorld },
      })
    }

    if (generation !== this.scriptGeneration) return
    this.publish({
      location: { mapId: transition.fromMapId },
      x: transition.fromX,
      y: transition.fromY,
      direction: transition.fromDirection,
      movementState: 'idle',
      worldPosition: { ...fromWorld },
    })

    await sleep(DOOR_APPROACH_READY_HOLD_MS)
    if (generation !== this.scriptGeneration) return

    // This timestamp must describe the actual remote map-change packet, not the
    // earlier staging/approach. The renderer intentionally gives the door ~430 ms
    // to open before moving the trainer through it; pre-stamping this transition
    // used to consume that entire lead before the transition was even published.
    replayTransition.detectedAt = Date.now()
    this.publish({
      location: { mapId: transition.toMapId },
      x: transition.toX,
      y: transition.toY,
      direction: transition.toDirection,
      movementState: 'idle',
      worldPosition: { ...toWorld },
      transition: replayTransition,
    })

    console.info('[PokéRun fake door] REPLAYED REMOTE DEPARTURE', replayTransition)
    await sleep(1100)
    if (generation === this.scriptGeneration) {
      this.finishScript(`REMOTE DOOR DEPARTURE COMPLETE • NOW ON MAP ${String(transition.toMapId)}`)
    }
  }

  resetBesideHost() {
    if (!this.hostState || !this.startId) return
    this.stopScript()
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
    this.update({ phase: 'FAKE REMOTE RESET BESIDE HOST' })
  }

  stopScript() {
    this.scriptGeneration += 1
    this.script = null
    if (this.fakeState && this.startId) this.publish({ ...this.fakeState, movementState: 'idle' })
    this.update({ script: null })
  }

  private beginScript(label: string) {
    if (this.recordingPath) this.stopPathRecording()
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

  private captureRecordedHostState(state: MultiplayerPlayerState) {
    if (!this.recordingPath) return
    if (state.location.mapId !== this.recordingMapId) {
      this.stopPathRecording('LEGAL PATH RECORDING STOPPED • MAP CHANGED')
      return
    }
    const elapsedMs = Math.max(0, Math.round(performance.now() - this.recordingStartedAt))
    this.recordedPath.push({ elapsedMs, state: clonePlayerState(state) })
    this.update({ recordedFrames: this.recordedPath.length, recordedDurationMs: elapsedMs })
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

      if (host?.rom.status === 'verified' && !sameRom(me.rom, host.rom)) {
        const romKey = `${host.rom.gameId}:${host.rom.sha256 ?? ''}`
        if (romKey !== this.lastRomKey) {
          this.lastRomKey = romKey
          this.readyRequested = false
          this.send({
            type: 'PLAYER_ROM',
            roomCode: this.roomCode,
            playerId: this.playerId,
            rom: { ...host.rom, fileName: 'FAKE REMOTE • DEV ONLY' },
          })
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
      this.hostState = message.state
      this.captureRecordedHostState(message.state)

      if (this.doorCaptureArmed && message.state.transition) {
        this.doorCaptureArmed = false
        this.capturedDoorTransition = cloneTransition(message.state.transition)
        console.info('[PokéRun fake door] CAPTURED HOST TRANSITION', this.capturedDoorTransition)
        this.update({
          doorCaptureArmed: false,
          capturedDoorTransition: this.capturedDoorTransition,
          phase: `CAPTURED DOOR • ${String(this.capturedDoorTransition.fromMapId)} → ${String(this.capturedDoorTransition.toMapId)}`,
        })
      }

      this.update({ hostState: message.state })
      if (this.startId && !this.fakeState) {
        this.resetBesideHost()
        this.update({ phase: 'FAKE REMOTE ACTIVE BESIDE HOST' })
      }
    }
  }

  private activateStart(startId: string) {
    if (this.startId === startId) return
    this.startId = startId
    this.sequence = 0
    this.fakeState = null
    this.clearRecordedPath()
    this.doorCaptureArmed = false
    this.capturedDoorTransition = null
    this.update({
      gameStarted: true,
      fakeState: null,
      doorCaptureArmed: false,
      capturedDoorTransition: null,
      phase: 'GAME STARTED • WAITING FOR HOST POSITION',
    })
  }

  private publish(state: MultiplayerPlayerState) {
    if (!this.roomCode || !this.startId) return
    this.fakeState = clonePlayerState(state)
    this.send({
      type: 'GAME_STATE',
      roomCode: this.roomCode,
      startId: this.startId,
      sequence: ++this.sequence,
      playerId: this.playerId,
      state: this.fakeState,
    })
    this.update({ fakeState: this.fakeState })
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

export function FakeRemoteDoorPeerPanel({ roomCodeStorageKey }: { roomCodeStorageKey: string }) {
  const peer = useMemo(() => new FakeRemoteDoorPeer(), [])
  const [snapshot, setSnapshot] = useState<FakeRemoteSnapshot>({
    connection: 'disconnected',
    phase: 'WAITING FOR HOST ROOM',
    roomCode: '',
    gameStarted: false,
    hostState: null,
    fakeState: null,
    script: null,
    recordingPath: false,
    recordedFrames: 0,
    recordedDurationMs: 0,
    doorCaptureArmed: false,
    capturedDoorTransition: null,
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
    width: 300,
    maxHeight: 'calc(100vh - 24px)',
    overflowY: 'auto',
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

    <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(53,84,107,0.35)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <b>DOOR TRANSITION</b>
        <span style={{ opacity: 0.75 }}>
          {snapshot.doorCaptureArmed
            ? 'ARMED'
            : snapshot.capturedDoorTransition
              ? `${String(snapshot.capturedDoorTransition.fromMapId)} → ${String(snapshot.capturedDoorTransition.toMapId)}`
              : 'NONE'}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
        <button disabled={controlsDisabled || snapshot.doorCaptureArmed || Boolean(snapshot.script)} onClick={() => peer.armDoorTransitionCapture()}>
          ARM NEXT HOST DOOR
        </button>
        <button disabled={controlsDisabled || !snapshot.capturedDoorTransition || snapshot.doorCaptureArmed || Boolean(snapshot.script)} onClick={() => void peer.replayCapturedDoorDeparture()}>
          REPLAY DEPARTURE
        </button>
        <button disabled={!snapshot.capturedDoorTransition && !snapshot.doorCaptureArmed} onClick={() => peer.clearDoorTransitionCapture()}>
          CLEAR DOOR
        </button>
        <span/>
      </div>
      <div style={{ marginTop: 5, opacity: 0.68 }}>
        Arm this, walk the real trainer through a building door once, return outside, then replay that exact transition as Player 2.
      </div>
    </div>

    <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(53,84,107,0.35)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <b>LEGAL PATH</b>
        <span style={{ opacity: 0.75 }}>
          {snapshot.recordingPath
            ? `REC • ${snapshot.recordedFrames}`
            : `${snapshot.recordedFrames} STATES • ${(snapshot.recordedDurationMs / 1000).toFixed(1)}s`}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
        <button disabled={controlsDisabled || snapshot.recordingPath} onClick={() => peer.startPathRecording()}>● RECORD HOST</button>
        <button disabled={!snapshot.recordingPath} onClick={() => peer.stopPathRecording()}>■ STOP RECORD</button>
        <button disabled={controlsDisabled || snapshot.recordingPath || snapshot.recordedFrames < 2 || Boolean(snapshot.script)} onClick={() => void peer.replayRecordedPath()}>▶ REPLAY PATH</button>
        <button disabled={snapshot.recordingPath || snapshot.recordedFrames === 0} onClick={() => peer.clearRecordedPath()}>CLEAR PATH</button>
      </div>
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 10 }}>
      <button disabled={controlsDisabled} onClick={() => peer.resetBesideHost()}>RESET BESIDE ME</button>
      <button disabled={controlsDisabled} onClick={() => peer.stopScript()}>STOP</button>
    </div>

    <div style={{ marginTop: 8, opacity: 0.7 }}>
      One real emulator. The fake guest sends the same multiplayer protocol packets as Player 2.
      {snapshot.script ? <><br/><b>RUNNING: {snapshot.script}</b></> : null}
    </div>
  </aside>
}
