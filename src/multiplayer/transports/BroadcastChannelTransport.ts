import { isProtocolMessage, type MultiplayerConnectionState, type MultiplayerMessage } from '../core/protocol'
import type { MultiplayerTransport } from '../core/transport'

const NETWORK_RELAY_EVENT = 'pokerun:multiplayer'

/**
 * Browser-only development transport. By default it stays inside one browser
 * profile via BroadcastChannel. `?transport=network` switches the dev harness to
 * Vite's HMR socket so separate computers connected to the same dev server can
 * relay the exact same multiplayer protocol without touching production code.
 */
export class BroadcastChannelTransport implements MultiplayerTransport {
  private channel: BroadcastChannel | null = null
  private networkConnected = false
  private messageListeners = new Set<(message: MultiplayerMessage) => void>()
  private connectionListeners = new Set<(state: MultiplayerConnectionState) => void>()
  private readonly networkMode = new URLSearchParams(window.location.search).get('transport') === 'network'
  private readonly handleNetworkMessage = (payload: unknown) => {
    if (!isProtocolMessage(payload)) return
    this.messageListeners.forEach(listener => listener(payload))
  }

  constructor(private readonly channelName = 'pokerun-multiplayer-v1') {}

  connect() {
    if (this.networkMode) {
      if (this.networkConnected) return
      const hot = import.meta.hot
      if (!hot) {
        this.emitConnection('error')
        return
      }
      hot.on(NETWORK_RELAY_EVENT, this.handleNetworkMessage)
      this.networkConnected = true
      this.emitConnection('connected')
      return
    }

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
    if (this.networkMode) {
      if (this.networkConnected) import.meta.hot?.off(NETWORK_RELAY_EVENT, this.handleNetworkMessage)
      this.networkConnected = false
      this.emitConnection('disconnected')
      return
    }

    this.channel?.close()
    this.channel = null
    this.emitConnection('disconnected')
  }

  send(message: MultiplayerMessage) {
    if (this.networkMode) {
      if (this.networkConnected) import.meta.hot?.send(NETWORK_RELAY_EVENT, message)
      return
    }
    this.channel?.postMessage(message)
  }

  onMessage(listener: (message: MultiplayerMessage) => void) { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener) }
  onConnectionChange(listener: (state: MultiplayerConnectionState) => void) { this.connectionListeners.add(listener); return () => this.connectionListeners.delete(listener) }
  private emitConnection(state: MultiplayerConnectionState) { this.connectionListeners.forEach(listener => listener(state)) }
}
