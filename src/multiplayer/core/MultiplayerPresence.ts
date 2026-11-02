import type { MultiplayerEmoteKind, MultiplayerPlayerState } from './protocol'

export type MultiplayerPresenceSnapshot = {
  local: MultiplayerPlayerState | null
  remote: MultiplayerPlayerState | null
}

type Listener = (snapshot: MultiplayerPresenceSnapshot) => void
type EmotePublisher = (kind: MultiplayerEmoteKind) => boolean

/**
 * Per-tab in-memory bridge between the multiplayer session and emulator UI.
 * Nothing here is persisted or transmitted; LocalMultiplayerSession remains
 * responsible for validating room/start IDs before remote state reaches it.
 */
class MultiplayerPresenceStore {
  private snapshot: MultiplayerPresenceSnapshot = { local: null, remote: null }
  private readonly listeners = new Set<Listener>()
  private emotePublisher: EmotePublisher | null = null

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
