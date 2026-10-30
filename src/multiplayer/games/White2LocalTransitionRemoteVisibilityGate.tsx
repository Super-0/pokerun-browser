import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../core/protocol'

/**
 * Arrival visibility is now owned exclusively by White2DedicatedTrainerRuntime:
 * native P2 creation is deferred through the unsafe local-arrival window, then
 * the actor is bound hidden, rendered as the protagonist, and revealed once.
 *
 * Keep this compatibility component temporarily so older runtime wiring does not
 * need to change in the same patch. It intentionally performs no writes.
 */
export function White2LocalTransitionRemoteVisibilityGate(_props: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  return null
}
