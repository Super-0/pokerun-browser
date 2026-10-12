import { AppHeader } from '../components/AppHeader'
import { PixelButton } from '../components/PixelButton'
import { gameById } from '../data/games'
import type { GameDefinition, RunState } from '../types'
import '../styles/my-runs.css'

interface Props {
  runs: RunState[]
  onHome: () => void
  onOpenRun: (run: RunState) => void
  onNewRun: (game: GameDefinition) => void
}

export function MyRunsScreen({ runs, onHome, onOpenRun, onNewRun }: Props) {
  const ordered = [...runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  return (
    <main className="screen home-screen">
      <div className="home-sky" aria-hidden="true"><div className="home-water"/><div className="home-grass"/></div>
      <div className="screen-shell">
        <AppHeader onHome={onHome} />

        <section className="page-title-row">
          <div>
            <h1>MY RUNS</h1>
            <p>Continue a saved run or start another run for the same game.</p>
          </div>
          <PixelButton tone="ghost" onClick={onHome}>GAME LIBRARY</PixelButton>
        </section>

        {ordered.length === 0 ? (
          <section className="runs-empty pixel-border">
            <h2>NO RUNS YET</h2>
            <p>Choose a game from the library to start your first run.</p>
            <PixelButton onClick={onHome}>CHOOSE A GAME</PixelButton>
          </section>
        ) : (
          <section className="runs-list">
            {ordered.map(run => {
              const game = gameById[run.gameId]
              return (
                <article className="run-card pixel-border" key={run.id}>
                  <div className="run-card-main">
                    <span className="eyebrow">{game.title.toUpperCase()}</span>
                    <h2>RUN {String(run.runNumber).padStart(3, '0')}</h2>
                    <div className="run-card-meta">
                      <span>{run.runType.toUpperCase()}</span>
                      <span>{run.badges}/8 BADGES</span>
                      <span>{run.currentMap.toUpperCase()}</span>
                    </div>
                  </div>
                  <div className="run-card-actions">
                    <PixelButton onClick={() => onOpenRun(run)}>CONTINUE</PixelButton>
                    <PixelButton tone="ghost" onClick={() => onNewRun(game)}>NEW RUN</PixelButton>
                  </div>
                </article>
              )
            })}
          </section>
        )}
      </div>
    </main>
  )
}
