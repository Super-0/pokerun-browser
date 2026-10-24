import fs from 'node:fs'

const path = 'src/multiplayer/games/White2DedicatedTrainerRuntime.tsx'
let source = fs.readFileSync(path, 'utf8')

//
// 1. Keep a persistent copy of the last successfully rendered protagonist
// profile. Do NOT fall back to the dedicated actor's native NPC renderer.
//
const profileStateAnchor =
  '    let latestRemoteProfile: RenderProfile | null = null\n'

if (!source.includes('let lastVisibleRemoteProfile: RenderProfile | null = null')) {
  if (!source.includes(profileStateAnchor)) {
    throw new Error('latestRemoteProfile state anchor not found.')
  }

  source = source.replace(
    profileStateAnchor,
    profileStateAnchor +
      '    let lastVisibleRemoteProfile: RenderProfile | null = null\n',
  )
}

//
// 2. Cache only real, successfully selected remote protagonist profiles.
//
const latestProfileAnchor = '      latestRemoteProfile = profile\n'
const latestProfileIndex = source.lastIndexOf(latestProfileAnchor)

if (
  latestProfileIndex >= 0 &&
  !source.includes('lastVisibleRemoteProfile = { ...profile }')
) {
  const replacement =
    latestProfileAnchor +
    '      if (profile) lastVisibleRemoteProfile = { ...profile }\n'

  source =
    source.slice(0, latestProfileIndex) +
    replacement +
    source.slice(latestProfileIndex + latestProfileAnchor.length)
}

//
// 3. Never use binding.nativeRender during departure.
// If no cached profile exists, null means applyRemoteFrame leaves the currently
// visible billboard material/face untouched.
//
source = source.replace(
  '            const departureProfile = latestRemoteProfile ?? binding.nativeRender\n',
  '            const departureProfile = lastVisibleRemoteProfile ?? latestRemoteProfile\n',
)

//
// 4. The recorded transition metadata arrives after the real player has already
// begun the retail door sequence. When replaying it locally, give the door time
// to visibly open before sliding the remote trainer inside.
//
source = source.replace(
  'const REMOTE_DOOR_DEPARTURE_HOLD_MS = 260\n',
  'const REMOTE_DOOR_DEPARTURE_LEAD_MS = 430\n' +
    'const REMOTE_DOOR_DEPARTURE_TRAVEL_MS = 260\n',
)

source = source.replaceAll(
  'age < REMOTE_DOOR_DEPARTURE_HOLD_MS',
  'age < REMOTE_DOOR_DEPARTURE_LEAD_MS + REMOTE_DOOR_DEPARTURE_TRAVEL_MS',
)

source = source.replace(
  '            const progress = Math.min(1, Math.max(0, age / REMOTE_DOOR_DEPARTURE_HOLD_MS))\n',
  '            const travelAge = Math.max(0, age - REMOTE_DOOR_DEPARTURE_LEAD_MS)\n' +
    '            const progress = Math.min(1, travelAge / REMOTE_DOOR_DEPARTURE_TRAVEL_MS)\n',
)

fs.writeFileSync(path, source)

console.log(
  'Departure replay now pins the last protagonist profile and waits 430 ms for the door before the 260 ms entry motion.',
)
