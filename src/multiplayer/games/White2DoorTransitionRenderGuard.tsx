import { useEffect, useState } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../core/protocol'
import { White2DoorDepartureRenderGuardV2 } from './White2DoorDepartureRenderGuardV2'

/**
 * Compatibility wrapper around the proven departure-only render guard.
 *
 * This file intentionally does not try to protect arrival yet. The previous
 * bidirectional guard regressed the already-good departure path by competing
 * with the dedicated trainer runtime and exposing native fallback models for
 * longer than before.
 *
 * The wrapper delays mounting the proven V2 guard by one React effect turn so
 * White2DedicatedTrainerRuntime mounts first, matching the ordering that was
 * stable before the bidirectional experiment.
 */
export function White2DoorTransitionRenderGuard({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) return null
  return <White2DoorDepartureRenderGuardV2 bridge={bridge} rom={rom}/>
}
