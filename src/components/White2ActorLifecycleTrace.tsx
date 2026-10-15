import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2TrainerContinuousWPosProbe } from './White2TrainerContinuousWPosProbe'

/**
 * Earlier White 2 actor / renderer probes are retired as soon as they answer their
 * question. The active experiment now keeps the validated render path and consumes
 * the partner's continuous FieldActor.WPos directly.
 */
export function White2ActorLifecycleTrace({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  return <White2TrainerContinuousWPosProbe bridge={bridge} rom={rom}/>
}
