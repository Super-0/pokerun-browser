import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2BlActBindingProbe } from './White2BlActBindingProbe'
import { White2TrainerBillboardFaceProbe } from './White2TrainerBillboardFaceProbe'

/**
 * The first renderer probe established that the live trainer and standard NPC both
 * carry 0xFFFF0000 in FieldActorG3DObjEntry, so neither is backed by FieldG3DObj.
 * Keep the existing dev-suite component slot, but follow the actual billboard /
 * BlAct renderer path now instead of exposing the dead G3D-object path again.
 */
export function White2G3DBindingProbe({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  return <>
    <White2BlActBindingProbe bridge={bridge} rom={rom}/>
    <White2TrainerBillboardFaceProbe bridge={bridge} rom={rom}/>
  </>
}
