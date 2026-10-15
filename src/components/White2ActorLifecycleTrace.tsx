import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2NativeActorProbe } from './White2NativeActorProbe'

/** Active dev slot for moving White 2 multiplayer from borrowed NPCs to a dedicated native actor. */
export function White2ActorLifecycleTrace({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  return <White2NativeActorProbe bridge={bridge} rom={rom}/>
}
