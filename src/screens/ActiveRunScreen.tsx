import { AppHeader } from '../components/AppHeader'
import { GameBackdrop } from '../components/GameBackdrop'
import { PixelButton } from '../components/PixelButton'
import type { GameDefinition, RunState } from '../types'

interface Props {
  game: GameDefinition
  run: RunState
  onHome: () => void
  onChange: (run: RunState) => void
}

export function ActiveRunScreen({ game, run, onHome, onChange }: Props) {
  const seconds = run.playTimeSeconds
  const time = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map(n => String(n).padStart(2,'0')).join(':')
  const update = (patch: Partial<RunState>) => onChange({ ...run, ...patch, updatedAt: new Date().toISOString() })

  function damageFirst() {
    const party = run.party.map((p, i) => i === 0 ? { ...p, hp: Math.max(0, p.hp - 20), status: p.hp - 20 <= 0 ? 'FAINTED' as const : p.status } : p)
    update({ party, deaths: run.deaths + (party[0]?.hp === 0 && run.party[0]?.hp !== 0 ? 1 : 0) })
  }

  function faintSecond() {
    if (!run.party[1] || run.party[1].hp === 0) return
    const party = run.party.map((p, i) => i === 1 ? { ...p, hp: 0, status: 'FAINTED' as const } : p)
    update({ party, deaths: run.deaths + 1 })
  }

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
        <AppHeader onHome={onHome} right={<div className="run-header-meta"><span>{game.title.toUpperCase()} • RUN {String(run.runNumber).padStart(3,'0')}</span><strong>{time}</strong><PixelButton tone="ghost">MENU</PixelButton></div>} />

        <div className="active-layout">
          <section className="emulator-column">
            <div className="emulator-toolbar pixel-border"><strong>GAME</strong><span>1×</span><button>PAUSE</button><button>AUDIO</button><button>FULLSCREEN</button></div>
            <div className={`emulator-stack ${game.platform === 'NDS' ? 'dual' : 'single'}`}>
              <div className="emu-screen pixel-border"><span>{game.shortTitle}</span><small>EMULATOR TOP SCREEN</small></div>
              {game.platform === 'NDS' && <div className="emu-screen bottom pixel-border"><span>TOUCH SCREEN</span><small>EMULATOR BOTTOM SCREEN</small></div>}
            </div>
          </section>

          <aside className="hud-column">
            <HudPanel title="RUN INFO">
              <div className="badge-row">{Array.from({ length: 8 }, (_, i) => <i key={i} className={i < run.badges ? 'earned' : ''} />)}</div>
              <div className="hud-stats"><span>BADGES <b>{run.badges}/8</b></span><span>DEATHS <b>{run.deaths}</b></span><span>LEVEL CAP <b>{run.levelCap}</b></span><span>NEXT BOSS <b>{run.nextBoss}</b></span></div>
            </HudPanel>

            <HudPanel title="PARTY">
              <div className="party-list">
                {Array.from({ length: 6 }, (_, i) => {
                  const p = run.party[i]
                  if (!p) return <div className="party-row empty" key={i}><div className="sprite-box"/><span>EMPTY</span></div>
                  const pct = Math.max(0, Math.min(100, p.hp / p.maxHp * 100))
                  return <div className={`party-row ${p.hp === 0 ? 'fainted' : ''}`} key={p.id}><div className="sprite-box">{p.species[0]}</div><div className="party-copy"><div><strong>{p.nickname}</strong><span>LV{p.level}</span></div><div className="hp-track"><i style={{ width: `${pct}%` }}/></div><small>{p.hp}/{p.maxHp} HP</small></div></div>
                })}
              </div>
            </HudPanel>

            <HudPanel title="RUN DATA"><div className="run-data"><span>SEED</span><code>{run.seed}</code><span>{run.runType.toUpperCase()}</span></div></HudPanel>
          </aside>
        </div>

        <section className="route-strip pixel-border"><div><span>CURRENT AREA</span><strong>{run.currentMap.toUpperCase()}</strong></div><div><span>ENCOUNTER</span><strong className="available">{run.encounterStatus.replace('_',' ')}</strong></div><div><span>RULES</span><strong>{run.ruleset.toUpperCase()}</strong></div></section>

        <nav className="tracker-tabs pixel-border"><button className="active">PARTY</button><button>ENCOUNTERS</button><button>GRAVEYARD</button><button>RUN LOG</button><button>BOSSES</button></nav>

        <details className="dev-panel pixel-border">
          <summary>DEV GAME STATE SIMULATOR</summary>
          <div><PixelButton tone="ghost" onClick={() => update({ currentMap: run.currentMap === 'Route 6' ? 'Chargestone Cave' : 'Route 6', encounterStatus: 'AVAILABLE' })}>ENTER NEW AREA</PixelButton><PixelButton tone="ghost" onClick={() => update({ encounterStatus: 'IN_PROGRESS', encounterSpecies: 'Koffing' })}>START WILD BATTLE</PixelButton><PixelButton tone="ghost" onClick={damageFirst}>DAMAGE LEAD</PixelButton><PixelButton tone="danger" onClick={faintSecond}>FAINT SLOT 2</PixelButton><PixelButton tone="ghost" onClick={() => update({ badges: Math.min(8, run.badges + 1) })}>EARN BADGE</PixelButton></div>
        </details>
      </div>
    </main>
  )
}

function HudPanel({ title, children }: React.PropsWithChildren<{ title: string }>) {
  return <section className="hud-panel pixel-border"><h2>{title}</h2>{children}</section>
}
