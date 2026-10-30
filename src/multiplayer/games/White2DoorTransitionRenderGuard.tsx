import { useEffect, useState } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../core/protocol'
import { White2DoorDepartureRenderGuardV2 } from './White2DoorDepartureRenderGuardV2'

/**
 * Door-transition rendering now has a single responsibility: protect the proven
 * remote departure animation. Arrival visibility is owned by the dedicated
 * trainer lifecycle itself (defer native spawn, bind hidden, write protagonist
 * render, then reveal). Keeping arrival hide/show logic here would create a
 * second visibility owner and can make the remote billboard flash.
 *
 * The one-effect delayed mount preserves the component ordering used by the
 * known-good departure renderer.
 */
export function White2DoorTransitionRenderGuard({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const [departureGuardMounted, setDepartureGuardMounted] = useState(false)

  useEffect(() => {
    setDepartureGuardMounted(true)
  }, [])

  return departureGuardMounted
    ? <White2DoorDepartureRenderGuardV2 bridge={bridge} rom={rom}/>
    : null
}
