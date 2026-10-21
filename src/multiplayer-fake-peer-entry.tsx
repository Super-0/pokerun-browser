import ReactDOM from 'react-dom/client'
import { FakeRemotePeerPanel } from './multiplayer/debug/FakeRemotePeerPanel'

const DEV_ROOM_KEY = 'pokerun-multiplayer-dev-room-v1'
const TRAINER_RENDER_CACHE_V3_PREFIX = 'pokerun-white2-trainer-render-v3:'
const params = new URLSearchParams(window.location.search)
const player = params.get('player')
const fakeEnabled = params.get('fake') === '1'

function clearLegacyTrainerRenderCacheForFakePeerTest() {
  if (player !== '1' || !fakeEnabled) return
  let removed = 0
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(TRAINER_RENDER_CACHE_V3_PREFIX)) continue
    localStorage.removeItem(key)
    removed += 1
  }
  console.info(`[PokéRun fake peer] Cleared ${removed} White 2 trainer-render V3 cache entr${removed === 1 ? 'y' : 'ies'} before runtime startup.`)
}

function mountFakePeerPanel() {
  if (player !== '1' || !fakeEnabled) return
  const mount = document.createElement('div')
  mount.id = 'fake-remote-peer-root'
  document.body.appendChild(mount)
  ReactDOM.createRoot(mount).render(<FakeRemotePeerPanel roomCodeStorageKey={DEV_ROOM_KEY} />)
}

function mountLauncherButton() {
  if (player || fakeEnabled) return
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = 'LAUNCH PLAYER 1 + FAKE REMOTE'
  button.className = 'pixel-button'
  Object.assign(button.style, {
    position: 'fixed',
    right: '16px',
    bottom: '16px',
    zIndex: '10002',
  })
  button.addEventListener('click', () => {
    localStorage.removeItem(DEV_ROOM_KEY)
    window.location.href = '/multiplayer-dev.html?player=1&fake=1'
  })
  document.body.appendChild(button)
}

clearLegacyTrainerRenderCacheForFakePeerTest()
mountFakePeerPanel()
mountLauncherButton()
