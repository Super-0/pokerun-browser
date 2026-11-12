import { useRef, useState } from 'react'
import { AppHeader } from '../components/AppHeader'
import { PixelButton } from '../components/PixelButton'
import { inspectSave, type SaveInspection } from '../core/save-editor/detectSave'
import { changeGen3Money } from '../core/save-editor/gen3Save'
import '../styles/save-editor.css'

interface Props {
  onHome: () => void
  onSettings: () => void
}

function downloadSave(bytes: Uint8Array, fileName: string) {
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

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, '')
}

export function SaveEditorScreen({ onHome, onSettings }: Props) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [original, setOriginal] = useState<Uint8Array | null>(null)
  const [originalName, setOriginalName] = useState('')
  const [inspection, setInspection] = useState<SaveInspection | null>(null)
  const [money, setMoney] = useState('')
  const [error, setError] = useState('')
  const [exportMessage, setExportMessage] = useState('')

  async function loadSave(file: File | undefined) {
    if (!file) return
    setOriginal(null)
    setInspection(null)
    setOriginalName('')
    setError('')
    setExportMessage('')
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const result = inspectSave(bytes)
      setOriginal(bytes)
      setOriginalName(file.name)
      setInspection(result)
      setMoney(result.mode === 'editable' ? String(result.info.money) : '')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read this file.')
    }
  }

  function exportEdited() {
    if (!original || inspection?.mode !== 'editable') return
    try {
      if (money.trim() === '') throw new Error('Enter a money amount before exporting.')
      const edited = changeGen3Money(original, Number(money))
      downloadSave(edited, baseName(originalName) + '-edited.sav')
      setError('')
      setExportMessage('Edited save exported. Your original file and PokéRun saves are unchanged.')
    } catch (cause) {
      setExportMessage('')
      setError(cause instanceof Error ? cause.message : 'Could not export this save.')
    }
  }

  return (
    <main className="screen home-screen">
      <div className="home-sky" aria-hidden="true"><div className="home-water"/><div className="home-grass"/></div>
      <div className="screen-shell">
        <AppHeader onHome={onHome} right={<button className="text-action" onClick={onSettings}>SETTINGS</button>} />

        <section className="page-title-row">
          <div>
            <h1>SAVE EDITOR</h1>
            <p>Upload a battery save. PokéRun checks the format and shows available editing tools.</p>
          </div>
          <PixelButton tone="ghost" onClick={onHome}>BACK TO HOME</PixelButton>
        </section>

        <div className="save-editor-layout">
          <section className="save-editor-panel pixel-border">
            <span className="eyebrow">01 / LOAD SAVE</span>
            <h2>AUTO-DETECT GAME</h2>
            <p>Choose a save file from your emulator. You don't have to select a Pokémon game first.</p>
            <input
              ref={fileInput}
              className="save-editor-file-input"
              aria-label="Choose save file"
              type="file"
              accept=".sav,.dsv,.srm,.dat,application/octet-stream"
              onChange={event => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                void loadSave(file)
              }}
            />
            <PixelButton onClick={() => fileInput.current?.click()}>
              {original ? 'CHOOSE ANOTHER SAVE' : 'CHOOSE SAVE FILE'}
            </PixelButton>
            <div className="save-editor-note">
              Supported editing: Generation III (Ruby/Sapphire, Emerald, FireRed/LeafGreen) money.
              Other formats can be inspected, but editing stays locked until their parsers are verified.
              Saves never leave your browser.
            </div>
          </section>

          <section className="save-editor-panel pixel-border">
            <span className="eyebrow">02 / DETECT & EDIT</span>
            {original && inspection ? (
              <>
                <div className="save-editor-record">
                  <span>FILE</span>
                  <strong title={originalName}>{originalName}</strong>
                </div>
                <div className="save-editor-record">
                  <span>DETECTED</span>
                  <strong>{inspection.label}</strong>
                </div>
                <p className="save-editor-detection">{inspection.detail}</p>
                {inspection.mode === 'editable' ? (
                  <>
                    <div className="save-editor-record">
                      <span>PLAY TIME</span>
                      <strong>{String(inspection.info.playTimeHours).padStart(2, '0')}:{String(inspection.info.playTimeMinutes).padStart(2, '0')}</strong>
                    </div>
                    <div className="save-editor-record">
                      <span>PARTY</span>
                      <strong>{inspection.info.partyCount} / 6</strong>
                    </div>
                    <label className="save-editor-field" htmlFor="save-editor-money">
                      <strong>MONEY</strong>
                      <input
                        id="save-editor-money"
                        type="number"
                        min="0"
                        max="999999"
                        step="1"
                        value={money}
                        onChange={event => {
                          setMoney(event.target.value)
                          setError('')
                          setExportMessage('')
                        }}
                      />
                      <small>0–999,999 Pokédollars</small>
                    </label>
                  </>
                ) : (
                  <div className="save-editor-unavailable">
                    <strong>EDITING NOT AVAILABLE</strong>
                    <p>This save won't be modified. PokéRun needs a verified game-specific parser before it can export safe edits.</p>
                  </div>
                )}
                <div className="save-editor-actions">
                  <PixelButton tone="ghost" onClick={() => downloadSave(original, baseName(originalName) + '-backup' + (originalName.match(/\.[^.]+$/)?.[0] ?? '.sav'))}>
                    DOWNLOAD BACKUP
                  </PixelButton>
                  {inspection.mode === 'editable' && (
                    <PixelButton onClick={exportEdited} disabled={money.trim() === String(inspection.info.money)}>
                      EXPORT EDITED SAVE
                    </PixelButton>
                  )}
                </div>
              </>
            ) : (
              <div className="save-editor-placeholder">
                <strong>NO SAVE LOADED</strong>
                <p>Choose a .sav, .dsv, .srm or .dat file to inspect its format.</p>
              </div>
            )}
            {error && <p className="save-editor-error" role="alert">{error}</p>}
            {exportMessage && <p className="save-editor-success" role="status">{exportMessage}</p>}
          </section>
        </div>

        <p className="save-editor-footnote">
          This editor works on exported copies, not live games. Keep a backup before importing edited data into an emulator.
          Some save formats look alike; ambiguous files remain read-only instead of guessing a game.
        </p>
      </div>
    </main>
  )
}
