import { isProtocolMessage, type MultiplayerConnectionState, type MultiplayerMessage } from '../core/protocol'
import type { MultiplayerTransport } from '../core/transport'

/** Browser-only development transport. It intentionally never leaves this browser profile. */
export class BroadcastChannelTransport implements MultiplayerTransport {
  private channel: BroadcastChannel | null = null
  private messageListeners = new Set<(message: MultiplayerMessage) => void>()
  private connectionListeners = new Set<(state: MultiplayerConnectionState) => void>()

  constructor(private readonly channelName = 'pokerun-multiplayer-v1') {}

  connect() {
    if (this.channel) return
    if (!('BroadcastChannel' in window)) {
      this.emitConnection('error')
      return
    }
    this.channel = new BroadcastChannel(this.channelName)
    this.channel.onmessage = event => {
      if (!isProtocolMessage(event.data)) return
      this.messageListeners.forEach(listener => listener(event.data))
    }
    this.emitConnection('connected')
  }

  disconnect() {
    this.channel?.close()
    this.channel = null
    this.emitConnection('disconnected')
  }

  send(message: MultiplayerMessage) { this.channel?.postMessage(message) }
  onMessage(listener: (message: MultiplayerMessage) => void) { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener) }
  onConnectionChange(listener: (state: MultiplayerConnectionState) => void) { this.connectionListeners.add(listener); return () => this.connectionListeners.delete(listener) }
  private emitConnection(state: MultiplayerConnectionState) { this.connectionListeners.forEach(listener => listener(state)) }
}
