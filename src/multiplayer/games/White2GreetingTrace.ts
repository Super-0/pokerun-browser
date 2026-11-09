import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'

type WireEvent = {
  phase: 'send' | 'arrival' | 'queued' | 'rejected'
  source: 1 | 2
  sequence: number
  dsUs: number
  aid: number
  nativeTxId?: number
  atMs: number
}
type Batch = ReturnType<MelonDsBridge['drainGreetingTrace']> & {
  beforeMs: number
  afterMs: number
}

const MAX_WIRE_EVENTS = 65_536
const MAX_BATCHES = 1_024
const now = () => performance.timeOrigin + performance.now()

let active: White2GreetingTrace | null = null

export function takeWhite2GreetingTrace() {
  return active?.take() ?? null
}

export class White2GreetingTrace {
  private wire: WireEvent[] = []
  private native: Batch[] = []
  private droppedWire = 0
  private droppedBatches = 0
  private lastDrain = 0
  private complete = false

  constructor(private readonly bridge: MelonDsBridge, private readonly role: 1 | 2) {
    bridge.setGreetingTrace(true)
    active = this
  }

  wireEvent(phase: WireEvent['phase'], source: 1 | 2, sequence: number, dsUs: number, aid: number, nativeTxId?: number) {
    if (this.wire.length === MAX_WIRE_EVENTS) {
      this.droppedWire++
      return
    }
    this.wire.push({ phase, source, sequence, dsUs, aid, nativeTxId, atMs: now() })
  }

  drainNative(force = false) {
    const beforeMs = now()
    if (!force && beforeMs - this.lastDrain < 100) return
    this.lastDrain = beforeMs
    const batch = this.bridge.drainGreetingTrace()
    const afterMs = now()
    if (!batch.values.length && !batch.dropped) return
    if (this.native.length === MAX_BATCHES) {
      this.droppedBatches++
      return
    }
    this.native.push({ ...batch, beforeMs, afterMs })
  }

  stop() {
    try {
      this.drainNative(true)
      this.complete = true
    } finally { this.bridge.setGreetingTrace(false) }
  }

  take() {
    const result = {
      role: this.role, complete: this.complete, wire: this.wire, native: this.native,
      droppedWire: this.droppedWire, droppedBatches: this.droppedBatches,
    }
    this.wire = []
    this.native = []
    this.droppedWire = this.droppedBatches = 0
    return result
  }
}
