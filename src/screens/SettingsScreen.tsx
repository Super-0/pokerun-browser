import { AppHeader } from '../components/AppHeader'
import { PixelButton } from '../components/PixelButton'
import '../styles/navigation.css'

interface Props {
  onBack: () => void
  onHome: () => void
  onMyRuns: () => void
}

export function SettingsScreen({ onBack, onHome, onMyRuns }: Props) {
  return (
    <main className="screen home-screen">
      <div className="home-sky" aria-hidden="true"><div className="home-water"/><div className="home-grass"/></div>
      <div className="screen-shell">
        <AppHeader onHome={onHome} />

        <section className="page-title-row">
          <div>
            <span className="eyebrow">POKÉRUN</span>
            <h1>SETTINGS</h1>
            <p>App-wide options live here. Run-specific tracking rules are chosen when a run is created.</p>
          </div>
          <PixelButton tone="ghost" onClick={onBack}>BACK</PixelButton>
        </section>

        <section className="settings-page-grid">
          <article className="settings-page-card pixel-border">
            <h2>NAVIGATION</h2>
            <p>Jump between your library and saved runs without changing any run data.</p>
            <div className="settings-page-actions">
              <PixelButton onClick={onHome}>GAME LIBRARY</PixelButton>
              <PixelButton tone="ghost" onClick={onMyRuns}>MY RUNS</PixelButton>
            </div>
          </article>

          <article className="settings-page-card pixel-border">
            <h2>APP OPTIONS</h2>
            <p>Display, controls, audio defaults, save management, and other app-wide preferences will be added here as those systems are built.</p>
            <span className="settings-coming-soon">NO APP-WIDE OPTIONS YET</span>
          </article>
        </section>
      </div>
    </main>
  )
}
