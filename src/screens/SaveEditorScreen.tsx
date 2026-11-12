import { useEffect, useRef, useState } from 'react'
import { BagEditor } from './save-editor/BagEditor'
import { PokemonDetailPanel } from './save-editor/PokemonDetailPanel'
import { TrainerProgressPanel } from './save-editor/TrainerProgressPanel'
import type { PokemonSummary } from '@pkhex-everywhere/engine'
import { AppHeader } from '../components/AppHeader'
import { PixelButton } from '../components/PixelButton'
import {
  closeEditorSave, editTrainer, exportEditorSave, setTrainerBattlePoints,
  loadEditorSave, type EditorSnapshot,
} from '../core/save-editor/pkhexEditor'
import '../styles/save-editor.css'

interface Props {
  onHome: () => void
  onSettings: () => void
}
type EditorTab = 'trainer' | 'party' | 'boxes' | 'bag'

function editedName(name: string) {
  return name.replace(/(\.[^.]+)?$/, '-edited$1')
}

function backupName(name: string) {
  return name.replace(/(\.[^.]+)?$/, '-backup$1')
}

function download(bytes: Uint8Array, fileName: string) {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function failureMessage(error: unknown) {
  if (error instanceof Error) {
    if (error.message.includes('format-choice-required')) {
      return 'This save matches more than one format. PokéRun will not guess which game it belongs to.'
    }
    return error.message
  }
  return 'Could not load this save file.'
}

export function SaveEditorScreen({ onHome, onSettings }: Props) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [originalFile, setOriginalFile] = useState<File | null>(null)
  const [originalBytes, setOriginalBytes] = useState<Uint8Array | null>(null)
  const [snapshot, setSnapshot] = useState<EditorSnapshot | null>(null)
  const [tab, setTab] = useState<EditorTab>('trainer')
  const [boxIndex, setBoxIndex] = useState(0)
  const [selected, setSelected] = useState<PokemonSummary | null>(null)
  const [trainerName, setTrainerName] = useState('')
  const [money, setMoney] = useState('')
  const [battlePoints, setBattlePoints] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => () => { void closeEditorSave() }, [])

  async function load(file?: File) {
    if (!file || busy) return
    setBusy(true)
    setError('')
    setMessage('')
    setSelected(null)
    setSnapshot(null)
    setDirty(false)
    setOriginalFile(null)
    setOriginalBytes(null)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) {
        throw new Error('Choose a non-empty battery save smaller than 8 MiB.')
      }
      setOriginalFile(file)
      setOriginalBytes(bytes)
      const loaded = await loadEditorSave(file)
      setSnapshot(loaded)
      setTab('trainer')
      setBoxIndex(loaded.boxes[0]?.box ?? 0)
      setTrainerName(loaded.trainer.name)
      setMoney(loaded.trainer.money === null ? '' : String(loaded.trainer.money))
      setBattlePoints(loaded.trainer.battlePoints === null ? '' : String(loaded.trainer.battlePoints))
    } catch (reason) {
      setError(failureMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  async function applyTrainer() {
    if (!snapshot || busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const edits: { name?: string, money?: number } = {}
      if (trainerName !== snapshot.trainer.name) edits.name = trainerName
      if (snapshot.trainer.money !== null && money !== String(snapshot.trainer.money)) {
        if (money.trim() === '') throw new Error('Enter a money amount.')
        edits.money = Number(money)
      }
      if (!Object.keys(edits).length) return
      const next = await editTrainer(edits)
      setSnapshot(next)
      setTrainerName(next.trainer.name)
      setMoney(next.trainer.money === null ? '' : String(next.trainer.money))
      setDirty(true)
      setMessage('Trainer changes applied to the in-memory copy. Export to save them.')
    } catch (reason) {
      setError(failureMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  async function applyBattlePoints() {
    if (!snapshot || snapshot.trainer.battlePoints === null || busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      if (battlePoints.trim() === '') throw new Error('Enter a Battle Points value.')
      const next = await setTrainerBattlePoints(Number(battlePoints))
      setSnapshot(next)
      setBattlePoints(next.trainer.battlePoints === null ? '' : String(next.trainer.battlePoints))
      setDirty(true)
      setMessage('Battle Points updated in memory. Export to keep them.')
    } catch (reason) {
      setError(failureMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  async function exportEdited() {
    if (!snapshot || !originalFile || !dirty || busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await exportEditorSave()
      if (!result.bytes.length) throw new Error('Engine exported an empty save.')
      download(result.bytes, editedName(originalFile.name))
      setMessage('Edited copy downloaded. Your original file and PokéRun runs are unchanged.')
    } catch (reason) {
      setError(failureMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  function selectPokemon(pokemon: PokemonSummary) {
    setSelected(pokemon)
    setMessage('')
    setError('')
  }

  const activeBox = snapshot?.boxes.find(box => box.box === boxIndex)
  const boxPokemon = snapshot?.boxed.filter(pokemon =>
    pokemon.at.source === 'box' && pokemon.at.box === boxIndex,
  ) ?? []

  return (
    <main className="screen home-screen">
      <div className="home-sky" aria-hidden="true"><div className="home-water"/><div className="home-grass"/></div>
      <div className="screen-shell">
        <AppHeader onHome={onHome} right={<button className="text-action" onClick={onSettings}>SETTINGS</button>} />

        <section className="page-title-row">
          <div>
            <h1>SAVE EDITOR</h1>
            <p>Generation I–V save editor. Import, edit and export locally.</p>
          </div>
          <PixelButton tone="ghost" onClick={onHome}>BACK TO HOME</PixelButton>
        </section>

        <section className="save-editor-top pixel-border">
          <div>
            <strong>{snapshot ? snapshot.save.version.toUpperCase() : 'NO SAVE LOADED'}</strong>
            <span>{snapshot ? 'GEN ' + snapshot.save.generation + ' • ' + originalFile?.name : 'Import a battery-save file (.sav / .srm / .dsv / .dat)'}</span>
          </div>
          <div className="save-editor-actions">
            <input
              ref={fileInput}
              className="save-editor-file-input"
              aria-label="Choose save file"
              type="file"
              accept=".sav,.srm,.dsv,.dat,.bin"
              disabled={busy}
              onChange={event => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                void load(file)
              }}
            />
            <PixelButton tone="ghost" disabled={busy} onClick={() => fileInput.current?.click()}>
              {busy ? 'LOADING...' : 'IMPORT SAVE'}
            </PixelButton>
            <PixelButton tone="ghost" disabled={!originalBytes || !originalFile || busy}
              onClick={() => originalBytes && originalFile && download(originalBytes, backupName(originalFile.name))}>
              DOWNLOAD BACKUP
            </PixelButton>
            <PixelButton disabled={!snapshot || !dirty || busy} onClick={() => void exportEdited()}>
              EXPORT EDITED SAVE
            </PixelButton>
          </div>
        </section>

        {error && <p className="save-editor-error pixel-border" role="alert">{error}</p>}
        {message && <p className="save-editor-success pixel-border" role="status">{message}</p>}

        {!snapshot ? (
          <section className="save-editor-welcome pixel-border">
            <span className="eyebrow">LOAD A SAVE FILE</span>
            <h2>{busy ? 'READING SAVE...' : originalFile ? 'FORMAT NOT VERIFIED' : 'READY WHEN YOU ARE'}</h2>
            <p>
              PokéRun reads the file using PKHeX's generation-aware engine. If it cannot
              confidently recognize the format, no editing is enabled.
              The imported file stays on your device.
            </p>
          </section>
        ) : (
          <>
            <nav className="save-editor-tabs pixel-border" aria-label="Save editor sections">
              {(['trainer', 'party', 'boxes', 'bag'] as const).map(option => (
                <button key={option} type="button"
                  className={tab === option ? 'selected' : ''}
                  onClick={() => { setTab(option); setSelected(null); setMessage('') }}
                >{option.toUpperCase()}</button>
              ))}
            </nav>

            {tab === 'trainer' && (
              <section className="save-editor-panel pixel-border">
                <span className="eyebrow">TRAINER DATA</span>
                <div className="save-editor-record">
                  <span>GAME</span><strong>{snapshot.save.version}</strong>
                </div>
                <div className="save-editor-record">
                  <span>TRAINER ID</span><strong>{snapshot.trainer.id}</strong>
                </div>
                <div className="save-editor-fields">
                  <label className="save-editor-field" htmlFor="trainer-name">
                    <strong>TRAINER NAME</strong>
                    <input id="trainer-name" value={trainerName} maxLength={snapshot.trainer.maxNameLength}
                      disabled={busy} onChange={event => setTrainerName(event.target.value)} />
                  </label>
                  {snapshot.trainer.money !== null && (
                    <label className="save-editor-field" htmlFor="trainer-money">
                      <strong>MONEY</strong>
                      <input id="trainer-money" type="number" value={money} min="0" max="999999" step="1"
                        disabled={busy} onChange={event => setMoney(event.target.value)} />
                    </label>
                  )}
                </div>
                <PixelButton disabled={busy || (trainerName === snapshot.trainer.name &&
                  money === (snapshot.trainer.money === null ? '' : String(snapshot.trainer.money)))}
                  onClick={() => void applyTrainer()}>APPLY TRAINER CHANGES</PixelButton>
                {snapshot.trainer.battlePoints !== null && (
                  <div className="save-editor-bp-field">
                    <label className="save-editor-field" htmlFor="trainer-bp">
                      <strong>BATTLE POINTS</strong>
                      <input id="trainer-bp" type="number" value={battlePoints} min="0" max="65535" step="1"
                        disabled={busy} onChange={event => setBattlePoints(event.target.value)} />
                    </label>
                    <PixelButton disabled={busy || battlePoints === String(snapshot.trainer.battlePoints)}
                      onClick={() => void applyBattlePoints()}>APPLY BATTLE POINTS</PixelButton>
                  </div>
                )}
              </section>
            )}

            {tab === 'trainer' && (
              <TrainerProgressPanel onChanged={() => {
                setDirty(true)
                setMessage('Badges updated in memory. Export to keep your changes.')
              }} />
            )}

            {tab === 'party' && (
              <section className="save-editor-panel pixel-border">
                <span className="eyebrow">CURRENT PARTY</span>
                <div className="save-editor-pokemon-grid">
                  {snapshot.party.length === 0 && <p>No Pokémon in the party.</p>}
                  {snapshot.party.map(pokemon => (
                    <button type="button" key={JSON.stringify(pokemon.at)}
                      className={'save-editor-pokemon ' + (selected?.id === pokemon.id ? 'active' : '')}
                      onClick={() => selectPokemon(pokemon)}>
                      <strong>{pokemon.nickname}</strong>
                      <small>{pokemon.species} • LV {pokemon.level}</small>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {tab === 'boxes' && (
              <section className="save-editor-panel pixel-border">
                <span className="eyebrow">PC STORAGE</span>
                <label className="save-editor-box-picker">BOX
                  <select value={boxIndex} onChange={event => {
                    setBoxIndex(Number(event.target.value))
                    setSelected(null)
                  }}>
                    {snapshot.boxes.map(box => (
                      <option key={box.box} value={box.box}>{box.name || 'BOX ' + (box.box + 1)}</option>
                    ))}
                  </select>
                </label>
                <div className="save-editor-pokemon-grid save-editor-box-grid">
                  {Array.from({ length: activeBox?.slots ?? 0 }, (_, index) => {
                    const pokemon = boxPokemon.find(p =>
                      p.at.source === 'box' && p.at.slot === index,
                    )
                    return pokemon ? (
                      <button type="button" className={'save-editor-pokemon ' + (selected?.id === pokemon.id ? 'active' : '')}
                        key={index} onClick={() => selectPokemon(pokemon)}>
                        <strong>{pokemon.nickname}</strong>
                        <small>LV {pokemon.level}</small>
                      </button>
                    ) : <div key={index} className="save-editor-empty-slot" aria-label={'Empty slot ' + (index + 1)}>{index + 1}</div>
                  })}
                </div>
              </section>
            )}

            {tab === 'bag' && (
              <BagEditor onChanged={() => {
                setDirty(true)
                setError('')
                setMessage('Inventory updated in memory. Export to keep the changes.')
              }} />
            )}

            {selected && (tab === 'party' || tab === 'boxes') && (
              <PokemonDetailPanel
                key={JSON.stringify(selected.at)}
                pokemon={selected}
                generation={snapshot.save.generation}
                onSaved={next => {
                  setSnapshot(next)
                  setSelected(null)
                  setDirty(true)
                  setError('')
                  setMessage('Pokémon updated in memory. Export to keep the changes.')
                }}
                onClose={() => setSelected(null)}
              />
            )}
          </>
        )}

        <p className="save-editor-footnote">
          Edits affect only an in-memory copy until you export. Keep the untouched backup.
          Import the edited file into your emulator separately; do not replace a save while the game is running.
          Powered by PKHeX.Everywhere (GPL-3.0-or-later).
        </p>
      </div>
    </main>
  )
}
