import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerWorldPosition } from '../core/protocol'
import { White2ActorSystemProbe } from './White2ActorSystem'

const ACTOR_UID = 0x08
const ACTOR_WPOS = 0x44
const PLAYER_UID = 0x00ff

/**
 * Lightweight continuous FieldActor.WPos reader for the exact White 2 revision.
 * The expensive actor-system discovery only runs initially or if the player actor
 * moves to a different heap slot during a map/lifecycle transition.
 */
export class White2WorldPositionReader {
  private playerActorAddress: number | null = null

  constructor(private readonly bridge: MelonDsBridge) {}

  async read(): Promise<MultiplayerWorldPosition> {
    let address = this.playerActorAddress
    if (address !== null && await this.bridge.read16(address + ACTOR_UID) !== PLAYER_UID) {
      address = null
      this.playerActorAddress = null
    }

    if (address === null) {
      const snapshot = await new White2ActorSystemProbe(this.bridge).inspect()
      if (!snapshot.playerActor) throw new Error('White 2 player actor was not found for continuous world position.')
      address = snapshot.playerActor.address
      this.playerActorAddress = address
    }

    const [uid, x, y, z] = await Promise.all([
      this.bridge.read16(address + ACTOR_UID),
      this.bridge.read32(address + ACTOR_WPOS + 0x00),
      this.bridge.read32(address + ACTOR_WPOS + 0x04),
      this.bridge.read32(address + ACTOR_WPOS + 0x08),
    ])

    if (uid !== PLAYER_UID) {
      this.playerActorAddress = null
      return this.read()
    }

    return { x, y, z }
  }
}
