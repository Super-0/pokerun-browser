import { AppHeader } from '../components/AppHeader'
import { gamesByGeneration } from '../data/games'
import type { GameDefinition, RunState } from '../types'

interface Props {
  runs: RunState[]
  onChooseGame: (game: GameDefinition) => void
}

export function HomeScreen({ runs, onChooseGame }: Props) {
  return (
    <main className="screen home-screen">
      <div className="home-sky" aria-hidden="true"><div className="home-water"/><div className="home-grass"/></div>
      <div className="screen-shell">
        <AppHeader onHome={() => {}} right={<><button className="text-action">MY RUNS</button><button className="text-action">SETTINGS</button></>} />
        <section className="page-title-row">
          <div>
            <h1>CHOOSE YOUR GAME</h1>
            <p>Pick a cartridge to start or continue a Nuzlocke.</p>
          </div>
          <div className="save-count">{runs.length} SAVES</div>
        </section>

        <section className="game-library pixel-border">
          {gamesByGeneration.map(group => (
            <div className="generation-row" key={group.generation}>
              <div className="generation-label">
                <strong>GEN {group.generation}</strong>
                <span>{group.games[0].platform}</span>
              </div>
              <div className="game-grid" style={{ '--count': group.games.length } as React.CSSProperties}>
                {group.games.map(game => {
                  const gameRuns = runs.filter(run => run.gameId === game.id)
                  const latest = gameRuns.at(-1)
                  return (
                    <button className="game-tile pixel-border" key={game.id} onClick={() => onChooseGame(game)}>
                      <span className="game-generation">GEN {game.generation} • {game.platform}</span>
                      <strong>{game.shortTitle}</strong>
                      <span className={`run-status ${latest ? 'has-run' : ''}`}>{latest ? `${gameRuns.length} RUN${gameRuns.length > 1 ? 'S' : ''}` : 'NEW RUN'}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </section>
      </div>
    </main>
  )
}
