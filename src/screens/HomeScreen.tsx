import { AppHeader } from '../components/AppHeader'
import { gamesByGeneration } from '../data/games'
import type { GameDefinition, RunState } from '../types'

interface Props {
  runs: RunState[]
  onChooseGame: (game: GameDefinition) => void
  onMyRuns: () => void
  onSettings: () => void
}

export function HomeScreen({ runs, onChooseGame, onMyRuns, onSettings }: Props) {
  return (
    <main className="screen home-screen">
      <div className="home-sky" aria-hidden="true"><div className="home-water"/><div className="home-grass"/></div>
      <div className="screen-shell">
        <AppHeader
          onHome={() => {}}
          right={(
            <>
              <button className="text-action" onClick={onMyRuns}>MY RUNS</button>
              <button className="text-action" onClick={onSettings}>SETTINGS</button>
            </>
          )}
        />
        <section className="page-title-row">
          <div>
            <h1>CHOOSE YOUR GAME</h1>
            <p>Pick a cartridge to start a new Pokémon run.</p>
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
                  const tileStyle = {
                    '--tile-accent': game.theme.accent,
                    '--tile-accent-dark': game.theme.accentDark,
                    '--tile-soft': game.theme.skySoft,
                  } as React.CSSProperties

                  return (
                    <button
                      className="game-tile themed-game-tile pixel-border"
                      style={tileStyle}
                      key={game.id}
                      onClick={() => onChooseGame(game)}
                    >
                      <span className="game-generation">GEN {game.generation} • {game.platform}</span>
                      <strong>{game.shortTitle}</strong>
                      <span className={`run-status ${gameRuns.length ? 'has-run' : ''}`}>
                        {gameRuns.length ? `NEW RUN • ${gameRuns.length} SAVED` : 'NEW RUN'}
                      </span>
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
