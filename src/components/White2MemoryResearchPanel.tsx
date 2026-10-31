import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'

// Probe 9 is retired after validating the full fake-peer -> presence -> native
// FieldCommActor path. Probe 10 runs as the actual DEV remote actor runtime, so
// the research panel must not create a second communication actor.
export function White2MemoryResearchPanel(_props: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  return null
}
