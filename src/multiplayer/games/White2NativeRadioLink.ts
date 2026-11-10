import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { White2GreetingTrace } from './White2GreetingTrace'

// PRK66: ephemeral BroadcastChannel-only experiment. It connects two real
// melonDS instances in separate tabs of the same browser origin. It is NOT
// production networking, an Internet relay, or the simulated second trainer.
const PROTOCOL = 'pokerun-prk79-radio-v2'
const HELLO_INTERVAL_MS = 750
const PEER_EXPIRY_MS = 2500
const RADIO_POLL_MS = 50
const FAST_RADIO_POLL_MS = 5
const MAX_FRAMES_PER_TICK = 32
const MIN_FRAME_BYTES = 36
const MAX_FRAME_BYTES = 2048

export type NativeRadioLinkStatus = {
  phase: 'waiting' | 'linked' | 'stopped' | 'error'
  peerPresent: boolean
  framesSent: number
  framesReceived: number
  framesRejected: number
  pollIntervalMs: 5 | 50
  native: ReturnType<MelonDsBridge['getNativeWirelessDevLinkCounters']> | null
  reason?: string
}

export type NativeRadioLinkOptions = {
  roomCode: string
  startId: string
  localPlayerId: string
  remotePlayerId: string
  romSha256: string
  saveProfileId: string
  pollIntervalMs?: 5 | 50
}

type Hello = {
  protocol: typeof PROTOCOL
  kind: 'hello' | 'bye'
  startId: string
  romSha256: string
  saveProfileId: string
  firmwareRole: 1 | 2
  fromId: string
  toId: string
  sessionNonce: string
}
type Frame = Omit<Hello, 'kind'> & {
  kind: 'frame'
  sequence: number
  bytes: Uint8Array
  timestamp: number
  replyAid: number
}
type Message = Hello | Frame

/**
 * One active link owns one wasm radio endpoint. Enabling has no effect on a
 * simulated P2; another actual browser tab must negotiate a matching hello.
 * Packet content is deliberately not logged, displayed or persisted.
 */
export class White2NativeRadioLink {
  private readonly channel: BroadcastChannel
  private readonly localNonce = crypto.randomUUID()
  private readonly firmwareRole: 1 | 2
  private readonly options: NativeRadioLinkOptions
  private readonly pollIntervalMs: 5 | 50
  private readonly bridge: MelonDsBridge
  private readonly onStatus: (status: NativeRadioLinkStatus) => void
  private trace: White2GreetingTrace | null = null
  private tickTimer: number | null = null
  private lastHelloAt = 0
  private lastHelloSentAt = 0
  private peerNonce: string | null = null
  private lastSequence = 0
  private sequence = 0
  private radioEnabled = false
  private framesSent = 0
  private framesReceived = 0
  private framesRejected = 0
  private stopped = false
  private lastStatusAt = 0
  private lastPhase: NativeRadioLinkStatus['phase'] | null = null

  constructor(bridge: MelonDsBridge, options: NativeRadioLinkOptions,
    onStatus: (status: NativeRadioLinkStatus) => void) {
    if (!import.meta.env.DEV) throw new Error('PRK66 is development-only.')
    if (!('BroadcastChannel' in window)) throw new Error('This browser does not support same-origin BroadcastChannel.')
    if (!options.roomCode || !options.startId || !options.localPlayerId ||
        !options.remotePlayerId || options.localPlayerId === options.remotePlayerId ||
        !options.saveProfileId || !/^[0-9a-f]{64}$/i.test(options.romSha256)) {
      throw new Error('PRK66 requires a valid room, two distinct player IDs, and a verified ROM.')
    }
    // PRK71: prevent claiming an actual two-DS link when either instance
    // booted with the duplicate stock firmware MAC. Never expose MAC bytes.
    const pageRole = new URLSearchParams(window.location.search).get('player')
    const applied = bridge.getNativeWirelessDevLinkCounters().firmwareRoleApplied
    if (!((pageRole === '1' && applied === 1) || (pageRole === '2' && applied === 2))) {
      throw new Error('PRK71 requires a real Player 1/2 tab with distinct firmware identity. Relaunch both players after rebuilding melonDS.')
    }
    this.firmwareRole = applied as 1 | 2
    // PRK78: opt-in shorter host delivery interval; never change native RF
    // channels, timestamps, packet contents, firmware or save data.
    this.pollIntervalMs = options.pollIntervalMs === FAST_RADIO_POLL_MS
      ? FAST_RADIO_POLL_MS : RADIO_POLL_MS
    this.bridge = bridge
    this.options = options
    this.onStatus = onStatus
    const key = [options.roomCode, options.startId].map(value =>
      value.replace(/[^a-z0-9_-]/gi, '').slice(0, 64)).join('-')
    this.channel = new BroadcastChannel(`${PROTOCOL}-${key}`)
    this.channel.onmessage = event => this.handleMessage(event.data as unknown)
    this.channel.onmessageerror = () => { this.framesRejected++; this.publish('error', 'Wireless channel could not decode an incoming message.') }
  }

  private stopRadioOutput: (() => void) | null = null

  start() {
    if (this.stopped || this.tickTimer !== null) return
    if (this.bridge.status !== 'running') throw new Error('Native radio requires a running melonDS instance.')
    try {
      if (sessionStorage.getItem('pokerun:prk80-greeting-trace') === '1') {
        this.trace = new White2GreetingTrace(this.bridge, this.firmwareRole,
          sessionStorage.getItem('pokerun:prk80-trace-game-negotiation') === '1')
      }
    } catch (error) {
      console.warn('[PokéRun] Greeting trace could not start.', error)
    }
    const mode = Number(sessionStorage.getItem('pokerun:prk80-defer-host-poll'))
    this.bridge.setPrk80DeferHostPoll(mode === 1 || mode === 2 || mode === 3 ? mode : 0)
    this.publish('waiting')
    this.sendHello()
    this.stopRadioOutput = this.bridge.subscribeRadioOutput(() => this.tick())
    this.tickTimer = window.setInterval(() => this.tick(), this.pollIntervalMs)
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    if (this.tickTimer !== null) window.clearInterval(this.tickTimer)
    this.tickTimer = null
    this.stopRadioOutput?.()
    this.stopRadioOutput = null
    try { this.channel.postMessage(this.wrap({ kind: 'bye' })) } catch { /* page teardown */ }
    this.channel.close()
    try { this.trace?.stop() } catch { /* page teardown */ }
    try { this.bridge.setPrk80DeferHostPoll(0) } catch { /* page teardown */ }
    if (this.radioEnabled) {
      try { this.bridge.setNativeWirelessDevLinkEnabled(false) } catch { /* page teardown */ }
      this.radioEnabled = false
    }
    this.publish('stopped')
  }

  private wrap(message: { kind: 'hello' | 'bye' }): Hello {
    return {
      protocol: PROTOCOL,
      kind: message.kind,
      startId: this.options.startId,
      romSha256: this.options.romSha256,
      saveProfileId: this.options.saveProfileId,
      firmwareRole: this.firmwareRole,
      fromId: this.options.localPlayerId,
      toId: this.options.remotePlayerId,
      sessionNonce: this.localNonce,
    }
  }

  private sendHello() {
    this.channel.postMessage(this.wrap({ kind: 'hello' }))
    this.lastHelloSentAt = performance.now()
  }

  private isPeerMessage(value: unknown): value is Message {
    if (!value || typeof value !== 'object') return false
    const v = value as Partial<Message>
    return v.protocol === PROTOCOL && v.startId === this.options.startId &&
      v.romSha256 === this.options.romSha256 &&
      typeof v.saveProfileId === 'string' &&
      v.saveProfileId.length > 0 && v.saveProfileId !== this.options.saveProfileId &&
      v.firmwareRole === (this.firmwareRole === 1 ? 2 : 1) &&
      v.fromId === this.options.remotePlayerId &&
      v.toId === this.options.localPlayerId &&
      typeof v.sessionNonce === 'string' && v.sessionNonce.length >= 12
  }

  private handleMessage(value: unknown) {
    if (this.stopped || !this.isPeerMessage(value)) return
    if (value.kind === 'hello') {
      if (this.peerNonce !== value.sessionNonce) {
        this.peerNonce = value.sessionNonce
        this.lastSequence = 0
      }
      this.lastHelloAt = performance.now()
      // A peer can attach after our initial hello; a periodic hello will
      // return the handshake even if one initial message was missed.
      return
    }
    if (value.kind === 'bye') {
      if (this.peerNonce === value.sessionNonce) this.lastHelloAt = 0
      return
    }
    if (value.kind === 'frame' && this.peerNonce === value.sessionNonce &&
        Number.isSafeInteger(value.sequence) && Number.isSafeInteger(value.timestamp) &&
        Number.isInteger(value.replyAid)) {
      this.trace?.wireEvent('arrival', value.firmwareRole, value.sequence, value.timestamp, value.replyAid)
    }
    if (value.kind !== 'frame' || !this.radioEnabled ||
        this.peerNonce !== value.sessionNonce ||
        performance.now() - this.lastHelloAt > PEER_EXPIRY_MS) {
      this.framesRejected++
      return
    }
    if (!Number.isSafeInteger(value.sequence) || value.sequence <= this.lastSequence ||
        !Number.isInteger(value.replyAid) || value.replyAid < 0 || value.replyAid > 15 ||
        !(value.bytes instanceof Uint8Array) ||
        (value.replyAid === 0 && value.bytes.byteLength < MIN_FRAME_BYTES) ||
        (value.replyAid !== 0 && value.bytes.byteLength !== 0 &&
          value.bytes.byteLength < MIN_FRAME_BYTES) ||
        value.bytes.byteLength > (value.replyAid ? 1024 : MAX_FRAME_BYTES) ||
        !Number.isSafeInteger(value.timestamp) || value.timestamp < 0) {
      this.framesRejected++
      return
    }
    // Native receiver performs its own frame length and fixed-buffer checks.
    try {
      const received = value.replyAid
        ? this.bridge.receiveNativeWirelessDevReply(value.bytes, value.timestamp, value.replyAid, this.trace ? value.sequence : 0)
        : this.bridge.receiveNativeWirelessDevFrame(value.bytes, value.timestamp)
      this.trace?.wireEvent(received ? 'queued' : 'rejected', value.firmwareRole, value.sequence, value.timestamp, value.replyAid)
      if (received) {
        this.lastSequence = value.sequence
        this.framesReceived++
      } else {
        this.framesRejected++
      }
    } catch {
      this.framesRejected++
    }
  }

  private tick() {
    if (this.stopped) return
    try {
      if (this.bridge.status !== 'running') { this.stop(); return }
      const now = performance.now()
      if (now - this.lastHelloSentAt >= HELLO_INTERVAL_MS) this.sendHello()
      const peerPresent = Boolean(this.peerNonce) &&
        now - this.lastHelloAt < PEER_EXPIRY_MS
      if (peerPresent !== this.radioEnabled) {
        this.bridge.setNativeWirelessDevLinkEnabled(peerPresent)
        this.radioEnabled = peerPresent
      }
      if (peerPresent) {
        for (let i = 0; i < MAX_FRAMES_PER_TICK; i++) {
          const outgoing = this.bridge.takeNativeWirelessOutgoingFrame()
          if (!outgoing) break
          const bytes = outgoing.bytes
          const replyAid = outgoing.replyAid ?? 0
          if (!(bytes instanceof Uint8Array) ||
              !Number.isInteger(replyAid) || replyAid < 0 || replyAid > 15 ||
              (replyAid === 0 && bytes.byteLength < MIN_FRAME_BYTES) ||
              (replyAid !== 0 && bytes.byteLength !== 0 &&
                bytes.byteLength < MIN_FRAME_BYTES) ||
              bytes.byteLength > (replyAid ? 1024 : MAX_FRAME_BYTES) ||
              !Number.isSafeInteger(outgoing.timestamp) || outgoing.timestamp < 0) {
            this.framesRejected++
            continue
          }
          const frame: Frame = {
            ...this.wrap({ kind: 'hello' }),
            kind: 'frame',
            sequence: ++this.sequence,
            bytes,
            timestamp: outgoing.timestamp,
            replyAid,
          }
          this.trace?.wireEvent('send', this.firmwareRole, frame.sequence, frame.timestamp, replyAid, outgoing.traceTxId)
          this.channel.postMessage(frame)
          this.framesSent++
        }
      }
      try { this.trace?.drainNative() } catch (error) {
        console.warn('[PokéRun] Greeting trace could not drain.', error)
        try { this.trace?.stop() } catch { /* page teardown */ }
        try { this.bridge.setPrk80DeferHostPoll(0) } catch { /* page teardown */ }
        this.trace = null
      }
      const phase = peerPresent ? 'linked' : 'waiting'
      if (this.lastPhase !== phase || now - this.lastStatusAt > 1000) {
        this.publish(phase)
        this.lastStatusAt = now
      }
    } catch (error) {
      this.publish('error', error instanceof Error ? error.message : String(error))
      this.stop()
    }
  }

  private publish(phase: NativeRadioLinkStatus['phase'], reason?: string) {
    this.lastPhase = phase
    let native: NativeRadioLinkStatus['native'] = null
    try { native = this.bridge.getNativeWirelessDevLinkCounters() } catch { /* teardown */ }
    this.onStatus({
      phase,
      peerPresent: phase === 'linked',
      framesSent: this.framesSent,
      framesReceived: this.framesReceived,
      framesRejected: this.framesRejected,
      pollIntervalMs: this.pollIntervalMs,
      native,
      reason,
    })
  }
}
