import type { GameId } from '../../types'

export const MULTIPLAYER_PROTOCOL_VERSION = 2 as const
export type MultiplayerConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'
export type MultiplayerRomStatus = 'missing' | 'loaded' | 'verified' | 'unsupported'
/** Safe to share: ROM bytes never appear in this type. */
export type MultiplayerRomIdentity = { gameId: GameId; fileName?: string; sha256?: string; gameCode?: string; title?: string; status: MultiplayerRomStatus }
export type MultiplayerPlayer = { id: string; label: string; ready: boolean; rom: MultiplayerRomIdentity }
export type MultiplayerGameStart = { startId: string; gameId: GameId; startedAt: number }
export type MultiplayerWorldPosition = { x: number; y: number; z: number }
export type MultiplayerDirection = 'north' | 'south' | 'east' | 'west'
export type MultiplayerMapTransition = {
  /** Unique within one player session so peers only replay a transition once. */
  id: string
  detectedAt: number
  fromMapId: number | string
  toMapId: number | string
  fromX: number
  fromY: number
  fromDirection: MultiplayerDirection
  fromWorldPosition?: MultiplayerWorldPosition
  toX: number
  toY: number
  toDirection: MultiplayerDirection
  toWorldPosition?: MultiplayerWorldPosition
}
export type MultiplayerPlayerState = {
  location: { mapId: number | string }
  x: number
  y: number
  direction: MultiplayerDirection
  movementState?: string
  /** Optional game-native continuous world position. Only peers on the same verified game/revision should interpret it. */
  worldPosition?: MultiplayerWorldPosition
  /** Briefly repeated after a map change so the peer can replay the matching local-world entrance/door effect. */
  transition?: MultiplayerMapTransition
}
export type MultiplayerRoom = { code: string; gameId: GameId; hostId: string; players: MultiplayerPlayer[]; gameStart?: MultiplayerGameStart }

type BaseMessage = { version: typeof MULTIPLAYER_PROTOCOL_VERSION; roomCode?: string; senderId: string; sentAt: number }
export type MultiplayerMessage =
  | (BaseMessage & { type: 'HELLO'; player: MultiplayerPlayer })
  | (BaseMessage & { type: 'ROOM_CREATE'; room: MultiplayerRoom })
  | (BaseMessage & { type: 'ROOM_JOIN'; player: MultiplayerPlayer })
  | (BaseMessage & { type: 'ROOM_STATE'; room: MultiplayerRoom })
  | (BaseMessage & { type: 'PLAYER_ROM'; playerId: string; rom: MultiplayerRomIdentity })
  | (BaseMessage & { type: 'PLAYER_READY'; playerId: string; ready: boolean })
  | (BaseMessage & { type: 'GAME_START'; start: MultiplayerGameStart })
  | (BaseMessage & { type: 'GAME_STATE'; startId: string; sequence: number; playerId: string; state: MultiplayerPlayerState })
  | (BaseMessage & { type: 'PLAYER_LEAVE'; playerId: string })
  | (BaseMessage & { type: 'PING' | 'PONG' })
  | (BaseMessage & { type: 'ERROR'; code: string; message: string })

export function isProtocolMessage(value: unknown): value is MultiplayerMessage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<MultiplayerMessage>
  return candidate.version === MULTIPLAYER_PROTOCOL_VERSION && typeof candidate.type === 'string' && typeof candidate.senderId === 'string' && typeof candidate.sentAt === 'number'
}
