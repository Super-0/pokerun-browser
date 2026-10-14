import type { MultiplayerConnectionState, MultiplayerMessage } from '../core/protocol'
import type { MultiplayerTransport } from '../core/transport'

/** Production transport boundary. A room server can implement the same protocol later. */
export class WebSocketTransport implements MultiplayerTransport {
  private socket: WebSocket | null = null
  private messageListeners = new Set<(message: MultiplayerMessage) => void>()
  private connectionListeners = new Set<(state: MultiplayerConnectionState) => void>()
  constructor(private readonly url: string) {}
  connect() {
    if (this.socket) return
    this.emitConnection('connecting')
    this.socket = new WebSocket(this.url)
    this.socket.onopen = () => this.emitConnection('connected')
    this.socket.onclose = () => { this.socket = null; this.emitConnection('disconnected') }
    this.socket.onerror = () => this.emitConnection('error')
    this.socket.onmessage = event => { try { const message = JSON.parse(String(event.data)) as MultiplayerMessage; this.messageListeners.forEach(listener => listener(message)) } catch { /* malformed packets are ignored */ } }
  }
  disconnect() { this.socket?.close() }
  send(message: MultiplayerMessage) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)) }
  onMessage(listener: (message: MultiplayerMessage) => void) { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener) }
  onConnectionChange(listener: (state: MultiplayerConnectionState) => void) { this.connectionListeners.add(listener); return () => this.connectionListeners.delete(listener) }
  private emitConnection(state: MultiplayerConnectionState) { this.connectionListeners.forEach(listener => listener(state)) }
}
