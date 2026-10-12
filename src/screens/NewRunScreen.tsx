import { useEffect, useRef, useState } from 'react'
import { AppHeader } from '../components/AppHeader'
import { GameBackdrop } from '../components/GameBackdrop'
import { PixelButton } from '../components/PixelButton'
import { getGameRuntimeSupport } from '../core/game/gameSupport'
import { DEFAULT_RUN_SETTINGS } from '../core/run/runSettings'
import { hasDevelopmentRom, loadDevelopmentRom } from '../core/rom/DevRomLoader'
import { formatRomSize, loadRomFile, type LoadedRom } from '../core/rom/RomLoader'
import type { GameDefinition, RunSettings, RunState } from '../types'
import '../styles/run-settings.css'

interface Props {
  game: GameDefinition
  onHome: () => void
  onStart: (runType: RunState['runType'], settings: RunSettings, seed: string, rom: LoadedRom) => void
}

function makeSeed() {
  return Math.random().toString(16).slice(2, 9).toUpperCase()
}

export function NewRunScreen({ game, onHome, onStart }: Props) {
  const [runType, setRunType] = useState<RunState['runType']>('Randomized')
  const [settings, setSettings] = useState<RunSettings>({ ...DEFAULT_RUN_SETTINGS })
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [seed, setSeed] = useState(makeSeed)
  const [rom, setRom] = useState<LoadedRom | null>(null)
  const [romMessage, setRomMessage] = useState('NOT LOADED')
  const [romError, setRomError] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const runtime = getGameRuntimeSupport(game.id)
  const devRomAvailable = hasDevelopmentRom(game)

  useEffect(() => {
    let cancelled = false

    setRom(null)
    setRomError(false)
    setRomMessage(devRomAvailable ? 'CHECKING DEV ROM...' : 'NOT LOADED')

    if (!devRomAvailable) return () => { cancelled = true }

    void loadDevelopmentRom(game).then(loaded => {
      if (cancelled) return

      if (!loaded) {
        setRomMessage('DEV ROM NOT FOUND')
        return
      }

      setRom(loaded)
      setRomMessage(`DEV ROM • ${loaded.fileName} • ${formatRomSize(loaded.size)}`)
    })

    return () => { cancelled = true }
  }, [devRomAvailable, game])

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

  function updateSetting<K extends keyof RunSettings>(key: K, value: RunSettings[K]) {
    setSettings(current => ({ ...current, [key]: value }))
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
            <SetupStep
              number="01"
              title="ROM"
              subtitle={devRomAvailable
                ? 'Development mode checks /public/dev-roms/emerald.gba automatically. You can still choose another ROM.'
                : `Choose your own ${runtime.acceptedRomExtensions.join(' / ')} file. It stays on this device.`}
            >
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

            <SetupStep number="02" title="RUN TYPE" subtitle="Choose whether the cartridge stays vanilla or is randomized.">
              <ChoiceRow value={runType} values={['Vanilla', 'Randomized']} onChange={v => setRunType(v as RunState['runType'])} />
            </SetupStep>

            <SetupStep number="03" title="SEED" subtitle="Same settings + seed can reproduce this randomization.">
              <div className="seed-row"><code>{seed}</code><PixelButton tone="ghost" onClick={() => setSeed(makeSeed())}>REROLL</PixelButton></div>
            </SetupStep>

            <SetupStep number="04" title="RUN SETTINGS" subtitle="Turn on only the tracking rules you want for this run.">
              <div className="run-settings-panel">
                <SettingToggle
                  title="FAINT = DEATH"
                  description="Track a fainted Pokémon as a death and enable the Graveyard."
                  checked={settings.faintAsDeath}
                  onChange={value => updateSetting('faintAsDeath', value)}
                />
                <SettingToggle
                  title="ENCOUNTER TRACKING"
                  description="Track catches and encounters by area."
                  checked={settings.encounterTracking}
                  onChange={value => updateSetting('encounterTracking', value)}
                />
                <SettingToggle
                  title="LEVEL CAPS"
                  description="Show and track the current level cap."
                  checked={settings.levelCaps}
                  onChange={value => updateSetting('levelCaps', value)}
                />
                <SettingToggle
                  title="RUN LOG"
                  description="Automatically record important events during the run."
                  checked={settings.runLog}
                  onChange={value => updateSetting('runLog', value)}
                />

                <button
                  type="button"
                  className="advanced-settings-toggle"
                  aria-expanded={showAdvanced}
                  onClick={() => setShowAdvanced(value => !value)}
                >
                  ADVANCED SETTINGS <span>{showAdvanced ? '−' : '+'}</span>
                </button>

                {showAdvanced && (
                  <div className="advanced-settings-panel">
                    <AdvancedSetting
                      title="DEATH HANDLING"
                      description="Choose whether a faint is recorded immediately or asks for confirmation."
                      disabled={!settings.faintAsDeath}
                    >
                      <OptionRow
                        value={settings.deathHandling}
                        options={[
                          { value: 'Automatic', label: 'AUTO' },
                          { value: 'Confirm', label: 'CONFIRM' },
                        ]}
                        disabled={!settings.faintAsDeath}
                        onChange={value => updateSetting('deathHandling', value as RunSettings['deathHandling'])}
                      />
                    </AdvancedSetting>

                    <AdvancedSetting
                      title="ENCOUNTER MODE"
                      description="Track every catch or treat the first encounter in each area as the tracked encounter."
                      disabled={!settings.encounterTracking}
                    >
                      <OptionRow
                        value={settings.encounterMode}
                        options={[
                          { value: 'AllCatches', label: 'ALL CATCHES' },
                          { value: 'FirstPerArea', label: 'FIRST / AREA' },
                        ]}
                        disabled={!settings.encounterTracking}
                        onChange={value => updateSetting('encounterMode', value as RunSettings['encounterMode'])}
                      />
                    </AdvancedSetting>

                    <AdvancedSetting
                      title="LEVEL CAP TARGETS"
                      description="Use gym leaders only, or include other major bosses when supported."
                      disabled={!settings.levelCaps}
                    >
                      <OptionRow
                        value={settings.levelCapMode}
                        options={[
                          { value: 'Gyms', label: 'GYMS' },
                          { value: 'MajorBosses', label: 'MAJOR BOSSES' },
                        ]}
                        disabled={!settings.levelCaps}
                        onChange={value => updateSetting('levelCapMode', value as RunSettings['levelCapMode'])}
                      />
                    </AdvancedSetting>

                    <AdvancedSetting
                      title="RUN LOG DETAIL"
                      description="Keep only major milestones or log smaller team and route events too."
                      disabled={!settings.runLog}
                    >
                      <OptionRow
                        value={settings.runLogDetail}
                        options={[
                          { value: 'Major', label: 'MAJOR' },
                          { value: 'Detailed', label: 'DETAILED' },
                        ]}
                        disabled={!settings.runLog}
                        onChange={value => updateSetting('runLogDetail', value as RunSettings['runLogDetail'])}
                      />
                    </AdvancedSetting>
                  </div>
                )}
              </div>
            </SetupStep>
          </section>

          <aside className="setup-summary pixel-border">
            <span className="eyebrow">RUN PREVIEW</span>
            <h2>{game.shortTitle}</h2>
            <dl>
              <div><dt>TYPE</dt><dd>{runType.toUpperCase()}</dd></div>
              <div><dt>SEED</dt><dd>{seed}</dd></div>
              <div><dt>PLATFORM</dt><dd>{game.platform}</dd></div>
              <div><dt>CORE</dt><dd>{runtime.emulator.toUpperCase()}</dd></div>
              <div><dt>ROM</dt><dd>{rom ? 'READY' : 'REQUIRED'}</dd></div>
            </dl>

            <div className="settings-summary">
              <strong>RUN SETTINGS</strong>
              <SummarySetting label="FAINT = DEATH" enabled={settings.faintAsDeath} />
              <SummarySetting label="ENCOUNTERS" enabled={settings.encounterTracking} />
              <SummarySetting label="LEVEL CAPS" enabled={settings.levelCaps} />
              <SummarySetting label="RUN LOG" enabled={settings.runLog} />
            </div>

            {runType === 'Randomized' && (
              <div className="randomizer-summary">
                <strong>RANDOMIZER</strong>
                <span>Wild encounters: Random</span>
                <span>Trainer Pokémon: Random</span>
                <span>Starters: Random</span>
                <PixelButton tone="ghost">EDIT DETAILS</PixelButton>
              </div>
            )}
            <PixelButton className="start-run" disabled={!rom} onClick={() => rom && onStart(runType, settings, seed, rom)}>START RUN</PixelButton>
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

function SettingToggle({ title, description, checked, onChange }: { title: string, description: string, checked: boolean, onChange: (checked: boolean) => void }) {
  return (
    <button type="button" className={`setting-toggle ${checked ? 'enabled' : ''}`} aria-pressed={checked} onClick={() => onChange(!checked)}>
      <span className="setting-toggle-copy"><strong>{title}</strong><small>{description}</small></span>
      <span className="setting-switch" aria-hidden="true"><i /></span>
    </button>
  )
}

function AdvancedSetting({ title, description, disabled, children }: React.PropsWithChildren<{ title: string, description: string, disabled?: boolean }>) {
  return (
    <div className={`advanced-setting ${disabled ? 'disabled' : ''}`}>
      <div><strong>{title}</strong><small>{description}</small></div>
      {children}
    </div>
  )
}

function OptionRow({ value, options, disabled, onChange }: { value: string, options: { value: string, label: string }[], disabled?: boolean, onChange: (value: string) => void }) {
  return (
    <div className="setting-option-row">
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          className={option.value === value ? 'selected' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function SummarySetting({ label, enabled }: { label: string, enabled: boolean }) {
  return <span><b>{label}</b><em className={enabled ? 'on' : 'off'}>{enabled ? 'ON' : 'OFF'}</em></span>
}
