import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2TrainerHandleWordProbe } from './White2TrainerHandleWordProbe'

/**
 * Earlier White 2 actor / renderer probes are retired as soon as they answer their
 * question. Keep the existing dev-suite slot pointed only at the current unresolved
 * trainer handle-word / size experiment.
 */
export function White2ActorLifecycleTrace({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  return <White2TrainerHandleWordProbe bridge={bridge} rom={rom}/>
}