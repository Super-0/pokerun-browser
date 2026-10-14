import { MelonDsBridge } from './MelonDsBridge'

export type Arm9Snapshot = { address: number; bytes: Uint8Array; capturedAt: number }
export type Arm9ByteChange = { address: number; before: number; after: number }

/** Development-only primitive for controlled White 2 memory experiments; no game assumptions live here. */
export class Arm9MemoryInspector {
  constructor(private readonly bridge: MelonDsBridge) {}
  async capture(address: number, length: number): Promise<Arm9Snapshot> { return { address, bytes: await this.bridge.readBytes(address, length), capturedAt: Date.now() } }
  compare(before: Arm9Snapshot, after: Arm9Snapshot) {
    if (before.address !== after.address || before.bytes.length !== after.bytes.length) throw new Error('Snapshots must cover the same ARM9 range.')
    const changes: Arm9ByteChange[] = []
    for (let index = 0; index < before.bytes.length; index += 1) if (before.bytes[index] !== after.bytes[index]) changes.push({ address: before.address + index, before: before.bytes[index], after: after.bytes[index] })
    return changes
  }
}
