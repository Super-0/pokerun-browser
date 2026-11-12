import { useEffect, useRef, useState } from 'react'
import type { EncounterRow, FilePreview, PokemonSummary, SpeciesEntry } from '@pkhex-everywhere/engine'
import { PixelButton } from '../../components/PixelButton'
import {
  addEncounterToBox, addPokemonFileToBox, clonePokemonIntoBox,
  exportSinglePokemon, findBoxEncounters, getEncounterCatalog,
  inspectPokemonFile, type EditorSnapshot,
} from '../../core/save-editor/pkhexEditor'

interface Props {
  selected: PokemonSummary | null
  onSaved: (snapshot: EditorSnapshot, boxNumber?: number) => void
}

function download(bytes: Uint8Array, name: string) {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** All operations are isolated to the engine's in-memory save. */
export function BoxToolsPanel({ selected, onSaved }: Props) {
  const upload = useRef<HTMLInputElement>(null)
  const [species, setSpecies] = useState<SpeciesEntry[]>([])
  const [versions, setVersions] = useState<Array<{ id: number, name: string }>>([])
  const [gameVersion, setGameVersion] = useState<number | null>(null)
  const [speciesId, setSpeciesId] = useState<number | null>(null)
  const [speciesFilter, setSpeciesFilter] = useState('')
  const [encounters, setEncounters] = useState<EncounterRow[]>([])
  const [catalogReady, setCatalogReady] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [previewBytes, setPreviewBytes] = useState<Uint8Array | null>(null)
  const [previewName, setPreviewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    let active = true
    void getEncounterCatalog().then(result => {
      if (!active) return
      setSpecies(result.species)
      setVersions(result.versions.versions)
      setGameVersion(result.versions.default)
      setCatalogReady(true)
    }).catch(reason => {
      if (!active) return
      setCatalogError(reason instanceof Error ? reason.message : 'Encounter data not available.')
      setCatalogReady(true)
    })
    return () => { active = false }
  }, [])

  function resetMessage() {
    setError('')
    setMessage('')
  }

  async function cloneSelected() {
    if (!selected || busy) return
    if (!window.confirm('Copy this Pokémon into the next empty PC-box slot? Your original stays in place.')) return
    setBusy(true)
    resetMessage()
    try {
      const result = await clonePokemonIntoBox(selected.at)
      onSaved(result.snapshot, result.added.at.box ?? undefined)
      setMessage('A copy was added to the PC. Export the edited save to keep it.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not clone this Pokémon.')
    } finally {
      setBusy(false)
    }
  }

  async function exportSelected() {
    if (!selected || busy) return
    setBusy(true)
    resetMessage()
    try {
      const result = await exportSinglePokemon(selected.at)
      if (!result.bytes.length) throw new Error('Pokémon export was empty.')
      download(result.bytes, result.fileName)
      setMessage('Pokémon file downloaded. This did not alter the save.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not export Pokémon.')
    } finally {
      setBusy(false)
    }
  }

  async function findEncounters() {
    if (gameVersion === null || speciesId === null || busy) return
    setBusy(true)
    resetMessage()
    setEncounters([])
    try {
      setEncounters(await findBoxEncounters(gameVersion, speciesId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Encounter search failed.')
    } finally {
      setBusy(false)
    }
  }

  async function addEncounter(row: EncounterRow) {
    if (busy) return
    if (!window.confirm('Add ' + row.species + ' (' + row.name + ') to the next empty box slot?')) return
    setBusy(true)
    resetMessage()
    try {
      const result = await addEncounterToBox(row.index)
      onSaved(result.snapshot, result.added.at.box ?? undefined)
      setMessage('Encounter added to a PC box. Export the edited save to keep it.')
      setEncounters([])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not add the selected encounter.')
    } finally {
      setBusy(false)
    }
  }

  async function inspectFile(file?: File) {
    if (!file || busy) return
    setBusy(true)
    resetMessage()
    setPreview(null)
    setPreviewBytes(null)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const result = await inspectPokemonFile(bytes)
      setPreviewBytes(bytes)
      setPreview(result)
      setPreviewName(file.name)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'This Pokémon file could not be inspected.')
    } finally {
      setBusy(false)
    }
  }

  async function importPokemon() {
    if (!preview || !previewBytes || busy) return
    const message = preview.unofficial
      ? 'This conversion is unofficial and may change Pokémon data. Add it to the PC anyway?'
      : 'Add this Pokémon file to the next empty PC slot?'
    if (!window.confirm(message)) return
    setBusy(true)
    resetMessage()
    try {
      const result = await addPokemonFileToBox(previewBytes, preview.unofficial)
      onSaved(result.snapshot, result.added.at.box ?? undefined)
      setMessage('Imported Pokémon added. Export the edited save to keep it.')
      setPreview(null)
      setPreviewBytes(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not import this Pokémon.')
    } finally {
      setBusy(false)
    }
  }

  const matches = speciesFilter.trim().toLowerCase()
  const candidates = matches ? species.filter(s =>
    s.name.toLowerCase().includes(matches) || String(s.id) === matches,
  ).slice(0, 100) : []

  return (
    <section className="save-editor-panel save-editor-box-tools pixel-border">
      <span className="eyebrow">PC BOX TOOLS</span>
      <h2>POKÉMON STORAGE</h2>
      <p className="save-editor-help">Add or export Pokémon files, or create copies of existing Pokémon. New Pokémon go into the first empty box slot.</p>

      <div className="save-editor-tool-row">
        <div className="save-editor-tool-card">
          <h3>SELECTED POKÉMON</h3>
          <p>{selected ? selected.nickname + ' / ' + selected.species + ' · Lv ' + selected.level : 'Choose a Pokémon from the box grid above.'}</p>
          <div className="save-editor-actions">
            <PixelButton disabled={!selected || !selected.editable || busy} onClick={() => void cloneSelected()}>
              CLONE TO PC
            </PixelButton>
            <PixelButton tone="ghost" disabled={!selected || busy} onClick={() => void exportSelected()}>
              EXPORT .PK FILE
            </PixelButton>
          </div>
        </div>

        <div className="save-editor-tool-card">
          <h3>IMPORT POKÉMON FILE</h3>
          <p>Import a .pk1–.pk5 Pokémon file. Conversions are previewed before insertion.</p>
          <input ref={upload} type="file" aria-label="Choose Pokémon file" accept=".pk1,.pk2,.pk3,.pk4,.pk5,.ek3,.ek4,.ek5,.pkm,.bin"
            className="save-editor-file-input" onChange={event => {
              const file = event.target.files?.[0]
              event.target.value = ''
              void inspectFile(file)
            }}/>
          <PixelButton tone="ghost" disabled={busy} onClick={() => upload.current?.click()}>
            CHOOSE POKÉMON FILE
          </PixelButton>
          {preview && (
            <div className="save-editor-file-preview">
              <strong>{preview.pokemon.species} · Lv {preview.pokemon.level}</strong>
              <p>{previewName}</p>
              <p>{preview.changes.length} conversion change(s)
                {preview.unofficial ? ' · UNOFFICIAL TRANSFER' : ''}</p>
              {preview.legality && <p>{preview.legality.valid ? 'PKHeX legality check passed' : 'PKHeX legality check flagged issues'}</p>}
              <PixelButton disabled={busy} onClick={() => void importPokemon()}>ADD TO BOX</PixelButton>
            </div>
          )}
        </div>
      </div>

      <div className="save-editor-tool-card save-editor-encounter-builder">
        <h3>CREATE FROM AN ENCOUNTER</h3>
        <p>Find a game-specific encounter instead of creating an arbitrary, uninitialized Pokémon.</p>
        {!catalogReady && <p>LOADING ENCOUNTER CATALOG...</p>}
        {catalogError && <p className="save-editor-help">{catalogError}</p>}
        {catalogReady && versions.length > 0 && (
          <>
            <div className="save-editor-fields">
              <label className="save-editor-field">ORIGIN GAME
                <select value={gameVersion ?? ''} disabled={busy} onChange={event => {
                  setGameVersion(Number(event.target.value))
                  setEncounters([])
                }}>
                  {versions.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </label>
              <label className="save-editor-field">FIND SPECIES
                <input value={speciesFilter} disabled={busy}
                  placeholder="Pikachu, #25..." onChange={event => {
                    setSpeciesFilter(event.target.value)
                    setSpeciesId(null)
                    setEncounters([])
                  }}/>
              </label>
            </div>
            {speciesFilter.trim() && (
              <div className="save-editor-species-results">
                {candidates.map(candidate => (
                  <button key={candidate.id} type="button" disabled={busy}
                    className={speciesId === candidate.id ? 'selected' : ''}
                    onClick={() => { setSpeciesId(candidate.id); setEncounters([]) }}>
                    {candidate.name} <small>#{candidate.id}</small>
                  </button>
                ))}
                {!candidates.length && <p>No matching species.</p>}
              </div>
            )}
            <PixelButton disabled={busy || speciesId === null || gameVersion === null}
              onClick={() => void findEncounters()}>FIND ENCOUNTERS</PixelButton>
            {encounters.length > 0 && (
              <div className="save-editor-encounter-results">
                {encounters.slice(0, 80).map(row => (
                  <div key={row.index} className="save-editor-encounter">
                    <div><strong>{row.species} · {row.levelRange}</strong>
                      <span>{row.name} · {row.location} · {row.version}</span></div>
                    <PixelButton disabled={busy} onClick={() => void addEncounter(row)}>ADD TO PC</PixelButton>
                  </div>
                ))}
                {encounters.length > 80 && <p>Showing the first 80 matches. Narrow the search to see other encounters.</p>}
              </div>
            )}
            {speciesId !== null && !encounters.length && !busy && (
              <p className="save-editor-help">Choose an origin game and search for available encounters.</p>
            )}
          </>
        )}
      </div>
      {error && <p role="alert" className="save-editor-error">{error}</p>}
      {message && <p role="status" className="save-editor-success">{message}</p>}
    </section>
  )
}
