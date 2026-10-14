import type { GameId } from '../../types'
import { MULTIPLAYER_PROTOCOL_VERSION, type MultiplayerConnectionState, type MultiplayerMessage, type MultiplayerPlayer, type MultiplayerRoom } from './protocol'
import type { MultiplayerTransport } from './transport'

export type MultiplayerSessionSnapshot = { connection: MultiplayerConnectionState; room: MultiplayerRoom | null; error: string | null }
type Listener = (snapshot: MultiplayerSessionSnapshot) => void
type OutboundMessage =
  | { type: 'ROOM_CREATE'; room: MultiplayerRoom }
  | { type: 'ROOM_JOIN'; roomCode: string; player: MultiplayerPlayer }
  | { type: 'ROOM_STATE'; room: MultiplayerRoom }
  | { type: 'PLAYER_READY'; roomCode: string; playerId: string; ready: boolean }
  | { type: 'PLAYER_LEAVE'; roomCode: string; playerId: string }

const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function roomCode() { return Array.from({ length: 6 }, () => codeAlphabet[Math.floor(Math.random() * codeAlphabet.length)]).join('') }
function playerId() { return crypto.randomUUID() }

/** Game-independent room state for local two-tab development and future server transports. */
export class LocalMultiplayerSession {
  private readonly player: MultiplayerPlayer
  private readonly listeners = new Set<Listener>()
  private snapshot: MultiplayerSessionSnapshot = { connection: 'disconnected', room: null, error: null }
  private unsubscribeMessage: (() => void) | null = null
  private unsubscribeConnection: (() => void) | null = null
  private readonly handlePageHide = () => this.leave()

  constructor(private readonly transport: MultiplayerTransport, label = 'PLAYER') {
    const storedId = sessionStorage.getItem('pokerun-multiplayer-player-id')
    const id = storedId ?? playerId()
    sessionStorage.setItem('pokerun-multiplayer-player-id', id)
    this.player = { id, label, ready: false }
  }

  connect() {
    this.unsubscribeMessage = this.transport.onMessage(message => this.receive(message))
    this.unsubscribeConnection = this.transport.onConnectionChange(connection => this.update({ connection }))
    window.addEventListener('pagehide', this.handlePageHide)
    this.transport.connect()
  }
  dispose() { this.leave(); window.removeEventListener('pagehide', this.handlePageHide); this.unsubscribeMessage?.(); this.unsubscribeConnection?.(); this.transport.disconnect() }
  subscribe(listener: Listener) { this.listeners.add(listener); listener(this.snapshot); return () => { this.listeners.delete(listener) } }
  create(gameId: GameId) {
    const room: MultiplayerRoom = { code: roomCode(), gameId, hostId: this.player.id, players: [{ ...this.player }] }
    this.update({ room, error: null })
    this.send({ type: 'ROOM_CREATE', room })
  }
  join(code: string) {
    const roomCode = code.trim().toUpperCase()
    if (!/^[A-Z2-9]{6}$/.test(roomCode)) return this.update({ error: 'ENTER THE 6-CHARACTER ROOM CODE.' })
    this.update({ room: { code: roomCode, gameId: 'white2', hostId: '', players: [{ ...this.player }] }, error: null })
    this.send({ type: 'ROOM_JOIN', roomCode, player: this.player })
  }
  toggleReady() {
    const room = this.snapshot.room
    if (!room) return
    const player = room.players.find(candidate => candidate.id === this.player.id)
    if (!player) return
    const ready = !player.ready
    this.update({ room: { ...room, players: room.players.map(candidate => candidate.id === this.player.id ? { ...candidate, ready } : candidate) } })
    this.send({ type: 'PLAYER_READY', roomCode: room.code, playerId: this.player.id, ready })
  }
  leave() {
    const room = this.snapshot.room
    if (!room) return
    this.send({ type: 'PLAYER_LEAVE', roomCode: room.code, playerId: this.player.id })
    this.update({ room: null })
  }
  private receive(message: MultiplayerMessage) {
    if (message.senderId === this.player.id || message.version !== MULTIPLAYER_PROTOCOL_VERSION) return
    const room = this.snapshot.room
    if (message.type === 'ROOM_JOIN' && room && room.hostId === this.player.id && message.roomCode === room.code) {
      if (!room.players.some(player => player.id === message.player.id) && room.players.length < 2) {
        const next = { ...room, players: [...room.players, message.player] }
        this.update({ room: next }); this.send({ type: 'ROOM_STATE', room: next })
      } else { this.send({ type: 'ROOM_STATE', room }) }
      return
    }
    if (message.type === 'ROOM_STATE' && room && message.room.code === room.code) {
      if (!message.room.players.some(player => player.id === this.player.id)) {
        this.update({ room: null, error: 'THIS ROOM IS FULL OR NO LONGER AVAILABLE.' })
      } else {
        this.update({ room: message.room, error: null })
      }
      return
    }
    if (!room || message.roomCode !== room.code) return
    if (message.type === 'PLAYER_READY' && room.hostId === this.player.id) {
      const next = { ...room, players: room.players.map(player => player.id === message.playerId ? { ...player, ready: message.ready } : player) }
      this.update({ room: next }); this.send({ type: 'ROOM_STATE', room: next })
    }
    if (message.type === 'PLAYER_LEAVE') {
      const remaining = room.players.filter(player => player.id !== message.playerId)
      this.update({ room: message.playerId === room.hostId ? null : { ...room, players: remaining } })
    }
  }
  private send(message: OutboundMessage) { this.transport.send({ ...message, version: MULTIPLAYER_PROTOCOL_VERSION, senderId: this.player.id, sentAt: Date.now() } as MultiplayerMessage) }
  private update(change: Partial<MultiplayerSessionSnapshot>) { this.snapshot = { ...this.snapshot, ...change }; this.listeners.forEach(listener => listener(this.snapshot)) }
}
