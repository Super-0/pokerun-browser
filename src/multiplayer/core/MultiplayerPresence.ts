import type { MultiplayerEmoteKind, MultiplayerPlayerState } from './protocol'

export type MultiplayerPresenceSnapshot = {
  local: MultiplayerPlayerState | null
  remote: MultiplayerPlayerState | null
}

type Listener = (snapshot: MultiplayerPresenceSnapshot) => void
type EmotePublisher = (kind: MultiplayerEmoteKind) => boolean
// PRK58: an application-side, read-only, session-bound eligibility answer.
// A preview is not an authorization token and never sends an outbound packet.
export type TradeRequestPreflight = {
  eligible: boolean
  reason: string
  roomCode: string | null
  startId: string | null
  localPlayerId: string | null
  remotePlayerId: string | null
  sameMap: boolean
  bothFacing: boolean
  localStateFresh: boolean
  remoteStateFresh: boolean
  transportMessagesSent: 0
}
type TradeRequestPreflightProvider = () => TradeRequestPreflight
type TradeRequestPublisher = () => boolean

/**
 * Per-tab in-memory bridge between the multiplayer session and emulator UI.
 * Nothing here is persisted or transmitted; LocalMultiplayerSession remains
 * responsible for validating room/start IDs before remote state reaches it.
 */
class MultiplayerPresenceStore {
  private snapshot: MultiplayerPresenceSnapshot = { local: null, remote: null }
  private readonly listeners = new Set<Listener>()
  private emotePublisher: EmotePublisher | null = null
  private tradePreflightProvider: TradeRequestPreflightProvider | null = null
  private tradeRequestPublisher: TradeRequestPublisher | null = null

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setLocal(local: MultiplayerPlayerState) {
    this.update({ local })
  }

  setRemote(remote: MultiplayerPlayerState) {
    this.update({ remote })
  }

  setEmotePublisher(publisher: EmotePublisher | null) {
    this.emotePublisher = publisher
    return () => {
      if (this.emotePublisher === publisher) this.emotePublisher = null
    }
  }

  sendEmote(kind: MultiplayerEmoteKind) {
    return this.emotePublisher?.(kind) ?? false
  }

  setTradePreflightProvider(provider: TradeRequestPreflightProvider) {
    this.tradePreflightProvider = provider
    return () => {
      if (this.tradePreflightProvider === provider) this.tradePreflightProvider = null
    }
  }

  // Only LocalMultiplayerSession can publish; native DOM result details never
  // contain an authoritative room or peer ID. The session rechecks preflight.
  setTradeRequestPublisher(publisher: TradeRequestPublisher) {
    this.tradeRequestPublisher = publisher
    return () => {
      if (this.tradeRequestPublisher === publisher) this.tradeRequestPublisher = null
    }
  }

  requestTradeFromConfirmedNativeChoice() {
    return this.tradeRequestPublisher?.() ?? false
  }

  previewTradeRequest(): TradeRequestPreflight {
    return this.tradePreflightProvider?.() ?? {
      eligible: false,
      reason: 'No active multiplayer session has registered a trade preflight.',
      roomCode: null,
      startId: null,
      localPlayerId: null,
      remotePlayerId: null,
      sameMap: false,
      bothFacing: false,
      localStateFresh: false,
      remoteStateFresh: false,
      transportMessagesSent: 0,
    }
  }

  reset() {
    this.snapshot = { local: null, remote: null }
    this.emit()
  }

  private update(change: Partial<MultiplayerPresenceSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change }
    this.emit()
  }

  private emit() {
    this.listeners.forEach(listener => listener(this.snapshot))
  }
}

export const multiplayerPresence = new MultiplayerPresenceStore()
