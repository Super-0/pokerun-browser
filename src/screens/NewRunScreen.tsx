import { useMemo, useState } from 'react'
import { AppHeader } from '../components/AppHeader'
import { GameBackdrop } from '../components/GameBackdrop'
import { PixelButton } from '../components/PixelButton'
import type { GameDefinition, RunState } from '../types'

interface Props {
  game: GameDefinition
  onHome: () => void
  onStart: (runType: RunState['runType'], ruleset: RunState['ruleset'], seed: string) => void
}

function makeSeed() {
  return Math.random().toString(16).slice(2, 9).toUpperCase()
}

export function NewRunScreen({ game, onHome, onStart }: Props) {
  const [runType, setRunType] = useState<RunState['runType']>('Randomized')
  const [ruleset, setRuleset] = useState<RunState['ruleset']>('Hardcore')
  const [seed, setSeed] = useState(makeSeed)
  const romStatus = useMemo(() => 'NOT LOADED', [])

  return (
    <main className="screen themed-screen" style={{
      '--theme-sky': game.theme.sky,
      '--theme-sky-soft': game.theme.skySoft,
      '--theme-accent': game.theme.accent,
      '--theme-accent-dark': game.theme.accentDark,
      '--theme-ground': game.theme.ground,
      '--theme-water': game.theme.water,
    } as React.CSSProperties}>
      <GameBackdrop game={game} />
      <div className="screen-shell">
        <AppHeader onHome={onHome} />
        <section className="setup-header">
          <div>
            <span className="eyebrow">NEW RUN</span>
            <h1>{game.title.toUpperCase()}</h1>
            <p>GEN {game.generation} • {game.region.toUpperCase()} • {game.platform}</p>
          </div>
          <button className="game-chip pixel-border" onClick={onHome}>CHANGE GAME</button>
        </section>

        <div className="setup-layout">
          <section className="setup-steps pixel-border">
            <SetupStep number="01" title="ROM" subtitle="Your ROM stays on this device.">
              <div className="inline-row"><PixelButton>CHOOSE ROM</PixelButton><span className="status-chip warning">{romStatus}</span></div>
            </SetupStep>

            <SetupStep number="02" title="RUN TYPE" subtitle="Choose how PokéRun should prepare the cartridge.">
              <ChoiceRow value={runType} values={['Vanilla', 'Randomized']} onChange={v => setRunType(v as RunState['runType'])} />
            </SetupStep>

            <SetupStep number="03" title="SEED" subtitle="Same settings + seed can reproduce this randomization.">
              <div className="seed-row"><code>{seed}</code><PixelButton tone="ghost" onClick={() => setSeed(makeSeed())}>REROLL</PixelButton></div>
            </SetupStep>

            <SetupStep number="04" title="RULESET" subtitle="Tracking rules can be changed later.">
              <ChoiceRow value={ruleset} values={['Standard', 'Hardcore', 'Custom']} onChange={v => setRuleset(v as RunState['ruleset'])} />
            </SetupStep>
          </section>

          <aside className="setup-summary pixel-border">
            <span className="eyebrow">RUN PREVIEW</span>
            <h2>{game.shortTitle}</h2>
            <dl>
              <div><dt>TYPE</dt><dd>{runType.toUpperCase()}</dd></div>
              <div><dt>RULES</dt><dd>{ruleset.toUpperCase()}</dd></div>
              <div><dt>SEED</dt><dd>{seed}</dd></div>
              <div><dt>PLATFORM</dt><dd>{game.platform}</dd></div>
            </dl>
            {runType === 'Randomized' && (
              <div className="randomizer-summary">
                <strong>RANDOMIZER</strong>
                <span>Wild encounters: Random</span>
                <span>Trainer Pokémon: Random</span>
                <span>Starters: Random</span>
                <PixelButton tone="ghost">EDIT DETAILS</PixelButton>
              </div>
            )}
            <PixelButton className="start-run" onClick={() => onStart(runType, ruleset, seed)}>START RUN</PixelButton>
            <small>Prototype: ROM selection is visual only for now.</small>
          </aside>
        </div>
      </div>
    </main>
  )
}

function SetupStep({ number, title, subtitle, children }: React.PropsWithChildren<{ number: string, title: string, subtitle: string }>) {
  return <div className="setup-step"><div className="step-heading"><span>{number}</span><div><h3>{title}</h3><p>{subtitle}</p></div></div><div className="step-body">{children}</div></div>
}

function ChoiceRow({ value, values, onChange }: { value: string, values: string[], onChange: (value: string) => void }) {
  return <div className="choice-row">{values.map(item => <button key={item} className={item === value ? 'selected' : ''} onClick={() => onChange(item)}>{item.toUpperCase()}</button>)}</div>
}
