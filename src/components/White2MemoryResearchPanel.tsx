import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'
import { White2OrangeActorProbe } from './White2OrangeActorProbe'

// Probe 9 is retired after validating the full fake-peer -> presence -> native
// FieldCommActor path. Probe 10 runs as the actual DEV remote actor runtime.
// This panel now mounts only a read-only actor census focused on the lingering
// orange sprite; it does not create or modify any actor.
export function White2MemoryResearchPanel(props: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  return <White2OrangeActorProbe {...props}/>
}
