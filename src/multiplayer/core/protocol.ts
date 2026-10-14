import type { GameId } from '../../types'

export const MULTIPLAYER_PROTOCOL_VERSION = 1 as const

export type MultiplayerConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'
export type MultiplayerPlayer = { id: string; label: string; ready: boolean }
export type MultiplayerRoom = { code: string; gameId: GameId; hostId: string; players: MultiplayerPlayer[] }

type BaseMessage = { version: typeof MULTIPLAYER_PROTOCOL_VERSION; roomCode?: string; senderId: string; sentAt: number }
export type MultiplayerMessage =
  | (BaseMessage & { type: 'HELLO'; player: MultiplayerPlayer })
  | (BaseMessage & { type: 'ROOM_CREATE'; room: MultiplayerRoom })
  | (BaseMessage & { type: 'ROOM_JOIN'; player: MultiplayerPlayer })
  | (BaseMessage & { type: 'ROOM_STATE'; room: MultiplayerRoom })
  | (BaseMessage & { type: 'PLAYER_READY'; playerId: string; ready: boolean })
  | (BaseMessage & { type: 'PLAYER_LEAVE'; playerId: string })
  | (BaseMessage & { type: 'PING' | 'PONG' })
  | (BaseMessage & { type: 'ERROR'; code: string; message: string })

export function isProtocolMessage(value: unknown): value is MultiplayerMessage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<MultiplayerMessage>
  return candidate.version === MULTIPLAYER_PROTOCOL_VERSION
    && typeof candidate.type === 'string'
    && typeof candidate.senderId === 'string'
    && typeof candidate.sentAt === 'number'
}
