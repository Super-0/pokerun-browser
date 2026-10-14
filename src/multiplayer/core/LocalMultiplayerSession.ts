import type { LoadedRom } from '../../core/rom/RomLoader'
import type { GameId } from '../../types'
import { multiplayerPresence } from './MultiplayerPresence'
import { MULTIPLAYER_PROTOCOL_VERSION, type MultiplayerConnectionState, type MultiplayerGameStart, type MultiplayerMessage, type MultiplayerPlayer, type MultiplayerPlayerState, type MultiplayerRomIdentity, type MultiplayerRoom } from './protocol'
import type { MultiplayerTransport } from './transport'

export type LocalMultiplayerRom = { gameId: GameId; rom: LoadedRom; identity: MultiplayerRomIdentity; saveProfileId?: string }
export type MultiplayerSessionSnapshot = { connection: MultiplayerConnectionState; room: MultiplayerRoom | null; error: string | null; localRom: LocalMultiplayerRom | null; remoteStates: Record<string, MultiplayerPlayerState> }
type Listener = (snapshot: MultiplayerSessionSnapshot) => void
type OutboundMessage = { type: MultiplayerMessage['type']; [key: string]: unknown }
const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function roomCode() { return Array.from({ length: 6 }, () => codeAlphabet[Math.floor(Math.random() * codeAlphabet.length)]).join('') }
function missingRom(gameId: GameId): MultiplayerRomIdentity { return { gameId, status: 'missing' } }
function newPlayer(id: string, label: string, gameId: GameId): MultiplayerPlayer { return { id, label, ready: false, rom: missingRom(gameId) } }

/** One constructed session represents one browser-tab player and intentionally never reads identity storage. */
export class LocalMultiplayerSession {
  readonly localPlayerId = crypto.randomUUID()
  private readonly listeners = new Set<Listener>()
  private snapshot: MultiplayerSessionSnapshot = { connection: 'disconnected', room: null, error: null, localRom: null, remoteStates: {} }
  private unsubscribeMessage: (() => void) | null = null
  private unsubscribeConnection: (() => void) | null = null
  private readonly handlePageHide = () => this.leave()
  private sequence = 0
  private readonly receivedSequences = new Map<string, number>()
  constructor(private readonly transport: MultiplayerTransport, private readonly label = 'PLAYER') {}
  connect() { this.unsubscribeMessage = this.transport.onMessage(message => this.receive(message)); this.unsubscribeConnection = this.transport.onConnectionChange(connection => this.update({ connection })); window.addEventListener('pagehide', this.handlePageHide); this.transport.connect() }
  dispose() { this.leave(); window.removeEventListener('pagehide', this.handlePageHide); this.unsubscribeMessage?.(); this.unsubscribeConnection?.(); this.transport.disconnect() }
  subscribe(listener: Listener) { this.listeners.add(listener); listener(this.snapshot); return () => this.listeners.delete(listener) }
  create(gameId: GameId) { multiplayerPresence.reset(); const room: MultiplayerRoom = { code: roomCode(), gameId, hostId: this.localPlayerId, players: [newPlayer(this.localPlayerId, this.label, gameId)] }; this.update({ room, error: null, localRom: null, remoteStates: {} }); this.send({ type: 'ROOM_CREATE', room }) }
  join(code: string) { const normalized = code.trim().toUpperCase(); if (!/^[A-Z2-9]{6}$/.test(normalized)) return this.update({ error: 'ENTER THE 6-CHARACTER ROOM CODE.' }); multiplayerPresence.reset(); this.update({ room: { code: normalized, gameId: 'white2', hostId: '', players: [newPlayer(this.localPlayerId, this.label, 'white2')] }, error: null, localRom: null, remoteStates: {} }); this.send({ type: 'ROOM_JOIN', roomCode: normalized, player: newPlayer(this.localPlayerId, this.label, 'white2') }) }
  setLocalRom(localRom: LocalMultiplayerRom) {
    const room = this.snapshot.room
    if (!room || localRom.gameId !== room.gameId) return this.update({ error: 'ROM DOES NOT MATCH THIS ROOM.' })
    const next = { ...room, players: room.players.map(player => player.id === this.localPlayerId ? { ...player, rom: localRom.identity, ready: false } : player) }
    this.update({ localRom, room: next, error: null })
    if (room.hostId === this.localPlayerId) this.send({ type: 'ROOM_STATE', room: next })
    else this.send({ type: 'PLAYER_ROM', roomCode: room.code, playerId: this.localPlayerId, rom: localRom.identity })
  }
  get canReady() { const room = this.snapshot.room; const me = room?.players.find(player => player.id === this.localPlayerId); return Boolean(room && me?.rom.status === 'verified' && this.isCompatible(room)) }
  get canStart() { const room = this.snapshot.room; return Boolean(room && room.hostId === this.localPlayerId && room.players.length === 2 && room.players.every(player => player.ready) && this.isCompatible(room)) }
  toggleReady() { const room = this.snapshot.room; const player = room?.players.find(candidate => candidate.id === this.localPlayerId); if (!room || !player || !this.canReady) return; const ready = !player.ready; this.updateRoom({ ...room, players: room.players.map(candidate => candidate.id === this.localPlayerId ? { ...candidate, ready } : candidate) }); this.send({ type: 'PLAYER_READY', roomCode: room.code, playerId: this.localPlayerId, ready }) }
  startGame() { const room = this.snapshot.room; if (!room || !this.canStart) return; multiplayerPresence.reset(); const start: MultiplayerGameStart = { startId: crypto.randomUUID(), gameId: room.gameId, startedAt: Date.now() }; const next = { ...room, gameStart: start }; this.updateRoom(next); this.send({ type: 'GAME_START', roomCode: room.code, start }); this.send({ type: 'ROOM_STATE', room: next }) }
  publishGameState(state: MultiplayerPlayerState) { const room = this.snapshot.room; const start = room?.gameStart; if (!room || !start) return; multiplayerPresence.setLocal(state); this.send({ type: 'GAME_STATE', roomCode: room.code, startId: start.startId, sequence: ++this.sequence, playerId: this.localPlayerId, state }) }
  leave() { const room = this.snapshot.room; multiplayerPresence.reset(); if (!room) return; this.send({ type: 'PLAYER_LEAVE', roomCode: room.code, playerId: this.localPlayerId }); this.update({ room: null, localRom: null, remoteStates: {} }) }
  private receive(message: MultiplayerMessage) {
    if (message.senderId === this.localPlayerId || message.version !== MULTIPLAYER_PROTOCOL_VERSION) return
    const room = this.snapshot.room
    if (message.type === 'ROOM_JOIN' && room && room.hostId === this.localPlayerId && message.roomCode === room.code) { const next = !room.players.some(player => player.id === message.player.id) && room.players.length < 2 ? { ...room, players: [...room.players, message.player] } : room; this.updateRoom(next); this.send({ type: 'ROOM_STATE', room: next }); return }
    if (message.type === 'ROOM_STATE' && room && message.room.code === room.code) { if (!message.room.players.some(player => player.id === this.localPlayerId)) { multiplayerPresence.reset(); this.update({ room: null, error: 'THIS ROOM IS FULL OR NO LONGER AVAILABLE.' }) } else this.updateRoom(message.room, null); return }
    if (!room || message.roomCode !== room.code) return
    if (message.type === 'PLAYER_ROM' && room.hostId === this.localPlayerId) this.hostUpdatePlayer(message.playerId, player => ({ ...player, rom: message.rom, ready: false }))
    if (message.type === 'PLAYER_READY' && room.hostId === this.localPlayerId && this.canPlayerReady(message.playerId, message.ready)) this.hostUpdatePlayer(message.playerId, player => ({ ...player, ready: message.ready }))
    if (message.type === 'GAME_START' && message.start.gameId === room.gameId && this.isCompatible(room)) { multiplayerPresence.reset(); this.updateRoom({ ...room, gameStart: message.start }, null) }
    if (message.type === 'GAME_STATE' && room.gameStart?.startId === message.startId && message.playerId !== this.localPlayerId) {
      const key = `${message.startId}:${message.playerId}`
      const previous = this.receivedSequences.get(key) ?? -1
      if (message.sequence > previous) {
        this.receivedSequences.set(key, message.sequence)
        multiplayerPresence.setRemote(message.state)
        this.update({ remoteStates: { ...this.snapshot.remoteStates, [message.playerId]: message.state } })
      }
    }
    if (message.type === 'PLAYER_LEAVE') { multiplayerPresence.reset(); const remaining = room.players.filter(player => player.id !== message.playerId); this.update({ room: message.playerId === room.hostId ? null : { ...room, players: remaining }, remoteStates: {} }) }
  }
  private hostUpdatePlayer(id: string, change: (player: MultiplayerPlayer) => MultiplayerPlayer) { const room = this.snapshot.room; if (!room) return; const next = { ...room, players: room.players.map(player => player.id === id ? change(player) : player) }; this.updateRoom(next); this.send({ type: 'ROOM_STATE', room: next }) }
  private canPlayerReady(id: string, ready: boolean) { if (!ready) return true; const room = this.snapshot.room; return Boolean(room && room.players.find(player => player.id === id)?.rom.status === 'verified' && this.isCompatible(room)) }
  private isCompatible(room: MultiplayerRoom) { return room.players.length === 2 && room.players.every(player => player.rom.status === 'verified' && player.rom.gameId === room.gameId) && new Set(room.players.map(player => player.rom.sha256)).size === 1 }
  private updateRoom(room: MultiplayerRoom, error: string | null = this.snapshot.error) { this.update({ room, error }) }
  private send(message: OutboundMessage) { this.transport.send({ ...message, version: MULTIPLAYER_PROTOCOL_VERSION, senderId: this.localPlayerId, sentAt: Date.now() } as MultiplayerMessage) }
  private update(change: Partial<MultiplayerSessionSnapshot>) { this.snapshot = { ...this.snapshot, ...change }; this.listeners.forEach(listener => listener(this.snapshot)) }
}
