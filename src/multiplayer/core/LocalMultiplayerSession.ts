import type { LoadedRom } from '../../core/rom/RomLoader'
import type { GameId } from '../../types'
import { multiplayerPresence, type TradeRequestPreflight } from './MultiplayerPresence'
import {
  MULTIPLAYER_PROTOCOL_VERSION,
  type MultiplayerConnectionState,
  type MultiplayerDirection,
  type MultiplayerEmoteKind,
  type MultiplayerGameStart,
  type MultiplayerMapTransition,
  type MultiplayerMessage,
  type MultiplayerPlayer,
  type MultiplayerPlayerState,
  type MultiplayerRomIdentity,
  type MultiplayerRoom,
  type MultiplayerTradeRequest,
  type MultiplayerTradeDecision,
  type MultiplayerTradeState,
} from './protocol'
import type { MultiplayerTransport } from './transport'

export type LocalMultiplayerRom = { gameId: GameId; rom: LoadedRom; identity: MultiplayerRomIdentity; saveProfileId?: string }
export type MultiplayerSessionSnapshot = { connection: MultiplayerConnectionState; room: MultiplayerRoom | null; error: string | null; localRom: LocalMultiplayerRom | null; remoteStates: Record<string, MultiplayerPlayerState>; trade?: MultiplayerTradeState | null }
type Listener = (snapshot: MultiplayerSessionSnapshot) => void
type OutboundMessage = { type: MultiplayerMessage['type']; [key: string]: unknown }

const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const TRANSITION_REPEAT_MS = 1200
const MOVEMENT_IDLE_MS = 180
const PRK58_MAX_STATE_AGE_MS = 5000
const PRK60_TRADE_TIMEOUT_MS = 30000
const MAP_EDGE_WORLD_MAX_STEP = 0x10000
const MAP_EDGE_WORLD_AXIS_SLOP = 0x1000
const MAP_EDGE_HEIGHT_SLOP = 0x10000

function roomCode() { return Array.from({ length: 6 }, () => codeAlphabet[Math.floor(Math.random() * codeAlphabet.length)]).join('') }
function missingRom(gameId: GameId): MultiplayerRomIdentity { return { gameId, status: 'missing' } }
function newPlayer(id: string, label: string, gameId: GameId): MultiplayerPlayer { return { id, label, ready: false, rom: missingRom(gameId) } }
function samePanelState(a: MultiplayerPlayerState | undefined, b: MultiplayerPlayerState) {
  return !!a
    && a.location.mapId === b.location.mapId
    && a.x === b.x
    && a.y === b.y
    && a.direction === b.direction
    && a.movementState === b.movementState
}

function classifyMapChange(previous: MultiplayerPlayerState, current: MultiplayerPlayerState) {
  const gridDx = current.x - previous.x
  const gridDy = current.y - previous.y
  const gridDistance = Math.abs(gridDx) + Math.abs(gridDy)
  const previousWorld = previous.worldPosition
  const currentWorld = current.worldPosition
  const worldDx = previousWorld && currentWorld ? (currentWorld.x | 0) - (previousWorld.x | 0) : null
  const worldDy = previousWorld && currentWorld ? (currentWorld.y | 0) - (previousWorld.y | 0) : null
  const worldDz = previousWorld && currentWorld ? (currentWorld.z | 0) - (previousWorld.z | 0) : null
  const worldHorizontalDistance = worldDx === null || worldDz === null
    ? null
    : Math.abs(worldDx) + Math.abs(worldDz)
  const direction = current.direction
  const directionMatchesWorldStep = worldDx !== null && worldDz !== null && (
    (direction === 'east' && worldDx > 0 && Math.abs(worldDz) <= MAP_EDGE_WORLD_AXIS_SLOP)
    || (direction === 'west' && worldDx < 0 && Math.abs(worldDz) <= MAP_EDGE_WORLD_AXIS_SLOP)
    || (direction === 'north' && worldDz < 0 && Math.abs(worldDx) <= MAP_EDGE_WORLD_AXIS_SLOP)
    || (direction === 'south' && worldDz > 0 && Math.abs(worldDx) <= MAP_EDGE_WORLD_AXIS_SLOP)
  )
  const directionalWorldStep = worldHorizontalDistance !== null
    && worldDy !== null
    && worldHorizontalDistance > 0
    && worldHorizontalDistance <= MAP_EDGE_WORLD_MAX_STEP
    && Math.abs(worldDy) <= MAP_EDGE_HEIGHT_SLOP
    && directionMatchesWorldStep
  const zeroDeltaBoundarySample = worldHorizontalDistance === 0
    && worldDy === 0
    && gridDistance === 0
    && previous.direction === current.direction
    && (previous.movementState === 'moving' || current.movementState === 'moving')
  const continuousWorldStep = directionalWorldStep || zeroDeltaBoundarySample
  const kind = gridDistance <= 1 && continuousWorldStep ? 'map-edge' as const : undefined

  console.info('[PokéRun transition] PROBE 16 MAP CHANGE CLASSIFIED', {
    kind: kind ?? 'unclassified',
    fromMapId: previous.location.mapId,
    toMapId: current.location.mapId,
    fromGrid: { x: previous.x, y: previous.y },
    toGrid: { x: current.x, y: current.y },
    gridDelta: { x: gridDx, y: gridDy, manhattan: gridDistance },
    fromWorld: previousWorld ?? null,
    toWorld: currentWorld ?? null,
    worldDelta: worldDx === null ? null : { x: worldDx, y: worldDy, z: worldDz },
    worldHorizontalDistance,
    directionalWorldStep,
    zeroDeltaBoundarySample,
    continuousWorldStep,
    fromDirection: previous.direction,
    toDirection: current.direction,
    fromMovementState: previous.movementState,
    toMovementState: current.movementState,
    note: kind === 'map-edge'
      ? zeroDeltaBoundarySample
        ? 'Map ID flipped before the next movement sample advanced; identical moving boundary samples are accepted as a seamless map edge.'
        : 'Sub-tile world continuity matches movement direction; classified as a seamless map edge with no field teardown.'
      : 'World coordinates do not look like one continuous overworld step; keep ordinary field/warp lifecycle handling.',
  })

  return kind
}

/** One constructed session represents one browser-tab player and intentionally never reads identity storage. */
export class LocalMultiplayerSession {
  readonly localPlayerId = crypto.randomUUID()
  private readonly listeners = new Set<Listener>()
  private snapshot: MultiplayerSessionSnapshot = { connection: 'disconnected', room: null, error: null, localRom: null, remoteStates: {} }
  private unsubscribeMessage: (() => void) | null = null
  private unsubscribeConnection: (() => void) | null = null
  private unsubscribeEmotePublisher: (() => void) | null = null
  private unsubscribeTradePreflight: (() => void) | null = null
  private unsubscribeTradeRequestPublisher: (() => void) | null = null
  private tradeTimeoutTimer: number | null = null
  private readonly seenTradeRequestIds = new Set<string>()
  private readonly handlePageHide = () => this.leave()
  private sequence = 0
  private readonly receivedSequences = new Map<string, number>()
  private lastLocalStateAt = 0
  private readonly lastRemoteStateAt = new Map<string, number>()

  // Transition metadata is derived at the transport boundary so game adapters can
  // keep publishing ordinary normalized state. The transition is briefly attached
  // to subsequent state packets after a map change, which gives the peer enough
  // time to replay local-world door/entrance effects even if one packet is missed.
  private lastPublishedGameState: MultiplayerPlayerState | null = null
  private activeTransition: MultiplayerMapTransition | null = null
  private activeTransitionUntil = 0
  private transitionCounter = 0
  private emoteCounter = 0
  private movementIdleTimer: number | null = null

  constructor(private readonly transport: MultiplayerTransport, private readonly label = 'PLAYER') {}

  connect() {
    this.unsubscribeMessage = this.transport.onMessage(message => this.receive(message))
    this.unsubscribeConnection = this.transport.onConnectionChange(connection => this.update({ connection }))
    this.unsubscribeEmotePublisher?.()
    this.unsubscribeEmotePublisher = multiplayerPresence.setEmotePublisher(kind => this.publishEmote(kind))
    this.unsubscribeTradePreflight?.()
    this.unsubscribeTradePreflight = multiplayerPresence.setTradePreflightProvider(() => this.previewTradeRequest())
    this.unsubscribeTradeRequestPublisher?.()
    this.unsubscribeTradeRequestPublisher = multiplayerPresence.setTradeRequestPublisher(() => this.requestTrade())
    window.addEventListener('pagehide', this.handlePageHide)
    this.transport.connect()
  }

  dispose() {
    this.leave()
    window.removeEventListener('pagehide', this.handlePageHide)
    this.unsubscribeEmotePublisher?.()
    this.unsubscribeEmotePublisher = null
    this.unsubscribeTradePreflight?.()
    this.unsubscribeTradePreflight = null
    this.unsubscribeTradeRequestPublisher?.()
    this.unsubscribeTradeRequestPublisher = null
    this.unsubscribeMessage?.()
    this.unsubscribeConnection?.()
    this.transport.disconnect()
  }

  subscribe(listener: Listener) { this.listeners.add(listener); listener(this.snapshot); return () => this.listeners.delete(listener) }

  create(gameId: GameId) {
    multiplayerPresence.reset()
    this.resetGameStateTracking()
    const room: MultiplayerRoom = { code: roomCode(), gameId, hostId: this.localPlayerId, players: [newPlayer(this.localPlayerId, this.label, gameId)] }
    this.update({ room, error: null, localRom: null, remoteStates: {} })
    this.send({ type: 'ROOM_CREATE', room })
  }

  join(code: string) {
    const normalized = code.trim().toUpperCase()
    if (!/^[A-Z2-9]{6}$/.test(normalized)) return this.update({ error: 'ENTER THE 6-CHARACTER ROOM CODE.' })
    multiplayerPresence.reset()
    this.resetGameStateTracking()
    this.update({ room: { code: normalized, gameId: 'white2', hostId: '', players: [newPlayer(this.localPlayerId, this.label, 'white2')] }, error: null, localRom: null, remoteStates: {} })
    this.send({ type: 'ROOM_JOIN', roomCode: normalized, player: newPlayer(this.localPlayerId, this.label, 'white2') })
  }

  setLocalRom(localRom: LocalMultiplayerRom) {
    const room = this.snapshot.room
    if (!room || localRom.gameId !== room.gameId) return this.update({ error: 'ROM DOES NOT MATCH THIS ROOM.' })
    const next = { ...room, players: room.players.map(player => player.id === this.localPlayerId ? { ...player, rom: localRom.identity, ready: false } : player) }
    this.update({ localRom, room: next, error: null })
    if (room.hostId === this.localPlayerId) this.send({ type: 'ROOM_STATE', room: next })
    else this.send({ type: 'PLAYER_ROM', roomCode: room.code, playerId: this.localPlayerId, rom: localRom.identity })
  }

  get canReady() {
    const room = this.snapshot.room
    const me = room?.players.find(player => player.id === this.localPlayerId)
    return Boolean(room && me?.rom.status === 'verified' && this.isCompatible(room))
  }

  get canStart() {
    const room = this.snapshot.room
    return Boolean(room && room.hostId === this.localPlayerId && room.players.length === 2 && room.players.every(player => player.ready) && this.isCompatible(room))
  }

  toggleReady() {
    const room = this.snapshot.room
    const player = room?.players.find(candidate => candidate.id === this.localPlayerId)
    if (!room || !player || !this.canReady) return
    const ready = !player.ready
    this.updateRoom({ ...room, players: room.players.map(candidate => candidate.id === this.localPlayerId ? { ...candidate, ready } : candidate) })
    this.send({ type: 'PLAYER_READY', roomCode: room.code, playerId: this.localPlayerId, ready })
  }

  startGame() {
    const room = this.snapshot.room
    if (!room || !this.canStart) return
    multiplayerPresence.reset()
    this.resetGameStateTracking()
    const start: MultiplayerGameStart = { startId: crypto.randomUUID(), gameId: room.gameId, startedAt: Date.now() }
    const next = { ...room, gameStart: start }
    this.updateRoom(next)
    this.send({ type: 'GAME_START', roomCode: room.code, start })
    this.send({ type: 'ROOM_STATE', room: next })
  }

  publishGameState(state: MultiplayerPlayerState) {
    const room = this.snapshot.room
    const start = room?.gameStart
    if (!room || !start) return

    this.clearMovementIdleTimer()
    const movementState = this.resolveMovementState(state)
    const outboundState = this.withTransitionMetadata({ ...state, movementState })
    multiplayerPresence.setLocal(outboundState)
    this.lastLocalStateAt = Date.now()
    const sequence = ++this.sequence
    this.send({ type: 'GAME_STATE', roomCode: room.code, startId: start.startId, sequence, playerId: this.localPlayerId, state: outboundState })

    if (movementState === 'moving') {
      this.movementIdleTimer = window.setTimeout(() => {
        this.movementIdleTimer = null
        if (this.sequence !== sequence) return
        const latest = this.lastPublishedGameState
        if (!latest || latest.movementState !== 'moving') return
        this.publishGameState({ ...latest, movementState: 'idle' })
      }, MOVEMENT_IDLE_MS)
    }
  }

  publishEmote(kind: MultiplayerEmoteKind) {
    const state = this.lastPublishedGameState
    const room = this.snapshot.room
    if (!state || !room?.gameStart) return false

    const now = Date.now()
    const emote = {
      id: `emote:${this.localPlayerId}:${++this.emoteCounter}:${now}`,
      kind,
      createdAt: now,
    }
    this.publishGameState({ ...state, emote })

    // An emote is an event, not persistent player state. Keep the packet that was
    // just sent intact, but strip it from the cached state used by idle/movement
    // synthesis so later packets cannot replay the same bubble.
    if (this.lastPublishedGameState?.emote?.id === emote.id) {
      this.lastPublishedGameState = { ...this.lastPublishedGameState, emote: undefined }
    }

    console.info('[PokéRun interaction] EMOTE SENT', { id: emote.id, kind })
    return true
  }

  // PRK58 deliberately does not use the untrusted DOM event as authority.
  // The session checks only its own verified room, start ID, local published
  // state and the remote state received through its existing transport.
  // No packet is sent and no guest memory is changed in this preflight.
  private previewTradeRequest(): TradeRequestPreflight {
    const room = this.snapshot.room
    const startId = room?.gameStart?.startId ?? null
    const otherPlayers = room?.players.filter(player => player.id !== this.localPlayerId) ?? []
    const remotePlayer = otherPlayers.length === 1 ? otherPlayers[0] : null
    const local = this.lastPublishedGameState
    const remote = remotePlayer ? this.snapshot.remoteStates[remotePlayer.id] : undefined
    const now = Date.now()
    const localStateFresh = Boolean(local && this.lastLocalStateAt > 0 &&
      now - this.lastLocalStateAt <= PRK58_MAX_STATE_AGE_MS)
    const remoteLastSeen = remotePlayer ? this.lastRemoteStateAt.get(remotePlayer.id) ?? 0 : 0
    const remoteStateFresh = Boolean(remote && remoteLastSeen > 0 &&
      now - remoteLastSeen <= PRK58_MAX_STATE_AGE_MS)
    const sameMap = Boolean(local && remote &&
      local.location.mapId === remote.location.mapId)
    const faced = (direction: MultiplayerDirection) => {
      if (direction === 'north') return { x: 0, y: -1 }
      if (direction === 'south') return { x: 0, y: 1 }
      if (direction === 'west') return { x: -1, y: 0 }
      return { x: 1, y: 0 }
    }
    const bothFacing = Boolean(local && remote && sameMap &&
      remote.x - local.x === faced(local.direction).x &&
      remote.y - local.y === faced(local.direction).y &&
      local.x - remote.x === faced(remote.direction).x &&
      local.y - remote.y === faced(remote.direction).y)
    const validRoom = Boolean(room && room.gameId === 'white2' &&
      room.players.length === 2 &&
      room.players.some(player => player.id === this.localPlayerId) &&
      remotePlayer && this.isCompatible(room))
    const validStart = Boolean(startId && startId.length > 0)
    const eligible = this.snapshot.connection === 'connected' && validRoom &&
      validStart && localStateFresh && remoteStateFresh && bothFacing
    const reason = this.snapshot.connection !== 'connected' ? 'Transport is not connected.'
      : !validRoom ? 'No compatible two-player White 2 room with two verified ROM identities.'
      : !validStart ? 'The active room has no validated game-start ID.'
      : !localStateFresh ? 'Local game position was not published recently.'
      : !remoteStateFresh ? 'Remote game position was not received recently.'
      : !sameMap ? 'Players are on different maps.'
      : !bothFacing ? 'Players are not adjacent and facing each other.'
      : 'Dry-run passed; future request must be tied to the real peer, room and start IDs.'
    return {
      eligible,
      reason,
      roomCode: room?.code ?? null,
      startId,
      localPlayerId: this.localPlayerId,
      remotePlayerId: remotePlayer?.id ?? null,
      sameMap,
      bothFacing,
      localStateFresh,
      remoteStateFresh,
      transportMessagesSent: 0,
    }
  }

  // PRK60: the native DOM event is only a user-interaction hint. This
  // method gets every identity from this session and REVALIDATES the fresh
  // room/start/peer preflight. No guest memory/Pokémon bytes are modified.
  requestTrade() {
    if (!import.meta.env.DEV) return false // no authenticated server yet
    const preview = this.previewTradeRequest()
    if (!preview.eligible || !preview.roomCode || !preview.startId ||
        !preview.remotePlayerId || !preview.localPlayerId ||
        this.snapshot.trade?.status === 'pending') {
      console.info('[PokéRun trade] PRK60 OUTGOING REQUEST BLOCKED', {
        reason: this.snapshot.trade?.status === 'pending'
          ? 'A trade handshake is already pending.' : preview.reason,
        eligible: preview.eligible,
        noSend: true,
      })
      return false
    }
    const now = Date.now()
    const request: MultiplayerTradeRequest = {
      requestId: crypto.randomUUID(),
      startId: preview.startId,
      fromPlayerId: this.localPlayerId,
      toPlayerId: preview.remotePlayerId,
      createdAt: now,
      expiresAt: now + PRK60_TRADE_TIMEOUT_MS,
    }
    this.update({ trade: { request, direction: 'outgoing', status: 'pending' } })
    this.armTradeTimeout(request)
    this.send({ type: 'TRADE_REQUEST', roomCode: preview.roomCode, request })
    console.info('[PokéRun trade] PRK60 OUTGOING REQUEST SENT', {
      requestId: request.requestId,
      roomCode: preview.roomCode,
      startId: request.startId,
      fromPlayerId: request.fromPlayerId,
      toPlayerId: request.toPlayerId,
      expiresAt: request.expiresAt,
      sameMap: preview.sameMap,
      bothFacing: preview.bothFacing,
      localStateFresh: preview.localStateFresh,
      remoteStateFresh: preview.remoteStateFresh,
      status: 'pending',
      guestTradeInitiated: false,
      note: 'Development BroadcastChannel message only. Remote consent required. No Pokémon or save data, game writes, or authenticated server authority.',
    })
    return true
  }

  respondTrade(decision: MultiplayerTradeDecision) {
    if (!import.meta.env.DEV) return false
    const current = this.snapshot.trade
    const room = this.snapshot.room
    if (!current || current.status !== 'pending' ||
        current.direction !== 'incoming' || !room?.gameStart ||
        room.gameStart.startId !== current.request.startId ||
        current.request.toPlayerId !== this.localPlayerId ||
        !room.players.some(player => player.id === current.request.fromPlayerId) ||
        (decision === 'accepted' && !this.previewTradeRequest().eligible)) {
      console.info('[PokéRun trade] PRK60 INCOMING DECISION BLOCKED', {
        decision, status: current?.status ?? null,
        reason: 'Incoming request is stale, no longer in the session, or player positions are invalid.',
        noSend: true,
      })
      return false
    }
    this.clearTradeTimeout()
    this.update({ trade: { ...current, status: decision } })
    this.send({
      type: 'TRADE_RESPONSE',
      roomCode: room.code,
      requestId: current.request.requestId,
      startId: current.request.startId,
      fromPlayerId: this.localPlayerId,
      toPlayerId: current.request.fromPlayerId,
      decision,
    })
    console.info('[PokéRun trade] PRK60 INCOMING DECISION SENT', {
      requestId: current.request.requestId, decision, guestTradeInitiated: false,
      note: 'Handshake result only. Acceptance never authorizes a Pokémon exchange.',
    })
    return true
  }

  cancelTrade() {
    if (!import.meta.env.DEV) return false
    const current = this.snapshot.trade
    const room = this.snapshot.room
    if (!current || current.status !== 'pending' || !room?.gameStart ||
        room.gameStart.startId !== current.request.startId) return false
    const peerId = current.direction === 'outgoing'
      ? current.request.toPlayerId : current.request.fromPlayerId
    this.clearTradeTimeout()
    this.update({ trade: { ...current, status: 'cancelled' } })
    this.send({
      type: 'TRADE_CANCEL', roomCode: room.code,
      requestId: current.request.requestId, startId: current.request.startId,
      fromPlayerId: this.localPlayerId, toPlayerId: peerId,
      reason: 'cancelled',
    })
    console.info('[PokéRun trade] PRK60 LOCAL CANCELLATION SENT', {
      requestId: current.request.requestId, peerId, guestTradeInitiated: false,
    })
    return true
  }

  private clearTradeTimeout() {
    if (this.tradeTimeoutTimer !== null) window.clearTimeout(this.tradeTimeoutTimer)
    this.tradeTimeoutTimer = null
  }

  private armTradeTimeout(request: MultiplayerTradeRequest) {
    this.clearTradeTimeout()
    this.tradeTimeoutTimer = window.setTimeout(() => {
      this.tradeTimeoutTimer = null
      const current = this.snapshot.trade
      if (!current || current.status !== 'pending' ||
          current.request.requestId !== request.requestId) return
      const room = this.snapshot.room
      const peerId = current.direction === 'outgoing'
        ? request.toPlayerId : request.fromPlayerId
      if (room?.gameStart?.startId === request.startId) {
        this.send({
          type: 'TRADE_CANCEL', roomCode: room.code,
          requestId: request.requestId, startId: request.startId,
          fromPlayerId: this.localPlayerId, toPlayerId: peerId,
          reason: 'timeout',
        })
      }
      this.update({ trade: { ...current, status: 'expired' } })
      console.info('[PokéRun trade] PRK60 HANDSHAKE TIMED OUT', {
        requestId: request.requestId, peerId,
        guestTradeInitiated: false,
        note: 'No response before deadline; terminal state and explicit cancel packet.',
      })
    }, Math.max(0, request.expiresAt - Date.now()))
  }

  private receiveTradeMessage(message: MultiplayerMessage, room: MultiplayerRoom) {
    if (!import.meta.env.DEV || !room.gameStart || room.gameId !== 'white2') return
    const startId = room.gameStart.startId
    if (message.type === 'TRADE_REQUEST') {
      const req = message.request
      const now = Date.now()
      const wellFormed = req && typeof req === 'object' &&
        typeof req.requestId === 'string' && /^[0-9a-f-]{36}$/i.test(req.requestId) &&
        req.startId === startId &&
        req.fromPlayerId === message.senderId &&
        req.toPlayerId === this.localPlayerId &&
        room.players.some(player => player.id === message.senderId) &&
        typeof req.createdAt === 'number' && typeof req.expiresAt === 'number' &&
        req.createdAt <= now + 5000 &&
        req.createdAt >= now - PRK60_TRADE_TIMEOUT_MS &&
        req.expiresAt > now &&
        req.expiresAt - req.createdAt <= PRK60_TRADE_TIMEOUT_MS
      const preflight = this.previewTradeRequest()
      if (!wellFormed || !preflight.eligible ||
          preflight.remotePlayerId !== message.senderId ||
          this.snapshot.trade?.status === 'pending' ||
          this.seenTradeRequestIds.has(req?.requestId)) {
        console.info('[PokéRun trade] PRK60 INCOMING REQUEST BLOCKED', {
          reason: !wellFormed ? 'Invalid room/peer/start/expiry payload.'
            : !preflight.eligible ? preflight.reason
              : 'Duplicate or concurrent request.',
          noGameWrites: true,
        })
        return
      }
      this.seenTradeRequestIds.add(req.requestId)
      if (this.seenTradeRequestIds.size > 64) {
        const first = this.seenTradeRequestIds.values().next().value
        if (first) this.seenTradeRequestIds.delete(first)
      }
      this.update({ trade: { request: req, direction: 'incoming', status: 'pending' } })
      this.armTradeTimeout(req)
      console.info('[PokéRun trade] PRK60 INCOMING REQUEST ACCEPTED FOR DECISION', {
        requestId: req.requestId, roomCode: room.code, startId,
        fromPlayerId: req.fromPlayerId, toPlayerId: req.toPlayerId,
        expiresAt: req.expiresAt, bothFacing: preflight.bothFacing,
        guestTradeInitiated: false,
        note: 'Remote user must explicitly accept or decline. No auto-accept or game mutation.',
      })
      return
    }

    const current = this.snapshot.trade
    if (!current || current.status !== 'pending' ||
        message.senderId === this.localPlayerId ||
        !room.players.some(player => player.id === message.senderId)) return
    const peerId = current.direction === 'outgoing'
      ? current.request.toPlayerId : current.request.fromPlayerId
    if (message.senderId !== peerId) return
    if (message.type === 'TRADE_RESPONSE' &&
        current.direction === 'outgoing' &&
        message.startId === startId &&
        message.requestId === current.request.requestId &&
        message.fromPlayerId === message.senderId &&
        message.toPlayerId === this.localPlayerId &&
        (message.decision === 'accepted' || message.decision === 'declined') &&
        Date.now() < current.request.expiresAt) {
      this.clearTradeTimeout()
      this.update({ trade: { ...current, status: message.decision } })
      console.info('[PokéRun trade] PRK60 REMOTE DECISION RECEIVED', {
        requestId: current.request.requestId, decision: message.decision,
        fromPlayerId: message.senderId, status: message.decision,
        guestTradeInitiated: false,
        note: 'Mutual consent handshake can finish, but NO native trade or save/party exchange exists.',
      })
    } else if (message.type === 'TRADE_CANCEL' &&
        message.startId === startId &&
        message.requestId === current.request.requestId &&
        message.fromPlayerId === message.senderId &&
        message.toPlayerId === this.localPlayerId &&
        (message.reason === 'cancelled' || message.reason === 'timeout')) {
      this.clearTradeTimeout()
      this.update({
        trade: { ...current, status: message.reason === 'timeout' ? 'expired' : 'cancelled' },
      })
      console.info('[PokéRun trade] PRK60 PEER CANCELLATION RECEIVED', {
        requestId: current.request.requestId, reason: message.reason,
        guestTradeInitiated: false,
      })
    }
  }

  leave() {
    const room = this.snapshot.room
    if (this.snapshot.trade?.status === 'pending') this.cancelTrade()
    multiplayerPresence.reset()
    this.resetGameStateTracking()
    if (!room) return
    this.send({ type: 'PLAYER_LEAVE', roomCode: room.code, playerId: this.localPlayerId })
    this.update({ room: null, localRom: null, remoteStates: {} })
  }

  private resolveMovementState(state: MultiplayerPlayerState) {
    if (state.movementState === 'moving' || state.movementState === 'idle') return state.movementState
    const previous = this.lastPublishedGameState
    if (!previous) return 'idle'
    const previousWorld = previous.worldPosition
    const currentWorld = state.worldPosition
    if (previousWorld && currentWorld && (
      previousWorld.x !== currentWorld.x
      || previousWorld.y !== currentWorld.y
      || previousWorld.z !== currentWorld.z
    )) return 'moving'
    return previous.movementState === 'moving' ? 'moving' : 'idle'
  }

  private clearMovementIdleTimer() {
    if (this.movementIdleTimer === null) return
    window.clearTimeout(this.movementIdleTimer)
    this.movementIdleTimer = null
  }

  private withTransitionMetadata(state: MultiplayerPlayerState): MultiplayerPlayerState {
    const now = Date.now()
    const previous = this.lastPublishedGameState
    const cleanState: MultiplayerPlayerState = { ...state, transition: undefined }

    if (state.transition) {
      this.activeTransition = state.transition
      this.activeTransitionUntil = now + TRANSITION_REPEAT_MS
    } else if (previous && previous.location.mapId !== state.location.mapId) {
      const kind = classifyMapChange(previous, state)
      this.activeTransition = {
        id: `transition:${this.localPlayerId}:${++this.transitionCounter}:${now}`,
        detectedAt: now,
        kind,
        fromMapId: previous.location.mapId,
        toMapId: state.location.mapId,
        fromX: previous.x,
        fromY: previous.y,
        fromDirection: previous.direction,
        fromWorldPosition: previous.worldPosition ? { ...previous.worldPosition } : undefined,
        toX: state.x,
        toY: state.y,
        toDirection: state.direction,
        toWorldPosition: state.worldPosition ? { ...state.worldPosition } : undefined,
      }
      this.activeTransitionUntil = now + TRANSITION_REPEAT_MS
    }

    this.lastPublishedGameState = cleanState

    if (this.activeTransition && now <= this.activeTransitionUntil) {
      return { ...cleanState, transition: this.activeTransition }
    }

    this.activeTransition = null
    this.activeTransitionUntil = 0
    return cleanState
  }

  private resetGameStateTracking() {
    this.clearTradeTimeout()
    this.seenTradeRequestIds.clear()
    this.update({ trade: null })
    this.clearMovementIdleTimer()
    this.lastPublishedGameState = null
    this.lastLocalStateAt = 0
    this.lastRemoteStateAt.clear()
    this.activeTransition = null
    this.activeTransitionUntil = 0
    this.transitionCounter = 0
    this.emoteCounter = 0
  }

  private receive(message: MultiplayerMessage) {
    if (message.senderId === this.localPlayerId || message.version !== MULTIPLAYER_PROTOCOL_VERSION) return
    const room = this.snapshot.room

    if (message.type === 'ROOM_JOIN' && room && room.hostId === this.localPlayerId && message.roomCode === room.code) {
      const next = !room.players.some(player => player.id === message.player.id) && room.players.length < 2 ? { ...room, players: [...room.players, message.player] } : room
      this.updateRoom(next)
      this.send({ type: 'ROOM_STATE', room: next })
      return
    }

    if (message.type === 'ROOM_STATE' && room && message.room.code === room.code) {
      if (!message.room.players.some(player => player.id === this.localPlayerId)) {
        multiplayerPresence.reset()
        this.resetGameStateTracking()
        this.update({ room: null, error: 'THIS ROOM IS FULL OR NO LONGER AVAILABLE.' })
      } else this.updateRoom(message.room, null)
      return
    }

    if (!room || message.roomCode !== room.code) return
    if (message.type === 'TRADE_REQUEST' || message.type === 'TRADE_RESPONSE' ||
        message.type === 'TRADE_CANCEL') {
      this.receiveTradeMessage(message, room)
      return
    }
    if (message.type === 'PLAYER_ROM' && room.hostId === this.localPlayerId) this.hostUpdatePlayer(message.playerId, player => ({ ...player, rom: message.rom, ready: false }))
    if (message.type === 'PLAYER_READY' && room.hostId === this.localPlayerId && this.canPlayerReady(message.playerId, message.ready)) this.hostUpdatePlayer(message.playerId, player => ({ ...player, ready: message.ready }))

    if (message.type === 'GAME_START' && message.start.gameId === room.gameId && this.isCompatible(room)) {
      multiplayerPresence.reset()
      this.resetGameStateTracking()
      this.updateRoom({ ...room, gameStart: message.start }, null)
    }

    // PRK58: never cache a remote trade-preflight position from a packet
    // claiming some other playerId or a player not in this room. This does
    // not authenticate identities; the current dev relay remains untrusted.
    if (message.type === 'GAME_STATE' &&
        room.gameStart?.startId === message.startId &&
        message.playerId !== this.localPlayerId &&
        message.senderId === message.playerId &&
        room.players.some(player => player.id === message.playerId)) {
      const key = `${message.startId}:${message.playerId}`
      const previous = this.receivedSequences.get(key) ?? -1
      if (message.sequence > previous) {
        this.receivedSequences.set(key, message.sequence)
        this.lastRemoteStateAt.set(message.playerId, Date.now())
        multiplayerPresence.setRemote(message.state)
        if (message.state.emote) {
          console.info('[PokéRun interaction] EMOTE RECEIVED', {
            id: message.state.emote.id,
            kind: message.state.emote.kind,
            playerId: message.playerId,
          })
        }
        const previousState = this.snapshot.remoteStates[message.playerId]
        if (!samePanelState(previousState, message.state)) {
          this.update({ remoteStates: { ...this.snapshot.remoteStates, [message.playerId]: message.state } })
        }
      }
    }

    if (message.type === 'PLAYER_LEAVE') {
      multiplayerPresence.reset()
      this.resetGameStateTracking()
      const remaining = room.players.filter(player => player.id !== message.playerId)
      this.update({ room: message.playerId === room.hostId ? null : { ...room, players: remaining }, remoteStates: {} })
    }
  }

  private hostUpdatePlayer(id: string, change: (player: MultiplayerPlayer) => MultiplayerPlayer) {
    const room = this.snapshot.room
    if (!room) return
    const next = { ...room, players: room.players.map(player => player.id === id ? change(player) : player) }
    this.updateRoom(next)
    this.send({ type: 'ROOM_STATE', room: next })
  }

  private canPlayerReady(id: string, ready: boolean) {
    if (!ready) return true
    const room = this.snapshot.room
    return Boolean(room && room.players.find(player => player.id === id)?.rom.status === 'verified' && this.isCompatible(room))
  }

  private isCompatible(room: MultiplayerRoom) {
    return room.players.length === 2
      && room.players.every(player => player.rom.status === 'verified' && player.rom.gameId === room.gameId)
      && new Set(room.players.map(player => player.rom.sha256)).size === 1
  }

  private updateRoom(room: MultiplayerRoom, error: string | null = this.snapshot.error) { this.update({ room, error }) }
  private send(message: OutboundMessage) { this.transport.send({ ...message, version: MULTIPLAYER_PROTOCOL_VERSION, senderId: this.localPlayerId, sentAt: Date.now() } as MultiplayerMessage) }
  private update(change: Partial<MultiplayerSessionSnapshot>) { this.snapshot = { ...this.snapshot, ...change }; this.listeners.forEach(listener => listener(this.snapshot)) }
}
