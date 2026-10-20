import ReactDOM from 'react-dom/client'
import { MultiplayerScreen } from './screens/MultiplayerScreen'
import './styles/app.css'
import './styles/emulator.css'
import './styles/game-themes.css'
import './styles/cover-mascots.css'
import './styles/emerald-scene.css'
import './styles/my-runs.css'
import './styles/multiplayer-session.css'

function goToMainApp() {
  window.location.href = '/'
}

function MultiplayerPlayer() {
  return <MultiplayerScreen onHome={goToMainApp} onMyRuns={goToMainApp} onSettings={goToMainApp} />
}

function MultiplayerDevLauncher() {
  function openPlayer(player: 1 | 2) {
    window.open(`/multiplayer-dev.html?player=${player}`, `pokerun-multiplayer-player-${player}`)
  }

  function openBoth() {
    openPlayer(1)
    window.setTimeout(() => openPlayer(2), 120)
  }

  return <main className="screen home-screen">
    <div className="home-sky" aria-hidden="true"><div className="home-water"/><div className="home-grass"/></div>
    <div className="screen-shell">
      <section className="page-title-row">
        <div>
          <span className="eyebrow">LOCAL DEVELOPMENT ONLY</span>
          <h1>MULTIPLAYER DEV HARNESS</h1>
          <p>Launch two isolated PokéRun multiplayer tabs without going through the normal app flow.</p>
        </div>
      </section>
      <section className="multiplayer-setup pixel-border">
        <article>
          <h2>OPEN BOTH PLAYERS</h2>
          <p>Opens two dedicated multiplayer tabs. If your browser blocks the second popup, use the individual buttons.</p>
          <button className="pixel-button" onClick={openBoth}>OPEN PLAYER 1 + PLAYER 2</button>
        </article>
        <article>
          <h2>INDIVIDUAL TABS</h2>
          <p>Useful when restarting only one emulator during testing.</p>
          <div className="join-row">
            <button className="pixel-button ghost" onClick={() => openPlayer(1)}>PLAYER 1</button>
            <button className="pixel-button ghost" onClick={() => openPlayer(2)}>PLAYER 2</button>
          </div>
        </article>
      </section>
      <section className="runs-empty pixel-border">
        <h2>WHAT THIS ISOLATES</h2>
        <p>The normal PokéRun app is not mounted here. Each player tab mounts only the multiplayer screen and its emulator stack. The normal <code>npm run dev</code> path is unchanged.</p>
      </section>
    </div>
  </main>
}

const player = new URLSearchParams(window.location.search).get('player')
ReactDOM.createRoot(document.getElementById('root')!).render(player === '1' || player === '2' ? <MultiplayerPlayer /> : <MultiplayerDevLauncher />)
