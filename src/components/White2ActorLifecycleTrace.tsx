import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'

/**
 * Compatibility shim for the old dev probe slot. The validated V6 behavior now
 * runs automatically inside MelonDsPlayer through White2RemoteTrainerRuntime.
 */
export function White2ActorLifecycleTrace(_props: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  return null
}