import { useEffect, useRef, useState } from 'react'
import { BagEditor } from './save-editor/BagEditor'
import { PokemonDetailPanel } from './save-editor/PokemonDetailPanel'
import { TrainerProgressPanel } from './save-editor/TrainerProgressPanel'
import { BoxToolsPanel } from './save-editor/BoxToolsPanel'
import { MysteryGiftPanel } from './save-editor/MysteryGiftPanel'
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
type EditorTab = 'trainer' | 'party' | 'boxes' | 'bag' | 'gifts'

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
  const [pcSearch, setPcSearch] = useState('')
  const [dragging, setDragging] = useState(false)
  const [selected, setSelected] = useState<PokemonSummary | null>(null)
  const [trainerName, setTrainerName] = useState('')
  const [money, setMoney] = useState('')
  const [battlePoints, setBattlePoints] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => () => { void closeEditorSave() }, [])

  async function load(file?: File, confirmReplacement = true) {
    if (!file || busy) return
    if (dirty && confirmReplacement && !window.confirm('You have unexported changes. Replace this save and discard those changes?')) return
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
      setPcSearch('')
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

  const pcMatches = pcSearch.trim().length > 0 ? (snapshot?.boxed ?? []).filter(pokemon =>
    (pokemon.nickname + ' ' + pokemon.species + ' ' + (pokemon.speciesId ?? '')).toLowerCase()
      .includes(pcSearch.trim().toLowerCase()),
  ).slice(0, 75) : []
  const tabs: EditorTab[] = ['trainer', 'party', 'boxes', 'bag']
  if (snapshot?.save.hasMysteryGift) tabs.push('gifts')
  const activeBox = snapshot?.boxes.find(box => box.box === boxIndex)
  const boxPokemon = snapshot?.boxed.filter(pokemon =>
    pokemon.at.source === 'box' && pokemon.at.box === boxIndex,
  ) ?? []


  const sectionTitles: Record<EditorTab, { title: string, description: string, number: string }> = {
    trainer: { title: 'TRAINER PROFILE', description: 'Player identity, currency, badges and adventure progress.', number: '01' },
    party: { title: 'YOUR PARTY', description: 'Choose one of your six party Pokémon to inspect or edit.', number: '02' },
    boxes: { title: 'PC STORAGE', description: 'Browse boxes, search your collection and manage Pokémon.', number: '03' },
    bag: { title: 'BAG & ITEMS', description: 'Browse pockets, search items and edit quantities.', number: '04' },
    gifts: { title: 'MYSTERY GIFTS', description: 'Manage compatible Wonder Cards and event distributions.', number: '05' },
  }
  const boxedCount = snapshot?.boxed.length ?? 0
  const partyCount = snapshot?.party.length ?? 0
  const emptySlots = (activeBox?.slots ?? 0) - boxPokemon.length

  return (
    <main className="screen home-screen save-editor-screen">
      <div className="home-sky" aria-hidden="true"><div className="home-water"/><div className="home-grass"/></div>
      <div className="screen-shell editor-shell">
        <AppHeader onHome={onHome} right={<button className="text-action" onClick={onSettings}>SETTINGS</button>} />

        <div className="editor-page-heading">
          <div className="editor-heading-copy">
            <div className="editor-kicker"><span className="editor-kicker-dot"/> POKÉRUN UTILITIES / LOCAL TOOLS</div>
            <h1>SAVE EDITOR<span className="editor-heading-accent" aria-hidden="true">_</span></h1>
            <p>A safer way to work with your Pokémon saves. Everything stays in this browser.</p>
          </div>
          <PixelButton tone="ghost" onClick={onHome}>BACK TO HOME</PixelButton>
        </div>

        <section className="editor-command-bar pixel-border" aria-label="Save file controls">
          <div className="editor-cartridge" aria-hidden="true">
            <div className="editor-cartridge-groove"/>
            <div className="editor-cartridge-label">PRK<br/>SAVE</div>
            <div className="editor-cartridge-notch"/>
          </div>
          <div className="editor-save-identity">
            <span className="editor-overline">{snapshot ? 'CARTRIDGE CONNECTED' : 'NO CARTRIDGE INSERTED'}</span>
            <strong>{snapshot ? snapshot.save.version.toUpperCase() : 'IMPORT A SAVE'}</strong>
            <span className="editor-filename" title={originalFile?.name ?? undefined}>
              {snapshot ? 'GEN ' + snapshot.save.generation + ' • ' + originalFile?.name : 'Supports Pokémon battery saves from Generations I–V'}
            </span>
            {snapshot && <div className="editor-small-metrics">
              <span>PARTY <b>{partyCount}/6</b></span>
              <span>PC <b>{boxedCount}</b></span>
            </div>}
          </div>

          <div className="editor-main-actions">
            <input ref={fileInput} className="save-editor-file-input" aria-label="Choose save file"
              type="file" accept=".sav,.srm,.dsv,.dat,.bin" disabled={busy}
              onChange={event => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                void load(file)
              }}/>
            <PixelButton tone="ghost" disabled={busy} onClick={() => fileInput.current?.click()}>
              {busy ? 'LOADING...' : 'IMPORT SAVE'}
            </PixelButton>
            {originalBytes && <PixelButton tone="ghost" disabled={!originalBytes || busy}
              onClick={() => originalBytes && originalFile && download(originalBytes, backupName(originalFile.name))}>
              DOWNLOAD BACKUP
            </PixelButton>}
            {snapshot && <PixelButton tone="ghost" disabled={!originalFile || !dirty || busy} onClick={() => {
              if (originalFile && window.confirm('Discard all changes since this save was imported?')) {
                void load(originalFile, false)
              }
            }}>DISCARD EDITS</PixelButton>}
            <PixelButton className="editor-export-button" disabled={!snapshot || !dirty || busy}
              onClick={() => void exportEdited()}>
              EXPORT EDITED SAVE
            </PixelButton>
          </div>
        </section>

        {snapshot && <div className={'save-editor-edit-status ' + (dirty ? 'editor-status-dirty' : 'editor-status-clean')} role="status">
          <span className="editor-status-led" aria-hidden="true"/>
          <strong>{dirty ? 'UNEXPORTED CHANGES' : 'NO UNEXPORTED CHANGES'}</strong>
          <span>{dirty ? 'Edits are in memory only. Export to keep them.' : 'Your original file is untouched. Ready to edit.'}</span>
        </div>}
        {error && <p className="save-editor-error editor-message pixel-border" role="alert">{error}</p>}
        {message && <p className="save-editor-success editor-message pixel-border" role="status">{message}</p>}

        {!snapshot ? (
          <section
            className={'editor-import-hero pixel-border ' + (dragging ? 'dragging' : '')}
            onDragOver={event => { event.preventDefault(); setDragging(true) }}
            onDragLeave={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false)
            }}
            onDrop={event => {
              event.preventDefault()
              setDragging(false)
              void load(event.dataTransfer.files[0])
            }}
            aria-label="Import Pokémon battery save"
          >
            <div className="editor-import-symbol" aria-hidden="true"><span>+</span></div>
            <div className="editor-import-copy">
              <span className="editor-overline">STEP 01 / LOAD YOUR DATA</span>
              <h2>{busy ? 'READING SAVE...' : originalFile ? 'FORMAT NOT VERIFIED' : 'READY WHEN YOU ARE'}</h2>
              <p>Drop a Pokémon battery save here, or choose a file to start. PokéRun detects the game automatically and only enables edits for recognized formats.</p>
              <PixelButton disabled={busy} onClick={() => fileInput.current?.click()}>CHOOSE A SAVE FILE</PixelButton>
              <span className="editor-import-hint">.SAV / .SRM / .DSV / .DAT • MAX 8 MiB</span>
            </div>
            <div className="editor-import-steps" aria-label="How save editing works">
              <div><span>01</span><strong>IMPORT</strong><small>Choose your save</small></div>
              <div><span>02</span><strong>CUSTOMIZE</strong><small>Edit what you need</small></div>
              <div><span>03</span><strong>EXPORT</strong><small>Download a safe copy</small></div>
            </div>
          </section>
        ) : (
          <div className="editor-workbench">
            <nav className="editor-side-nav pixel-border" aria-label="Save editor sections">
              <div className="editor-rail-label">WORKSPACE</div>
              {tabs.map(option => (
                <button key={option} type="button"
                  className={'editor-nav-link ' + (tab === option ? 'selected' : '')}
                  aria-current={tab === option ? 'page' : undefined}
                  onClick={() => { setTab(option); setSelected(null); setMessage('') }}>
                  <span className="editor-nav-index">{sectionTitles[option].number}</span>
                  <span>{option === 'boxes' ? 'PC BOXES' : option === 'gifts' ? 'GIFTS' : option.toUpperCase()}</span>
                  <span className="editor-nav-arrow" aria-hidden="true">›</span>
                </button>
              ))}
              <div className="editor-rail-bottom">
                <span>SESSION</span>
                <strong>LOCAL / OFFLINE</strong>
                <small>Changes are not written into a running game.</small>
              </div>
            </nav>
            <div className="editor-stage">
              <div className="editor-stage-heading">
                <div>
                  <span className="editor-overline">WORKSPACE / {sectionTitles[tab].number}</span>
                  <h2>{sectionTitles[tab].title}</h2>
                  <p>{sectionTitles[tab].description}</p>
                </div>
                {tab === 'party' && <span className="editor-count-chip">{partyCount} / 6 SLOTS</span>}
                {tab === 'boxes' && <span className="editor-count-chip">{boxedCount} STORED</span>}
              </div>

              {tab === 'trainer' && (
                <div className="editor-stack">
                  <section className="save-editor-panel pixel-border editor-profile-panel">
                    <div className="editor-section-heading">
                      <div><span className="eyebrow">IDENTITY / CURRENCY</span><h3>PLAYER DETAILS</h3></div>
                      <span className="editor-info-chip">TRAINER ID {snapshot.trainer.id}</span>
                    </div>
                    <div className="save-editor-record"><span>GAME</span><strong>{snapshot.save.version}</strong></div>
                    <div className="save-editor-fields">
                      <label className="save-editor-field" htmlFor="trainer-name">
                        <strong>TRAINER NAME</strong>
                        <input id="trainer-name" value={trainerName} maxLength={snapshot.trainer.maxNameLength}
                          disabled={busy} onChange={event => setTrainerName(event.target.value)}/>
                      </label>
                      {snapshot.trainer.money !== null && (
                        <label className="save-editor-field" htmlFor="trainer-money">
                          <strong>MONEY</strong>
                          <input id="trainer-money" type="number" min="0" max="999999" step="1" value={money}
                            disabled={busy} onChange={event => setMoney(event.target.value)}/>
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
                          <input id="trainer-bp" type="number" min="0" max="65535" step="1" value={battlePoints}
                            disabled={busy} onChange={event => setBattlePoints(event.target.value)}/>
                        </label>
                        <PixelButton disabled={busy || battlePoints === String(snapshot.trainer.battlePoints)}
                          onClick={() => void applyBattlePoints()}>APPLY BATTLE POINTS</PixelButton>
                      </div>
                    )}
                  </section>
                  <TrainerProgressPanel onChanged={() => {
                    setDirty(true)
                    setMessage('Badges updated in memory. Export to keep your changes.')
                  }}/>
                </div>
              )}

              {tab === 'party' && (
                <div className="editor-pokemon-layout">
                  <section className="save-editor-panel pixel-border editor-pokemon-browser">
                    <div className="editor-section-heading">
                      <div><span className="eyebrow">01 – 06</span><h3>PARTY SLOTS</h3></div>
                      <span className="editor-info-chip">{partyCount} POKÉMON</span>
                    </div>
                    <div className="save-editor-pokemon-grid editor-party-grid">
                      {Array.from({ length: 6 }, (_, index) => {
                        const pokemon = snapshot.party[index]
                        return pokemon ? (
                          <button type="button" key={JSON.stringify(pokemon.at)}
                            className={'save-editor-pokemon editor-party-card ' +
                              (selected?.at.slot === pokemon.at.slot && selected?.at.source === 'party' ? 'active' : '')}
                            onClick={() => selectPokemon(pokemon)}>
                            <span className="editor-pokemon-slot">0{index + 1}</span>
                            <span className="editor-pokemon-avatar" aria-hidden="true">#{pokemon.speciesId ?? '??'}</span>
                            <span className="editor-pokemon-copy">
                              <strong>{pokemon.nickname}</strong>
                              <small>{pokemon.species}{pokemon.isShiny ? ' ✦' : ''}</small>
                              <span>LV {pokemon.level}</span>
                            </span>
                            <span className="editor-card-arrow" aria-hidden="true">›</span>
                          </button>
                        ) : (
                          <div key={index} className="editor-party-empty" aria-label={'Empty party slot ' + (index + 1)}>
                            <span>0{index + 1}</span><strong>EMPTY SLOT</strong>
                          </div>
                        )
                      })}
                    </div>
                    <p className="editor-pane-help">Select a Pokémon to edit its identity, moves, stats and encounter details.</p>
                  </section>
                  <div className="editor-detail-column">
                    {selected && selected.at.source === 'party' ? (
                      <PokemonDetailPanel key={JSON.stringify(selected.at)} pokemon={selected}
                        generation={snapshot.save.generation}
                        onSaved={next => {
                          setSnapshot(next)
                          setSelected(null)
                          setDirty(true)
                          setMessage('Pokémon updated in memory. Export to keep the changes.')
                        }}
                        onClose={() => setSelected(null)}/>
                    ) : (
                      <div className="editor-selection-empty pixel-border">
                        <div className="editor-selection-icon" aria-hidden="true">?</div>
                        <strong>SELECT A POKÉMON</strong>
                        <p>Your editor will appear here. Choose any occupied party slot to begin.</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {tab === 'boxes' && (
                <div className="editor-stack">
                  <div className="editor-pokemon-layout">
                    <section className="save-editor-panel pixel-border editor-pokemon-browser">
                      <div className="editor-section-heading">
                        <div><span className="eyebrow">PC STORAGE SYSTEM</span><h3>{activeBox?.name || 'BOX ' + (boxIndex + 1)}</h3></div>
                        <span className="editor-info-chip">{boxPokemon.length} / {activeBox?.slots ?? 0}</span>
                      </div>
                      <div className="editor-box-toolbar">
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
                        <label className="save-editor-field save-editor-pc-search">SEARCH ALL BOXES
                          <input type="search" value={pcSearch}
                            placeholder="Search species or nickname across every PC box..."
                            onChange={event => setPcSearch(event.target.value)}/>
                        </label>
                      </div>
                      {pcSearch.trim() && <div className="save-editor-pc-results">
                        <strong>{pcMatches.length} matching Pokémon{pcMatches.length === 75 ? ' (first 75)' : ''}</strong>
                        <div>{pcMatches.map(pokemon => (
                          <button type="button" key={JSON.stringify(pokemon.at)}
                            onClick={() => { setBoxIndex(pokemon.at.box ?? 0); setSelected(pokemon) }}>
                            {pokemon.species} / {pokemon.nickname} · BOX {(pokemon.at.box ?? 0) + 1}, SLOT {pokemon.at.slot + 1}
                          </button>
                        ))}</div>
                      </div>}
                      <div className="editor-pc-grid" aria-label="PC box slots">
                        {Array.from({ length: activeBox?.slots ?? 0 }, (_, index) => {
                          const pokemon = boxPokemon.find(p => p.at.slot === index)
                          return pokemon ? (
                            <button type="button" key={index}
                              className={'editor-pc-slot ' +
                                (selected?.at.source === 'box' && selected?.at.box === boxIndex && selected.at.slot === index ? 'active' : '')}
                              onClick={() => selectPokemon(pokemon)} title={pokemon.species + ' · Lv ' + pokemon.level}>
                              <span className="editor-slot-number">{index + 1}</span>
                              <span className="editor-slot-mon">#{pokemon.speciesId ?? '?'}</span>
                              <strong>{pokemon.nickname}</strong>
                              <small>LV {pokemon.level}</small>
                            </button>
                          ) : (
                            <div key={index} className="editor-pc-slot empty" aria-label={'Empty slot ' + (index + 1)}>
                              <span className="editor-slot-number">{index + 1}</span><span>·</span>
                            </div>
                          )
                        })}
                      </div>
                      <p className="editor-pane-help">{emptySlots} empty slots in this box. Pokémon files and encounters are added to the first available PC slot.</p>
                    </section>
                    <div className="editor-detail-column">
                      {selected && selected.at.source === 'box' ? (
                        <PokemonDetailPanel key={JSON.stringify(selected.at)} pokemon={selected}
                          generation={snapshot.save.generation}
                          onSaved={next => {
                            setSnapshot(next)
                            setSelected(null)
                            setDirty(true)
                            setMessage('Pokémon updated in memory. Export to keep the changes.')
                          }}
                          onClose={() => setSelected(null)}/>
                      ) : (
                        <div className="editor-selection-empty pixel-border">
                          <div className="editor-selection-icon" aria-hidden="true">?</div>
                          <strong>PC INSPECTOR</strong>
                          <p>Select a Pokémon in the grid to see its details and edit its data.</p>
                        </div>
                      )}
                    </div>
                  </div>
                  <BoxToolsPanel selected={selected} onSaved={(nextSnapshot, boxNumber) => {
                    setSnapshot(nextSnapshot)
                    if (boxNumber !== undefined) setBoxIndex(boxNumber)
                    setSelected(null)
                    setDirty(true)
                    setMessage('PC storage updated in memory. Export to keep the changes.')
                  }}/>
                </div>
              )}

              {tab === 'bag' && <BagEditor onChanged={() => {
                setDirty(true)
                setError('')
                setMessage('Inventory updated in memory. Export to keep the changes.')
              }}/>}

              {tab === 'gifts' && snapshot.save.hasMysteryGift && <MysteryGiftPanel onChanged={() => {
                setDirty(true)
                setMessage('Mystery Gift album updated in memory. Export to keep the changes.')
              }}/>}
            </div>
          </div>
        )}

        <div className="editor-footer">
          <span>POKÉRUN / SAVE WORKBENCH</span>
          <span>ALL CHANGES ARE LOCAL • EXPORT TO SAVE</span>
          <span>Powered by PKHeX.Everywhere (GPL-3.0-or-later)</span>
        </div>
      </div>
    </main>
  )
}
