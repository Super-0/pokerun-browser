import { useEffect, useMemo, useState } from 'react'
import { AppHeader } from '../components/AppHeader'
import { GameBackdrop } from '../components/GameBackdrop'
import { MgbaPlayer } from '../components/MgbaPlayer'
import { PixelButton } from '../components/PixelButton'
import { MockEmulatorBridge } from '../core/emulator/MockEmulatorBridge'
import type { EmeraldLiveSnapshot } from '../core/game/emerald/EmeraldLiveState'
import { MockGameStateAdapter } from '../core/game/MockGameStateAdapter'
import { formatPartyLabel, getPokemonSpriteUrl, resolvePartySpecies } from '../core/game/pokemonSpecies'
import { countEnabledTracking } from '../core/run/runSettings'
import { RunEngine, type RunEvent } from '../core/run/RunEngine'
import type { GameDefinition, RunState } from '../types'
import '../styles/navigation.css'
import '../styles/party.css'

type TrackerTab = 'party' | 'encounters' | 'graveyard' | 'log' | 'bosses'

interface Props {
  game: GameDefinition
  run: RunState
  onHome: () => void
  onMyRuns: () => void
  onSettings: () => void
  onChange: (run: RunState) => void
}

export function ActiveRunScreen({ game, run, onHome, onMyRuns, onSettings, onChange }: Props) {
  const seconds = run.playTimeSeconds
  const time = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map(n => String(n).padStart(2,'0')).join(':')
  const [lastEvents, setLastEvents] = useState<RunEvent[]>([])
  const [liveState, setLiveState] = useState<EmeraldLiveSnapshot | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [activeTracker, setActiveTracker] = useState<TrackerTab>('party')

  const trackerRuntime = useMemo(() => {
    const emulator = new MockEmulatorBridge(game.platform)
    const adapter = new MockGameStateAdapter(run)
    const engine = new RunEngine(adapter, emulator, adapter.peek())
    return { emulator, adapter, engine }
    // A run gets one tracking runtime. State changes should flow through the engine, not recreate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, game.platform])

  useEffect(() => {
    setLiveState(null)
    setActiveTracker('party')
    setMenuOpen(false)
  }, [game.id, run.id])

  useEffect(() => {
    return () => { void trackerRuntime.emulator.dispose() }
  }, [trackerRuntime])

  async function simulate(mutator: (adapter: MockGameStateAdapter) => void) {
    mutator(trackerRuntime.adapter)
    const result = await trackerRuntime.engine.sync(run)
    setLastEvents(result.events)
    onChange(result.run)
  }

  const displayedParty = game.id === 'emerald' && liveState ? liveState.party : run.party
  const displayedMap = game.id === 'emerald' && liveState ? liveState.currentMap : run.currentMap
  const enabledTracking = countEnabledTracking(run.settings)

  return (
    <main className="screen themed-screen active-run" style={{
      '--theme-sky': game.theme.sky,
      '--theme-sky-soft': game.theme.skySoft,
      '--theme-accent': game.theme.accent,
      '--theme-accent-dark': game.theme.accentDark,
      '--theme-ground': game.theme.ground,
      '--theme-water': game.theme.water,
    } as React.CSSProperties}>
      <GameBackdrop game={game} />
      <div className="screen-shell">
        <AppHeader
          onHome={onHome}
          right={(
            <div className="run-header-meta">
              <span>{game.title.toUpperCase()} • RUN {String(run.runNumber).padStart(3,'0')}</span>
              <strong>{time}</strong>
              <PixelButton tone="ghost" onClick={() => setMenuOpen(true)}>MENU</PixelButton>
            </div>
          )}
        />

        <div className="active-layout">
          <section className="emulator-column">
            {game.platform === 'NDS' ? (
              <>
                <div className="emulator-toolbar pixel-border"><strong>melonDS</strong><span>NOT CONNECTED</span></div>
                <div className="emulator-stack dual">
                  <div className="emu-screen pixel-border"><span>{game.shortTitle}</span><small>NINTENDO DS CORE COMES NEXT</small></div>
                  <div className="emu-screen bottom pixel-border"><span>TOUCH SCREEN</span><small>MELONDS PLACEHOLDER</small></div>
                </div>
              </>
            ) : <MgbaPlayer game={game} run={run} onLiveState={setLiveState} />}
          </section>

          <aside className="hud-column">
            <HudPanel title="RUN INFO">
              <div className="badge-row">{Array.from({ length: 8 }, (_, i) => <i key={i} className={i < run.badges ? 'earned' : ''} />)}</div>
              <div className="hud-stats">
                <span>BADGES <b>{run.badges}/8</b></span>
                {run.settings.faintAsDeath && <span>DEATHS <b>{run.deaths}</b></span>}
                {run.settings.levelCaps && <span>LEVEL CAP <b>{run.levelCap}</b></span>}
                <span>NEXT BOSS <b>{run.nextBoss}</b></span>
              </div>
            </HudPanel>

            <HudPanel title={liveState ? 'PARTY • LIVE' : 'PARTY'}>
              <div className="party-list">
                {Array.from({ length: 6 }, (_, i) => {
                  const p = displayedParty[i]
                  if (!p) return <div className="party-row empty" key={i}><div className="sprite-box"/><span>EMPTY</span></div>

                  const pct = p.maxHp > 0 ? Math.max(0, Math.min(100, p.hp / p.maxHp * 100)) : 0
                  const species = resolvePartySpecies(game.id, p)
                  const label = formatPartyLabel(p.nickname, species.name)
                  const spriteUrl = getPokemonSpriteUrl(game.id, species.nationalDexId)

                  return (
                    <div className={`party-row ${p.hp === 0 ? 'fainted' : ''}`} key={p.id}>
                      <div className="sprite-box" title={species.name}>
                        <span className="sprite-fallback">{species.name[0] ?? '?'}</span>
                        {spriteUrl && (
                          <img
                            className="party-species-sprite"
                            src={spriteUrl}
                            alt={`${species.name} sprite`}
                            crossOrigin="anonymous"
                            onError={event => { event.currentTarget.style.display = 'none' }}
                          />
                        )}
                      </div>
                      <div className="party-copy">
                        <div><strong>{label}</strong><span>LV{p.level}</span></div>
                        <div className="hp-track"><i style={{ width: `${pct}%` }}/></div>
                        <small>{p.hp}/{p.maxHp} HP{p.status && p.status !== 'OK' ? ` • ${p.status}` : ''}</small>
                      </div>
                    </div>
                  )
                })}
              </div>
            </HudPanel>

            <HudPanel title="RUN DATA"><div className="run-data"><span>SEED</span><code>{run.seed}</code><span>{run.runType.toUpperCase()}</span></div></HudPanel>
          </aside>
        </div>

        <section className="route-strip pixel-border">
          <div><span>CURRENT AREA</span><strong>{displayedMap.toUpperCase()}</strong></div>
          <div><span>ENCOUNTER</span><strong className="available">{run.settings.encounterTracking ? run.encounterStatus.replace('_',' ') : 'TRACKING OFF'}</strong></div>
          <div><span>TRACKING</span><strong>{enabledTracking}/4 MODULES</strong></div>
        </section>

        <nav className="tracker-tabs pixel-border" aria-label="Run trackers">
          <button className={activeTracker === 'party' ? 'active' : ''} onClick={() => setActiveTracker('party')}>PARTY</button>
          {run.settings.encounterTracking && <button className={activeTracker === 'encounters' ? 'active' : ''} onClick={() => setActiveTracker('encounters')}>ENCOUNTERS</button>}
          {run.settings.faintAsDeath && <button className={activeTracker === 'graveyard' ? 'active' : ''} onClick={() => setActiveTracker('graveyard')}>GRAVEYARD</button>}
          {run.settings.runLog && <button className={activeTracker === 'log' ? 'active' : ''} onClick={() => setActiveTracker('log')}>RUN LOG</button>}
          <button className={activeTracker === 'bosses' ? 'active' : ''} onClick={() => setActiveTracker('bosses')}>BOSSES</button>
        </nav>

        <TrackerContent tab={activeTracker} run={run} partyCount={displayedParty.length} />

        {game.id !== 'emerald' && (
          <details className="dev-panel pixel-border">
            <summary>DEV GAME STATE SIMULATOR</summary>
            <div>
              <PixelButton tone="ghost" onClick={() => void simulate(adapter => adapter.enterMap(run.currentMap === 'Route 6' ? 'Chargestone Cave' : 'Route 6'))}>ENTER NEW AREA</PixelButton>
              <PixelButton tone="ghost" onClick={() => void simulate(adapter => adapter.setBattle({ kind: 'wild', opponentSpecies: 'Koffing' }))}>START WILD BATTLE</PixelButton>
              <PixelButton tone="ghost" onClick={() => void simulate(adapter => adapter.damagePartyMember(0, 20))}>DAMAGE LEAD</PixelButton>
              <PixelButton tone="danger" onClick={() => void simulate(adapter => adapter.faintPartyMember(1))}>FAINT SLOT 2</PixelButton>
              <PixelButton tone="ghost" onClick={() => void simulate(adapter => adapter.earnBadge())}>EARN BADGE</PixelButton>
            </div>
            {lastEvents.length > 0 && <small>ENGINE: {lastEvents.map(event => event.type).join(' • ')}</small>}
          </details>
        )}
      </div>

      {menuOpen && (
        <div className="run-menu-backdrop" role="presentation" onMouseDown={() => setMenuOpen(false)}>
          <section className="run-menu-card pixel-border" role="dialog" aria-modal="true" aria-label="Run menu" onMouseDown={event => event.stopPropagation()}>
            <span className="eyebrow">{game.shortTitle.toUpperCase()} • RUN {String(run.runNumber).padStart(3,'0')}</span>
            <h2>RUN MENU</h2>
            <p>Your run stays saved when you leave this screen.</p>
            <div className="run-menu-actions">
              <PixelButton onClick={() => setMenuOpen(false)}>RESUME</PixelButton>
              <PixelButton tone="ghost" onClick={onMyRuns}>MY RUNS</PixelButton>
              <PixelButton tone="ghost" onClick={onHome}>GAME LIBRARY</PixelButton>
              <PixelButton tone="ghost" onClick={onSettings}>APP SETTINGS</PixelButton>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}

function TrackerContent({ tab, run, partyCount }: { tab: TrackerTab, run: RunState, partyCount: number }) {
  if (tab === 'party') {
    return <section className="tracker-content pixel-border"><h2>PARTY</h2><p><strong>{partyCount}/6</strong> party slots currently occupied. Live party details are shown in the HUD above.</p></section>
  }

  if (tab === 'encounters') {
    return <section className="tracker-content pixel-border"><h2>ENCOUNTERS</h2><p>Encounter tracking is enabled. Route history will live here when the encounter system is added.</p></section>
  }

  if (tab === 'graveyard') {
    return <section className="tracker-content pixel-border"><h2>GRAVEYARD</h2><p><strong>{run.deaths}</strong> deaths recorded. Fainted Pokémon history will live here when death tracking is added.</p></section>
  }

  if (tab === 'log') {
    return <section className="tracker-content pixel-border"><h2>RUN LOG</h2><p>Automatic run logging is enabled. Recorded events will appear here as the event system is built.</p></section>
  }

  return (
    <section className="tracker-content pixel-border">
      <h2>BOSSES</h2>
      <p>Next target: <strong>{run.nextBoss.toUpperCase()}</strong>{run.settings.levelCaps ? ` • LEVEL CAP ${run.levelCap}` : ''}.</p>
    </section>
  )
}

function HudPanel({ title, children }: React.PropsWithChildren<{ title: string }>) {
  return <section className="hud-panel pixel-border"><h2>{title}</h2>{children}</section>
}
