import { AppHeader } from '../components/AppHeader'
import { PixelButton } from '../components/PixelButton'
import { gameById } from '../data/games'
import type { RunState } from '../types'
import '../styles/home-runs.css'

interface Props {
  runs: RunState[]
  onNewRun: () => void
  onOpenRun: (run: RunState) => void
  onMultiplayer: () => void
  onMyRuns: () => void
  onSettings: () => void
}

function playTime(seconds: number) {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0')
}

function runLabel(run: RunState) {
  return 'RUN ' + String(run.runNumber).padStart(3, '0')
}

export function HomeScreen({ runs, onNewRun, onOpenRun, onMultiplayer, onMyRuns, onSettings }: Props) {
  const ordered = [...runs]
    .filter(run => Boolean(gameById[run.gameId]))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const featured = ordered[0] ?? null
  const otherRuns = ordered.slice(1, 5)
  const game = featured ? gameById[featured.gameId] : null

  const tileStyle = game ? {
    '--tile-accent': game.theme.accent,
    '--tile-accent-dark': game.theme.accentDark,
    '--tile-soft': game.theme.skySoft,
  } as React.CSSProperties : undefined

  return (
    <main className="screen home-screen">
      <div className="home-sky" aria-hidden="true"><div className="home-water"/><div className="home-grass"/></div>
      <div className="screen-shell">
        <AppHeader
          onHome={() => {}}
          right={(
            <>
              <button className="text-action" onClick={onMultiplayer}>MULTIPLAYER</button>
              <button className="text-action" onClick={onSettings}>SETTINGS</button>
            </>
          )}
        />

        <section className="page-title-row">
          <div>
            <h1>YOUR RUNS</h1>
            <p>Pick up where you left off, or start something new.</p>
          </div>
          {featured && <PixelButton onClick={onNewRun}>+ NEW RUN</PixelButton>}
        </section>

        {!featured || !game ? (
          <section className="home-empty pixel-border">
            <span className="eyebrow">YOUR FIRST ADVENTURE</span>
            <h2>NO RUNS YET</h2>
            <p>Choose a Pokémon game to create your first run.</p>
            <PixelButton onClick={onNewRun}>+ NEW RUN</PixelButton>
          </section>
        ) : (
          <>
            <section className="home-featured-section" aria-label="Continue playing">
              <div className="home-section-heading">
                <h2>CONTINUE PLAYING</h2>
                <span>{ordered.length} {ordered.length === 1 ? 'SAVE' : 'SAVES'}</span>
              </div>
              <div className="featured-run pixel-border">
                <div className="featured-game-tile game-tile themed-game-tile pixel-border" style={tileStyle}>
                  <span className="game-generation">GEN {game.generation} • {game.platform}</span>
                  <strong>{game.shortTitle}</strong>
                  <span className="run-status">{game.region.toUpperCase()}</span>
                </div>
                <div className="featured-run-details">
                  <span className="eyebrow">{game.title.toUpperCase()}</span>
                  <h3>{runLabel(featured)}</h3>
                  <div className="featured-run-meta">
                    <span>{featured.runType.toUpperCase()}</span>
                    <span>TIME {playTime(featured.playTimeSeconds)}</span>
                    <span>BADGES {featured.badges}/8</span>
                  </div>
                  <p>{featured.currentMap.toUpperCase()}</p>
                </div>
                <PixelButton className="featured-continue" onClick={() => onOpenRun(featured)}>CONTINUE</PixelButton>
              </div>
            </section>

            {otherRuns.length > 0 && (
              <section className="home-other-section" aria-label="Other runs">
                <div className="home-section-heading">
                  <h2>OTHER RUNS</h2>
                  {ordered.length > 5 && <button className="text-action" onClick={onMyRuns}>VIEW ALL RUNS</button>}
                </div>
                <div className="home-run-list pixel-border">
                  {otherRuns.map(run => {
                    const otherGame = gameById[run.gameId]
                    return (
                      <article className="home-run-row" key={run.id}>
                        <span className="home-run-accent" style={{ background: otherGame.theme.accent }} aria-hidden="true"/>
                        <div className="home-run-title">
                          <strong>{otherGame.title.toUpperCase()}</strong>
                          <span>{runLabel(run)} • {run.runType.toUpperCase()}</span>
                        </div>
                        <span className="home-run-time">{playTime(run.playTimeSeconds)}</span>
                        <PixelButton tone="ghost" onClick={() => onOpenRun(run)}>CONTINUE</PixelButton>
                      </article>
                    )
                  })}
                </div>
              </section>
            )}
            {ordered.length > 1 && ordered.length <= 5 && (
              <div className="home-all-runs-link">
                <button className="text-action" onClick={onMyRuns}>VIEW ALL RUNS</button>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  )
}
