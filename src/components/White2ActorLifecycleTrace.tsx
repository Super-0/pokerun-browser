import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2BlActSelectorProbe } from './White2BlActSelectorProbe'

/**
 * The earlier White 2 lifecycle / native-control experiments have been retired now
 * that they proved the actor, billboard, material, frame and multiplayer paths.
 * Keep this existing dev-suite slot pointed only at the current unresolved renderer
 * selector experiment so the multiplayer screen stays focused while research moves
 * forward.
 */
export function White2ActorLifecycleTrace({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  return <White2BlActSelectorProbe bridge={bridge} rom={rom}/>
}
