import type { RunSettings } from '../../types'

export const DEFAULT_RUN_SETTINGS: RunSettings = {
  faintAsDeath: false,
  encounterTracking: true,
  levelCaps: false,
  runLog: true,
  deathHandling: 'Automatic',
  encounterMode: 'AllCatches',
  levelCapMode: 'Gyms',
  runLogDetail: 'Major',
}

export function countEnabledTracking(settings: RunSettings) {
  return [
    settings.faintAsDeath,
    settings.encounterTracking,
    settings.levelCaps,
    settings.runLog,
  ].filter(Boolean).length
}
