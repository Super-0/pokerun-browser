import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2TrainerRenderIsolationProbe } from './White2TrainerRenderIsolationProbe'

/**
 * Earlier White 2 actor / renderer probes are retired as soon as they answer their
 * question. Keep the existing dev-suite slot pointed only at the current render
 * isolation + remote proxy v2 experiment so the multiplayer screen stays focused.
 */
export function White2ActorLifecycleTrace({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  return <White2TrainerRenderIsolationProbe bridge={bridge} rom={rom}/>
}
