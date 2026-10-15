import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2TrainerRenderSequenceProbe } from './White2TrainerRenderSequenceProbe'

/**
 * Earlier White 2 actor / renderer probes are retired as soon as they answer their
 * question. The active baseline is the validated smooth V5 trainer proxy.
 */
export function White2ActorLifecycleTrace({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  return <White2TrainerRenderSequenceProbe bridge={bridge} rom={rom}/>
}
