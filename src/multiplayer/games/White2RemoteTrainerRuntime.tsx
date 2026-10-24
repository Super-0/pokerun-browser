import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { White2RenderTransitionDiagnostics } from '../debug/White2RenderTransitionDiagnostics'
import type { MultiplayerRomIdentity } from '../core/protocol'
import { White2RemoteTransitionRuntime } from './White2RemoteTransitionRuntime'

// Compatibility wrapper used by MelonDsPlayer. Production keeps the existing
// dedicated remote-trainer stack; development additionally mounts a read-only
// transition trace so renderer corruption can be diagnosed without changing
// actor ownership or spawn behavior.
export function White2RemoteTrainerRuntime({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  return <>
    <White2RemoteTransitionRuntime bridge={bridge} rom={rom}/>
    {import.meta.env.DEV && <White2RenderTransitionDiagnostics bridge={bridge} rom={rom}/>} 
  </>
}
