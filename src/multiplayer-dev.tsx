import { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { MultiplayerScreen } from './screens/MultiplayerScreen'
import './styles/app.css'
import './styles/emulator.css'
import './styles/game-themes.css'
import './styles/cover-mascots.css'
import './styles/emerald-scene.css'
import './styles/my-runs.css'
import './styles/multiplayer-session.css'

const DEV_ROOM_KEY = 'pokerun-multiplayer-dev-room-v1'

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

/**
 * Dev-only UI driver. It deliberately uses the production multiplayer UI instead
 * of adding a second room/session implementation: Player 1 creates a normal room,
 * publishes that generated code through same-origin localStorage, and Player 2
 * enters the normal join flow with that code.
 */
function MultiplayerPlayer({ player }: { player: 1 | 2 }) {
  useEffect(() => {
    document.title = `PokéRun Multiplayer Dev • Player ${player}`
    let cancelled = false
    let pendingJoinCode = ''
    let activeRoomCode = ''

    function tick() {
      if (cancelled) return

      const sharedRoomCode = localStorage.getItem(DEV_ROOM_KEY)?.trim().toUpperCase() ?? ''
      const roomCodeElement = document.querySelector<HTMLElement>('.lobby-room-code strong')
      const visibleRoomCode = roomCodeElement?.textContent?.trim().toUpperCase() ?? ''

      if (visibleRoomCode) {
        activeRoomCode = visibleRoomCode
        pendingJoinCode = ''
        if (player === 1) {
          if (sharedRoomCode !== visibleRoomCode) localStorage.setItem(DEV_ROOM_KEY, visibleRoomCode)
        } else if (sharedRoomCode && sharedRoomCode !== visibleRoomCode) {
          buttonByText('LEAVE ROOM')?.click()
          activeRoomCode = ''
        }
        return
      }

      // If Player 1 was restarted while Player 2 was already in-game, leave the
      // stale session so the ordinary picker/setup flow can rejoin the new room.
      if (player === 2 && activeRoomCode && sharedRoomCode && activeRoomCode !== sharedRoomCode) {
        const leave = buttonByText('LEAVE SESSION', 'LEAVE ROOM')
        if (leave) {
          leave.click()
          activeRoomCode = ''
          pendingJoinCode = ''
          return
        }
      }

      // Multiplayer currently exposes White 2 as the registered dev game. Select
      // the first registered game tile rather than duplicating registry logic here.
      const gameTile = document.querySelector<HTMLButtonElement>('.game-tile')
      if (gameTile) {
        gameTile.click()
        return
      }

      if (player === 1) {
        buttonByText('CREATE ROOM')?.click()
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

function MultiplayerDevLauncher() {
  function openPlayer(player: 1 | 2) {
    if (player === 1) localStorage.removeItem(DEV_ROOM_KEY)
    window.open(`/multiplayer-dev.html?player=${player}`, `pokerun-multiplayer-player-${player}`)
  }

  function openBoth() {
    localStorage.removeItem(DEV_ROOM_KEY)
    window.open('/multiplayer-dev.html?player=1', 'pokerun-multiplayer-player-1')
    window.setTimeout(() => window.open('/multiplayer-dev.html?player=2', 'pokerun-multiplayer-player-2'), 180)
  }

  return <main className="screen home-screen">
    <div className="home-sky" aria-hidden="true"><div className="home-water"/><div className="home-grass"/></div>
    <div className="screen-shell">
      <section className="page-title-row">
        <div>
          <span className="eyebrow">LOCAL DEVELOPMENT ONLY</span>
          <h1>MULTIPLAYER DEV HARNESS</h1>
          <p>Launch two isolated White 2 multiplayer tabs without going through the normal app or copying room codes.</p>
        </div>
      </section>
      <section className="multiplayer-setup pixel-border">
        <article>
          <h2>OPEN BOTH PLAYERS</h2>
          <p>Player 1 creates a normal White 2 room automatically. Player 2 reads that room code locally and joins it automatically.</p>
          <button className="pixel-button" onClick={openBoth}>OPEN PLAYER 1 + PLAYER 2</button>
        </article>
        <article>
          <h2>INDIVIDUAL TABS</h2>
          <p>Player 1 starts a fresh dev room. Player 2 joins the current dev room.</p>
          <div className="join-row">
            <button className="pixel-button ghost" onClick={() => openPlayer(1)}>PLAYER 1</button>
            <button className="pixel-button ghost" onClick={() => openPlayer(2)}>PLAYER 2</button>
          </div>
        </article>
      </section>
      <section className="runs-empty pixel-border">
        <h2>WHAT THIS ISOLATES</h2>
        <p>The normal PokéRun app is not mounted here. Room creation/join automation exists only in this dev entry point; the production multiplayer session and transport are unchanged.</p>
      </section>
    </div>
  </main>
}

const player = new URLSearchParams(window.location.search).get('player')
ReactDOM.createRoot(document.getElementById('root')!).render(player === '1' || player === '2' ? <MultiplayerPlayer player={Number(player) as 1 | 2} /> : <MultiplayerDevLauncher />)
