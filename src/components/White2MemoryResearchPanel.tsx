import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../multiplayer/core/protocol'

/**
 * Retained as a compatibility shim because MultiplayerScreen still mounts this
 * historical dev slot. The low-level ARM9 probes it previously exposed have all
 * been superseded by the current White 2 billboard-selector experiment.
 */
export function White2MemoryResearchPanel(_props: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  return null
}
