import { useEffect, useMemo, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { multiplayerSaveStore, type MultiplayerSaveProfile } from './core/storage/MultiplayerSaveStore'
import { MultiplayerScreen } from './screens/MultiplayerScreen'
import './styles/app.css'
import './styles/emulator.css'
import './styles/game-themes.css'
import './styles/cover-mascots.css'
import './styles/emerald-scene.css'
import './styles/my-runs.css'
import './styles/multiplayer-session.css'

const DEV_ROOM_KEY = 'pokerun-multiplayer-dev-room-v1'
const DEV_SAVE_KEYS = {
  1: 'pokerun-multiplayer-dev-save-player-1-v1',
  2: 'pokerun-multiplayer-dev-save-player-2-v1',
} as const

function goToMainApp() {
  window.location.href = '/'
}

function buttonByText(...labels: string[]) {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => {
    const text = button.textContent?.trim().toUpperCase() ?? ''
    return labels.some(label => text === label)
  }) ?? null
}

function setControlledInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function savedProfileForPlayer(player: 1 | 2) {
  const profileId = localStorage.getItem(DEV_SAVE_KEYS[player])
  if (!profileId) return null
  return multiplayerSaveStore.list('white2').find(profile => profile.id === profileId) ?? null
}

function profileCard(profile: MultiplayerSaveProfile) {
  const expectedTitle = `SAVE ${String(profile.slotNumber).padStart(3, '0')}`
  return [...document.querySelectorAll<HTMLElement>('.run-card')].find(card =>
    card.querySelector('h2')?.textContent?.trim().toUpperCase() === expectedTitle,
  ) ?? null
}

/**
 * Dev-only UI driver. Production multiplayer code stays untouched: this component
 * drives the existing White 2 picker/lobby controls exactly like a person would.
 */
function MultiplayerPlayer({ player }: { player: 1 | 2 }) {
  useEffect(() => {
    document.title = `PokéRun Multiplayer Dev • Player ${player}`
    let cancelled = false
    let pendingJoinCode = ''
    let activeRoomCode = ''
    let createRequested = false
    let saveRequested = false

    function tick() {
      if (cancelled) return

      const sharedRoomCode = localStorage.getItem(DEV_ROOM_KEY)?.trim().toUpperCase() ?? ''
      const roomCodeElement = document.querySelector<HTMLElement>('.lobby-room-code strong')
      const visibleRoomCode = roomCodeElement?.textContent?.trim().toUpperCase() ?? ''

      if (visibleRoomCode) {
        activeRoomCode = visibleRoomCode
        pendingJoinCode = ''
        createRequested = false

        if (player === 1) {
          if (sharedRoomCode !== visibleRoomCode) localStorage.setItem(DEV_ROOM_KEY, visibleRoomCode)
        } else if (sharedRoomCode && sharedRoomCode !== visibleRoomCode) {
          buttonByText('LEAVE ROOM')?.click()
          activeRoomCode = ''
          saveRequested = false
          return
        }

        const playerCards = [...document.querySelectorAll<HTMLElement>('.lobby-player')]
        const localCard = playerCards.find(card => card.textContent?.includes('• YOU'))
        const localRomReady = localCard?.textContent?.includes('ROM VERIFIED') ?? false

        if (!localRomReady) {
          if (!saveRequested) {
            const profile = savedProfileForPlayer(player)
            const card = profile ? profileCard(profile) : null
            const continueButton = card
              ? [...card.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim().toUpperCase() === 'CONTINUE')
              : null
            if (continueButton && !continueButton.disabled) {
              saveRequested = true
              continueButton.click()
            }
          }
          return
        }

        saveRequested = true

        const ready = buttonByText('READY')
        if (ready && !ready.disabled) {
          ready.click()
          return
        }

        if (player === 1) {
          const start = buttonByText('START GAME')
          if (start && !start.disabled) start.click()
        }
        return
      }

      if (player === 2 && activeRoomCode && sharedRoomCode && activeRoomCode !== sharedRoomCode) {
        const leave = buttonByText('LEAVE SESSION', 'LEAVE ROOM')
        if (leave) {
          leave.click()
          activeRoomCode = ''
          pendingJoinCode = ''
          saveRequested = false
          return
        }
      }

      const gameTile = document.querySelector<HTMLButtonElement>('.game-tile')
      if (gameTile) {
        createRequested = false
        gameTile.click()
        return
      }

      if (player === 1) {
        const create = buttonByText('CREATE ROOM')
        if (create && !createRequested) {
          createRequested = true
          create.click()
        }
        return
      }

      if (!sharedRoomCode) return
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Room code"]')
      if (!input) return

      if (input.value !== sharedRoomCode) setControlledInput(input, sharedRoomCode)
      if (pendingJoinCode === sharedRoomCode) return
      pendingJoinCode = sharedRoomCode

      window.setTimeout(() => {
        if (cancelled) return
        const currentInput = document.querySelector<HTMLInputElement>('input[aria-label="Room code"]')
        if (!currentInput || currentInput.value.trim().toUpperCase() !== sharedRoomCode) {
          pendingJoinCode = ''
          return
        }
        buttonByText('JOIN')?.click()
      }, 80)
    }

    const timer = window.setInterval(tick, 100)
    tick()
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [player])

  return <MultiplayerScreen onHome={goToMainApp} onMyRuns={goToMainApp} onSettings={goToMainApp} />
}

function storedSelection(player: 1 | 2, profiles: MultiplayerSaveProfile[]) {
  const stored = localStorage.getItem(DEV_SAVE_KEYS[player])
  if (stored && profiles.some(profile => profile.id === stored)) return stored
  const index = player - 1
  return profiles[index]?.id ?? ''
}

function MultiplayerDevLauncher() {
  const profiles = useMemo(
    () => multiplayerSaveStore.list('white2').slice().sort((a, b) => a.slotNumber - b.slotNumber),
    [],
  )
  const [player1Save, setPlayer1Save] = useState(() => storedSelection(1, profiles))
  const [player2Save, setPlayer2Save] = useState(() => storedSelection(2, profiles))

  useEffect(() => {
    if (player1Save) localStorage.setItem(DEV_SAVE_KEYS[1], player1Save)
    else localStorage.removeItem(DEV_SAVE_KEYS[1])
  }, [player1Save])

  useEffect(() => {
    if (player2Save) localStorage.setItem(DEV_SAVE_KEYS[2], player2Save)
    else localStorage.removeItem(DEV_SAVE_KEYS[2])
  }, [player2Save])

  function launchBoth() {
    localStorage.removeItem(DEV_ROOM_KEY)
    if (player1Save) localStorage.setItem(DEV_SAVE_KEYS[1], player1Save)
    if (player2Save) localStorage.setItem(DEV_SAVE_KEYS[2], player2Save)

    // Only one popup is required. The launcher itself becomes Player 1, which
    // avoids browsers blocking the second of two scripted window.open calls.
    const player2 = window.open('/multiplayer-dev.html?player=2', '_blank')
    if (!player2) {
      window.alert('Player 2 was blocked by the browser. Allow popups for this localhost site, then launch again.')
      return
    }
    window.location.href = '/multiplayer-dev.html?player=1'
  }

  function openPlayer(player: 1 | 2) {
    if (player === 1) localStorage.removeItem(DEV_ROOM_KEY)
    window.location.href = `/multiplayer-dev.html?player=${player}`
  }

  return <main className="screen home-screen">
    <div className="home-sky" aria-hidden="true"><div className="home-water"/><div className="home-grass"/></div>
    <div className="screen-shell">
      <section className="page-title-row">
        <div>
          <span className="eyebrow">LOCAL DEVELOPMENT ONLY</span>
          <h1>MULTIPLAYER DEV HARNESS</h1>
          <p>Launch both White 2 players, restore their saved cartridges, join the same room, ready up, and start automatically.</p>
        </div>
      </section>

      <section className="multiplayer-setup pixel-border">
        <article>
          <h2>PLAYER 1 SAVE</h2>
          <p>Remembered for future launches.</p>
          <select value={player1Save} onChange={event => setPlayer1Save(event.target.value)}>
            <option value="">MANUAL SELECTION</option>
            {profiles.map(profile => <option key={profile.id} value={profile.id}>SAVE {String(profile.slotNumber).padStart(3, '0')} • {profile.fileName}</option>)}
          </select>
        </article>
        <article>
          <h2>PLAYER 2 SAVE</h2>
          <p>Remembered for future launches.</p>
          <select value={player2Save} onChange={event => setPlayer2Save(event.target.value)}>
            <option value="">MANUAL SELECTION</option>
            {profiles.map(profile => <option key={profile.id} value={profile.id}>SAVE {String(profile.slotNumber).padStart(3, '0')} • {profile.fileName}</option>)}
          </select>
        </article>
      </section>

      <section className="multiplayer-setup pixel-border">
        <article>
          <h2>LAUNCH TEST SESSION</h2>
          <p>The current tab becomes Player 1 and one new tab opens for Player 2. No room-code copying is required.</p>
          <button className="pixel-button" onClick={launchBoth}>LAUNCH PLAYER 1 + PLAYER 2</button>
        </article>
        <article>
          <h2>RESTART ONE PLAYER</h2>
          <p>Useful when only one emulator needs to be restarted.</p>
          <div className="join-row">
            <button className="pixel-button ghost" onClick={() => openPlayer(1)}>PLAYER 1</button>
            <button className="pixel-button ghost" onClick={() => openPlayer(2)}>PLAYER 2</button>
          </div>
        </article>
      </section>

      <section className="runs-empty pixel-border">
        <h2>SAVED CARTRIDGES FOUND: {profiles.length}</h2>
        <p>If a player is set to MANUAL SELECTION, that tab will stop in the normal White 2 lobby so you can choose a ROM/save yourself.</p>
      </section>
    </div>
  </main>
}

const player = new URLSearchParams(window.location.search).get('player')
ReactDOM.createRoot(document.getElementById('root')!).render(player === '1' || player === '2' ? <MultiplayerPlayer player={Number(player) as 1 | 2} /> : <MultiplayerDevLauncher />)
