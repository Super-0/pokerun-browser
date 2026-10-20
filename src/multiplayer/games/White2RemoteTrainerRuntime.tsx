import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../core/protocol'
import { White2AlignmentDiagnostics } from './White2AlignmentDiagnostics'
import { White2RemoteTransitionRuntime } from './White2RemoteTransitionRuntime'

// Compatibility wrapper used by MelonDsPlayer. The production White 2 multiplayer
// stack owns a dedicated game-created FieldActor and replays local door visuals
// around remote map transitions. Alignment diagnostics are read-only.
export function White2RemoteTrainerRuntime({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  return <>
    <White2RemoteTransitionRuntime bridge={bridge} rom={rom}/>
    <White2AlignmentDiagnostics bridge={bridge} rom={rom}/>
  </>
}
