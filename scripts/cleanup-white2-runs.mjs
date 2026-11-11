import { lstat, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const privateRoot = resolve('local-test-assets')
const apply = process.argv.includes('--apply')
const dryRun = process.argv.includes('--dry-run') || !apply
const ageArgument = process.argv.find(argument => argument.startsWith('--older-than-hours='))
const olderThanHours = ageArgument ? Number(ageArgument.split('=', 2)[1]) : 24

if (!Number.isFinite(olderThanHours) || olderThanHours < 0) {
  throw new Error('--older-than-hours must be a non-negative number.')
}

const entries = await readdir(privateRoot, { withFileTypes: true })
const cutoff = Date.now() - olderThanHours * 60 * 60 * 1000
const lockNames = ['SingletonCookie', 'SingletonLock', 'SingletonSocket']
const candidates = []

for (const entry of entries) {
  if (!entry.isDirectory() || !/^white2-run-[A-Za-z0-9]+$/.test(entry.name)) continue
  const run = join(privateRoot, entry.name)
  const profile = join(run, 'profile')
  let profileStats
  try {
    profileStats = await lstat(profile)
  } catch (error) {
    if (error.code === 'ENOENT') continue
    throw error
  }
  if (!profileStats.isDirectory() || profileStats.mtimeMs > cutoff) continue
  const locks = []
  for (const name of lockNames) {
    try {
      await lstat(join(profile, name))
      locks.push(name)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  candidates.push({ entry: entry.name, profile, locks })
}

for (const candidate of candidates) {
  if (candidate.locks.length) {
    console.log(`SKIP active profile ${candidate.entry} (${candidate.locks.join(', ')})`)
    continue
  }
  console.log(`${dryRun ? 'WOULD REMOVE' : 'REMOVING'} ${candidate.profile}`)
  if (!dryRun) await rm(candidate.profile, { recursive: true, force: true })
}

console.log(`${dryRun ? 'Dry run' : 'Cleanup'} complete: ${candidates.length} eligible profile(s) inspected.`)
