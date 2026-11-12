export type White2RadioTransportMessage = {
  kind: 'hello' | 'bye' | 'frame'
  [key: string]: unknown
}

export interface White2RadioTransport {
  send(message: White2RadioTransportMessage): void
  onMessage(listener: (message: White2RadioTransportMessage) => void): () => void
  close(): void
}

export function acceptsWhite2RadioSequence(lastSequence: number, sequence: unknown) {
  return typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence > lastSequence
}

const RADIO_RELAY_EVENT = 'pokerun:radio'

function encodeBytes(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBase64Bytes(value: unknown) {
  if (typeof value !== 'string') return null
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return null
  }
}

export function serializeWhite2RadioMessage(message: White2RadioTransportMessage) {
  if (message.kind !== 'frame' || !(message.bytes instanceof Uint8Array)) return message
  return { ...message, bytes: encodeBytes(message.bytes) }
}

function validateMessage(value: unknown): (Record<string, unknown> & { kind: White2RadioTransportMessage['kind'] }) | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Record<string, unknown>
  if (message.kind !== 'hello' && message.kind !== 'bye' && message.kind !== 'frame') return null
  return { ...message, kind: message.kind as White2RadioTransportMessage['kind'] }
}

export function deserializeWhite2RadioMessage(value: unknown): White2RadioTransportMessage | null {
  const message = validateMessage(value)
  if (!message) return null
  if (message.kind !== 'frame') return { ...message, kind: message.kind }
  const bytes = decodeBase64Bytes(message.bytes)
  if (!bytes) return null
  return { ...message, kind: 'frame', bytes }
}

export function deserializeLocalWhite2RadioMessage(value: unknown): White2RadioTransportMessage | null {
  const message = validateMessage(value)
  if (!message) return null
  if (message.kind !== 'frame') return { ...message, kind: message.kind }
  if (!(message.bytes instanceof Uint8Array)) return null
  return { ...message, kind: 'frame', bytes: message.bytes }
}

export class BroadcastWhite2RadioTransport implements White2RadioTransport {
  private readonly listeners = new Set<(message: White2RadioTransportMessage) => void>()
  private readonly channel: BroadcastChannel

  constructor(channel: BroadcastChannel) {
    this.channel = channel
    channel.onmessage = event => {
      const message = deserializeLocalWhite2RadioMessage(event.data)
      if (message) this.listeners.forEach(listener => listener(message))
    }
  }

  send(message: White2RadioTransportMessage) {
    this.channel.postMessage(message)
  }

  onMessage(listener: (message: White2RadioTransportMessage) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close() {
    this.channel.close()
  }
}

/**
 * Development-only relay over Vite's existing HMR socket. Unlike
 * BroadcastChannel, this connects isolated browser processes through the
 * machine running the dev server. It is intentionally not a production
 * transport or a claim that WAN timing is safe for native RF.
 */
export class ViteRelayWhite2RadioTransport implements White2RadioTransport {
  private readonly listeners = new Set<(message: White2RadioTransportMessage) => void>()
  private readonly hot = import.meta.hot
  private readonly receive = (payload: unknown) => {
    const message = deserializeWhite2RadioMessage(payload)
    if (message) this.listeners.forEach(listener => listener(message))
  }

  constructor() {
    if (!this.hot) throw new Error('Remote White 2 radio requires the Vite development server.')
    this.hot.on(RADIO_RELAY_EVENT, this.receive)
  }

  send(message: White2RadioTransportMessage) {
    this.hot?.send(RADIO_RELAY_EVENT, serializeWhite2RadioMessage(message))
  }

  onMessage(listener: (message: White2RadioTransportMessage) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close() {
    this.hot?.off(RADIO_RELAY_EVENT, this.receive)
    this.listeners.clear()
  }
}

export function createWhite2RadioTransport(channelName: string): White2RadioTransport {
  const remoteEnabled = import.meta.env.VITE_POKERUN_REMOTE_MULTIPLAYER === '1' &&
    new URLSearchParams(window.location.search).get('transport') === 'network'
  if (remoteEnabled) return new ViteRelayWhite2RadioTransport()
  if (!('BroadcastChannel' in window)) throw new Error('This browser does not support same-origin BroadcastChannel.')
  return new BroadcastWhite2RadioTransport(new BroadcastChannel(channelName))
}
