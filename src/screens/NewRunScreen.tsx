import { useRef, useState } from 'react'
import { AppHeader } from '../components/AppHeader'
import { GameBackdrop } from '../components/GameBackdrop'
import { PixelButton } from '../components/PixelButton'
import { getGameRuntimeSupport } from '../core/game/gameSupport'
import { formatRomSize, loadRomFile, type LoadedRom } from '../core/rom/RomLoader'
import type { GameDefinition, RunState } from '../types'

interface Props {
  game: GameDefinition
  onHome: () => void
  onStart: (runType: RunState['runType'], ruleset: RunState['ruleset'], seed: string, rom: LoadedRom) => void
}

function makeSeed() {
  return Math.random().toString(16).slice(2, 9).toUpperCase()
}

export function NewRunScreen({ game, onHome, onStart }: Props) {
  const [runType, setRunType] = useState<RunState['runType']>('Randomized')
  const [ruleset, setRuleset] = useState<RunState['ruleset']>('Hardcore')
  const [seed, setSeed] = useState(makeSeed)
  const [rom, setRom] = useState<LoadedRom | null>(null)
  const [romMessage, setRomMessage] = useState('NOT LOADED')
  const [romError, setRomError] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const runtime = getGameRuntimeSupport(game.id)

  async function chooseRom(file: File | undefined) {
    if (!file) return
    try {
      const loaded = await loadRomFile(file, game)
      setRom(loaded)
      setRomMessage(`${loaded.fileName} • ${formatRomSize(loaded.size)}`)
      setRomError(false)
    } catch (error) {
      setRom(null)
      setRomMessage(error instanceof Error ? error.message : 'ROM could not be loaded.')
      setRomError(true)
    }
  }

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
            <p>GEN {game.generation} • {game.region.toUpperCase()} • {game.platform} • {runtime.emulator.toUpperCase()}</p>
          </div>
          <button className="game-chip pixel-border" onClick={onHome}>CHANGE GAME</button>
        </section>

        <div className="setup-layout">
          <section className="setup-steps pixel-border">
            <SetupStep number="01" title="ROM" subtitle={`Choose your own ${runtime.acceptedRomExtensions.join(' / ')} file. It stays on this device.`}>
              <div className="rom-picker">
                <input
                  ref={fileInput}
                  hidden
                  type="file"
                  accept={runtime.acceptedRomExtensions.join(',')}
                  onChange={event => void chooseRom(event.target.files?.[0])}
                />
                <div className="inline-row">
                  <PixelButton onClick={() => fileInput.current?.click()}>{rom ? 'CHANGE ROM' : 'CHOOSE ROM'}</PixelButton>
                  <span className={`status-chip ${romError ? 'error' : rom ? 'ready' : 'warning'}`}>{romMessage}</span>
                </div>
              </div>
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
              <div><dt>CORE</dt><dd>{runtime.emulator.toUpperCase()}</dd></div>
              <div><dt>ROM</dt><dd>{rom ? 'READY' : 'REQUIRED'}</dd></div>
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
            <PixelButton className="start-run" disabled={!rom} onClick={() => rom && onStart(runType, ruleset, seed, rom)}>START RUN</PixelButton>
            <small>{rom ? 'ROM bytes are held locally for this browser session.' : 'Select a ROM before starting the run.'}</small>
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
