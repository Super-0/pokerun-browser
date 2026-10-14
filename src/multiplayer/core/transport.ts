import type { MultiplayerConnectionState, MultiplayerMessage } from './protocol'

export interface MultiplayerTransport {
  connect(): void
  disconnect(): void
  send(message: MultiplayerMessage): void
  onMessage(listener: (message: MultiplayerMessage) => void): () => void
  onConnectionChange(listener: (state: MultiplayerConnectionState) => void): () => void
}
