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
const WALK_STEP_MS = 40
const WALK_STEPS = 6
const RUN_STEP_MS = 24
const RUN_STEPS = 6
const DOOR_INTENT_MS = 40
const DOOR_PREOPEN_MS = 120
const DOOR_SETTLE_MS = 1100

type Direction = MultiplayerPlayerState['direction']
type MovementMode = 'walk' | 'run'
type CapturedDoorDirection = 'forward' | 'reverse'

type FakeRemoteSnapshot = {
  connection: MultiplayerConnectionState
  phase: string
  roomCode: string
  gameStarted: boolean
  hostState: MultiplayerPlayerState | null
  fakeState: MultiplayerPlayerState | null
  script: string | null
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

function oppositeDirection(direction: Direction): Direction {
  if (direction === 'north') return 'south'
  if (direction === 'south') return 'north'
  if (direction === 'west') return 'east'
  return 'west'
}

function stepGrid(x: number, y: number, direction: Direction) {
  if (direction === 'north') return { x, y: y - 1 }
  if (direction === 'south') return { x, y: y + 1 }
  if (direction === 'west') return { x: x - 1, y }
  return { x: x + 1, y }
}

function stepWorld(world: MultiplayerWorldPosition, direction: Direction): MultiplayerWorldPosition {
  if (direction === 'north') return { ...world, z: (world.z - TILE_WORLD) >>> 0 }
  if (direction === 'south') return { ...world, z: (world.z + TILE_WORLD) >>> 0 }
  if (direction === 'west') return { ...world, x: (world.x - TILE_WORLD) >>> 0 }
  return { ...world, x: (world.x + TILE_WORLD) >>> 0 }
}

function arrowForDirection(direction: Direction) {
  if (direction === 'north') return '↑'
  if (direction === 'south') return '↓'
  if (direction === 'west') return '←'
  return '→'
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

  async moveOneTile(direction: Direction, mode: MovementMode) {
    const current = this.fakeState
    if (!current || !this.startId) {
      this.update({ phase: 'WAITING FOR FAKE REMOTE STATE' })
      return
    }

    const capturedDoorDirection = this.capturedDoorDirection(current, direction)
    if (capturedDoorDirection) {
      await this.useCapturedDoor(capturedDoorDirection)
      return
    }

    const generation = this.beginScript(`${mode.toUpperCase()} ${direction.toUpperCase()}`)
    const startWorld = current.worldPosition ?? worldFromGrid(current.x, current.y)
    const targetGrid = stepGrid(current.x, current.y, direction)
    const targetWorld = stepWorld(startWorld, direction)
    const steps = mode === 'run' ? RUN_STEPS : WALK_STEPS
    const stepMs = mode === 'run' ? RUN_STEP_MS : WALK_STEP_MS
    const deltaX = (targetWorld.x | 0) - (startWorld.x | 0)
    const deltaZ = (targetWorld.z | 0) - (startWorld.z | 0)

    for (let step = 1; step <= steps; step += 1) {
      if (generation !== this.scriptGeneration) return
      const fraction = step / steps
      const finalStep = step === steps
      this.publish({
        location: { ...current.location },
        x: finalStep ? targetGrid.x : current.x,
        y: finalStep ? targetGrid.y : current.y,
        direction,
        movementState: 'moving',
        worldPosition: {
          x: Math.round((startWorld.x | 0) + deltaX * fraction) >>> 0,
          y: startWorld.y >>> 0,
          z: Math.round((startWorld.z | 0) + deltaZ * fraction) >>> 0,
        },
      })
      await sleep(stepMs)
    }

    if (generation !== this.scriptGeneration) return
    this.publish({
      location: { ...current.location },
      x: targetGrid.x,
      y: targetGrid.y,
      direction,
      movementState: 'idle',
      worldPosition: { ...targetWorld },
    })
    this.finishScript(`FAKE REMOTE • ${mode.toUpperCase()} ${direction.toUpperCase()} • ${targetGrid.x},${targetGrid.y}`)
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
    if (this.fakeState && this.startId) {
      const { transition: _transition, ...stateWithoutTransition } = this.fakeState
      this.publish({ ...stateWithoutTransition, movementState: 'idle' })
    }
    this.update({ script: null })
  }

  private capturedDoorDirection(current: MultiplayerPlayerState, direction: Direction): CapturedDoorDirection | null {
    const transition = this.capturedDoorTransition
    if (!transition) return null

    if (
      current.location.mapId === transition.fromMapId
      && current.x === transition.fromX
      && current.y === transition.fromY
      && direction === transition.fromDirection
    ) return 'forward'

    const exitDirection = oppositeDirection(transition.fromDirection)
    if (
      current.location.mapId === transition.toMapId
      && current.x === transition.toX
      && current.y === transition.toY
      && direction === exitDirection
    ) return 'reverse'

    return null
  }

  private async useCapturedDoor(mode: CapturedDoorDirection) {
    const transition = this.capturedDoorTransition
    const current = this.fakeState
    if (!transition || !current || !this.startId) return

    const forward = mode === 'forward'
    const exteriorWorld = transition.fromWorldPosition ?? worldFromGrid(transition.fromX, transition.fromY)
    const interiorWorld = transition.toWorldPosition ?? worldFromGrid(transition.toX, transition.toY, exteriorWorld.y)
    const exitDirection = oppositeDirection(transition.fromDirection)
    const outsideGrid = stepGrid(transition.fromX, transition.fromY, exitDirection)
    const outsideWorld = stepWorld(exteriorWorld, exitDirection)

    const replayTransition: MultiplayerMapTransition = forward
      ? {
          ...cloneTransition(transition),
          id: `fake-door-enter:${this.playerId}:${Date.now()}`,
          detectedAt: Date.now(),
        }
      : {
          id: `fake-door-exit:${this.playerId}:${Date.now()}`,
          detectedAt: Date.now(),
          fromMapId: transition.toMapId,
          toMapId: transition.fromMapId,
          fromX: transition.toX,
          fromY: transition.toY,
          fromDirection: exitDirection,
          fromWorldPosition: { ...interiorWorld },
          toX: outsideGrid.x,
          toY: outsideGrid.y,
          toDirection: exitDirection,
          toWorldPosition: { ...outsideWorld },
        }

    const sourceWorld = forward ? exteriorWorld : interiorWorld
    const destination = forward
      ? {
          location: { mapId: transition.toMapId },
          x: transition.toX,
          y: transition.toY,
          direction: transition.toDirection,
          worldPosition: { ...interiorWorld },
        }
      : {
          location: { mapId: transition.fromMapId },
          x: outsideGrid.x,
          y: outsideGrid.y,
          direction: exitDirection,
          worldPosition: { ...outsideWorld },
        }

    const generation = this.beginScript(
      forward
        ? `ENTER DOOR • ${String(transition.fromMapId)} → ${String(transition.toMapId)}`
        : `EXIT DOOR • ${String(transition.toMapId)} → ${String(transition.fromMapId)}`,
    )

    // Intent frame: locks the fake remote into the through-door direction rather
    // than allowing this D-pad press to become an ordinary one-tile move.
    this.publish({
      location: { ...current.location },
      x: current.x,
      y: current.y,
      direction: replayTransition.fromDirection,
      movementState: 'moving',
      worldPosition: { ...sourceWorld },
    })
    await sleep(DOOR_INTENT_MS)
    if (generation !== this.scriptGeneration) return

    // Same-map transition metadata is an explicit pre-open signal. The door
    // runtime may animate the local prop, while the dedicated actor remains on
    // this map until the actual map-change packet below.
    this.publish({
      location: { ...current.location },
      x: current.x,
      y: current.y,
      direction: replayTransition.fromDirection,
      movementState: 'idle',
      worldPosition: { ...sourceWorld },
      transition: replayTransition,
    })
    await sleep(DOOR_PREOPEN_MS)
    if (generation !== this.scriptGeneration) return

    this.publish({
      ...destination,
      movementState: 'idle',
      transition: replayTransition,
    })
    console.info('[PokéRun fake door] MANUAL REMOTE DOOR', {
      mode,
      transition: replayTransition,
    })

    await sleep(DOOR_SETTLE_MS)
    if (generation !== this.scriptGeneration) return

    // The transition is history now. Keep only P2's authoritative destination
    // state so Player 1 can later enter that map and simply find P2 already there.
    this.publish({
      ...destination,
      movementState: 'idle',
    })
    this.finishScript(
      forward
        ? `P2 INSIDE • MAP ${String(transition.toMapId)}`
        : `P2 OUTSIDE • MAP ${String(transition.fromMapId)}`,
    )
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
    if (this.fakeState && this.startId) {
      const { transition: _transition, ...stateWithoutTransition } = this.fakeState
      this.publish({ ...stateWithoutTransition, movementState: 'idle' })
    }
    this.update({ script: null, phase })
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
  const [movementMode, setMovementMode] = useState<MovementMode>('walk')
  const [snapshot, setSnapshot] = useState<FakeRemoteSnapshot>({
    connection: 'disconnected',
    phase: 'WAITING FOR HOST ROOM',
    roomCode: '',
    gameStarted: false,
    hostState: null,
    fakeState: null,
    script: null,
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
  const movementDisabled = controlsDisabled || !snapshot.fakeState || Boolean(snapshot.script)
  const fake = snapshot.fakeState
  const host = snapshot.hostState
  const door = snapshot.capturedDoorTransition
  const exitDirection = door ? oppositeDirection(door.fromDirection) : null
  const movementButtonStyle = { minHeight: 30 }

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
      <b>REMOTE TEST CONTROLLER</b>
      <span>{snapshot.connection.toUpperCase()}</span>
    </div>
    <div style={{ marginTop: 4 }}>{snapshot.phase}</div>
    <div style={{ marginTop: 4, opacity: 0.75 }}>
      ROOM {snapshot.roomCode || '------'} • {snapshot.gameStarted ? 'GAME STARTED' : 'LOBBY'}
    </div>
    <div style={{ marginTop: 4, opacity: 0.75 }}>
      HOST {host ? `${host.location.mapId} • ${host.x},${host.y}` : 'WAITING'}<br/>
      P2 {fake ? `${fake.location.mapId} • ${fake.x},${fake.y} • ${fake.direction.toUpperCase()}` : 'WAITING'}
    </div>

    <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(53,84,107,0.35)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <b>MANUAL PLAYER 2</b>
        <div style={{ display: 'flex', gap: 4 }}>
          <button disabled={Boolean(snapshot.script)} onClick={() => setMovementMode('walk')} style={{ fontWeight: movementMode === 'walk' ? 700 : 400 }}>WALK</button>
          <button disabled={Boolean(snapshot.script)} onClick={() => setMovementMode('run')} style={{ fontWeight: movementMode === 'run' ? 700 : 400 }}>RUN</button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 42px)', gridTemplateRows: 'repeat(3, 32px)', justifyContent: 'center', gap: 4, marginTop: 8 }}>
        <span/>
        <button style={movementButtonStyle} disabled={movementDisabled} onClick={() => void peer.moveOneTile('north', movementMode)}>↑</button>
        <span/>
        <button style={movementButtonStyle} disabled={movementDisabled} onClick={() => void peer.moveOneTile('west', movementMode)}>←</button>
        <span style={{ display: 'grid', placeItems: 'center', opacity: 0.45 }}>P2</span>
        <button style={movementButtonStyle} disabled={movementDisabled} onClick={() => void peer.moveOneTile('east', movementMode)}>→</button>
        <span/>
        <button style={movementButtonStyle} disabled={movementDisabled} onClick={() => void peer.moveOneTile('south', movementMode)}>↓</button>
        <span/>
      </div>
      <div style={{ marginTop: 6, opacity: 0.68, textAlign: 'center' }}>
        One press = one tile • {movementMode === 'run' ? 'RUN ~144 ms' : 'WALK ~240 ms'}
      </div>
    </div>

    <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(53,84,107,0.35)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <b>CAPTURED DOOR</b>
        <span style={{ opacity: 0.75 }}>
          {snapshot.doorCaptureArmed
            ? 'ARMED'
            : door
              ? `${String(door.fromMapId)} ↔ ${String(door.toMapId)}`
              : 'NONE'}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
        <button disabled={controlsDisabled || snapshot.doorCaptureArmed || Boolean(snapshot.script)} onClick={() => peer.armDoorTransitionCapture()}>
          ARM NEXT HOST DOOR
        </button>
        <button disabled={!door && !snapshot.doorCaptureArmed} onClick={() => peer.clearDoorTransitionCapture()}>
          CLEAR DOOR
        </button>
      </div>
      {door && exitDirection ? <div style={{ marginTop: 6, opacity: 0.72 }}>
        ENTER: map {String(door.fromMapId)} @ {door.fromX},{door.fromY} {arrowForDirection(door.fromDirection)}<br/>
        EXIT: map {String(door.toMapId)} @ {door.toX},{door.toY} {arrowForDirection(exitDirection)}<br/>
        Stand P2 on the trigger tile and press that direction. The D-pad input becomes the door transition.
      </div> : <div style={{ marginTop: 5, opacity: 0.68 }}>
        Capture the real trainer using this door once. After that, P2 can enter and exit it directly with the D-pad.
      </div>}
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 10 }}>
      <button disabled={controlsDisabled} onClick={() => peer.resetBesideHost()}>RESET BESIDE ME</button>
      <button disabled={controlsDisabled} onClick={() => peer.stopScript()}>STOP</button>
    </div>

    <div style={{ marginTop: 8, opacity: 0.7 }}>
      P2 only sends normal multiplayer packets. Door use is now driven by intentional movement input, never proximity.
      {snapshot.script ? <><br/><b>RUNNING: {snapshot.script}</b></> : null}
    </div>
  </aside>
}
