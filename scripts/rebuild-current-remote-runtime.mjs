import { spawnSync } from 'node:child_process'

const scripts = [
  'scripts/apply-map-transition-recovery-v2.mjs',
  'scripts/apply-local-transition-safe-cleanup.mjs',
  'scripts/apply-generic-error-abandon-only.mjs',
  'scripts/apply-ensure-actor-abandon-recovery.mjs',
  'scripts/apply-door-departure-visual-debug.mjs',
  'scripts/apply-native-door-at-pos-and-park-remote.mjs',
  'scripts/apply-remote-map-native-hide.mjs',
  'scripts/apply-remote-billboard-visibility.mjs',
  'scripts/apply-offmap-frame-hide-ownership.mjs',
  'scripts/apply-exclusive-remote-actor-ownership.mjs',
  'scripts/apply-door-departure-visual-timing.mjs',
]

for (const script of scripts) {
  console.log(`\n=== ${script} ===`)
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

console.log('\nRebuilt current White 2 remote runtime patch stack.')
