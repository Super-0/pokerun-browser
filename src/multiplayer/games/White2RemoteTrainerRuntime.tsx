import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { DevConsolePanel } from '../debug/DevConsolePanel'
import { White2LocalRenderDiagnostics } from '../debug/White2LocalRenderDiagnostics'
import { White2RenderTransitionDiagnostics } from '../debug/White2RenderTransitionDiagnostics'
import type { MultiplayerRomIdentity } from '../core/protocol'
import { White2NativeCommShadowRuntime } from './White2NativeCommShadowRuntime'
import { White2NativeEmoteRuntime } from './White2NativeEmoteRuntime'
import { White2PlayerInteractionRuntime } from './White2PlayerInteractionRuntime'
import { White2RemoteTransitionRuntime } from './White2RemoteTransitionRuntime'

// Compatibility wrapper used by MelonDsPlayer. Production keeps the existing
// dedicated remote-trainer stack; development additionally mounts read-only
// diagnostics and an in-app console so test logs can be copied without opening
// browser developer tools.
export function White2RemoteTrainerRuntime({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  return <>
    <White2RemoteTransitionRuntime bridge={bridge} rom={rom}/>
    <White2NativeEmoteRuntime bridge={bridge} rom={rom}/>
    <White2PlayerInteractionRuntime/>
    {import.meta.env.DEV && <>
      <White2NativeCommShadowRuntime bridge={bridge} rom={rom}/>
      <White2RenderTransitionDiagnostics bridge={bridge} rom={rom}/>
      <White2LocalRenderDiagnostics bridge={bridge} rom={rom}/>
      <DevConsolePanel/>
    </>}
  </>
}
