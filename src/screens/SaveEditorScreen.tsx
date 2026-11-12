import { useRef, useState } from 'react'
import { AppHeader } from '../components/AppHeader'
import { PixelButton } from '../components/PixelButton'
import { changeEmeraldMoney, readEmeraldSave, type EmeraldSaveInfo } from '../core/save-editor/emeraldSave'
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

export function SaveEditorScreen({ onHome, onSettings }: Props) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [original, setOriginal] = useState<Uint8Array | null>(null)
  const [originalName, setOriginalName] = useState('')
  const [info, setInfo] = useState<EmeraldSaveInfo | null>(null)
  const [money, setMoney] = useState('')
  const [error, setError] = useState('')
  const [exportMessage, setExportMessage] = useState('')

  async function loadSave(file: File | undefined) {
    if (!file) return
    setOriginal(null)
    setInfo(null)
    setError('')
    setExportMessage('')
    try {
      if (!file.name.toLowerCase().endsWith('.sav')) {
        throw new Error('Choose an Emerald .sav battery-save file.')
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      const parsed = readEmeraldSave(bytes)
      setOriginal(bytes)
      setOriginalName(file.name)
      setInfo(parsed)
      setMoney(String(parsed.money))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read this save file.')
    }
  }

  function exportEdited() {
    if (!original || !info) return
    try {
      const amount = Number(money)
      if (money.trim() === '') throw new Error('Enter a money amount before exporting.')
      const edited = changeEmeraldMoney(original, amount)
      const editedName = originalName.replace(/\.sav$/i, '') + '-edited.sav'
      downloadSave(edited, editedName)
      setError('')
      setExportMessage('Edited copy exported. Your original save has not been changed.')
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
            <p>Make changes to a local save file without changing your PokéRun runs.</p>
          </div>
          <PixelButton tone="ghost" onClick={onHome}>BACK TO HOME</PixelButton>
        </section>

        <div className="save-editor-layout">
          <section className="save-editor-panel pixel-border">
            <span className="eyebrow">01 / LOAD SAVE</span>
            <h2>POKÉMON EMERALD</h2>
            <p>Start with a 128 KiB Emerald battery save (.sav). Other games and Pokémon editing will come later.</p>
            <input
              ref={fileInput}
              className="save-editor-file-input"
              aria-label="Choose save file"
              type="file"
              accept=".sav"
              onChange={event => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                void loadSave(file)
              }}
            />
            <PixelButton onClick={() => fileInput.current?.click()}>
              {original ? 'CHOOSE ANOTHER SAVE' : 'CHOOSE .SAV FILE'}
            </PixelButton>
            <div className="save-editor-note">
              Files are read locally in your browser. This editor does not overwrite the selected file, your current run, or stored multiplayer saves.
            </div>
          </section>

          <section className="save-editor-panel pixel-border">
            <span className="eyebrow">02 / EDIT & EXPORT</span>
            {original && info ? (
              <>
                <div className="save-editor-record">
                  <span>FILE</span>
                  <strong title={originalName}>{originalName}</strong>
                </div>
                <div className="save-editor-record">
                  <span>PLAY TIME</span>
                  <strong>{String(info.playTimeHours).padStart(2, '0')}:{String(info.playTimeMinutes).padStart(2, '0')}</strong>
                </div>
                <div className="save-editor-record">
                  <span>PARTY</span>
                  <strong>{info.partyCount} / 6</strong>
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
                <div className="save-editor-actions">
                  <PixelButton tone="ghost" onClick={() => downloadSave(original, originalName.replace(/\.sav$/i, '') + '-backup.sav')}>DOWNLOAD BACKUP</PixelButton>
                  <PixelButton onClick={exportEdited} disabled={money.trim() === String(info.money)}>EXPORT EDITED SAVE</PixelButton>
                </div>
              </>
            ) : (
              <div className="save-editor-placeholder">
                <strong>NO SAVE LOADED</strong>
                <p>Choose an Emerald save to inspect it and change your money.</p>
              </div>
            )}
            {error && <p className="save-editor-error" role="alert">{error}</p>}
            {exportMessage && <p className="save-editor-success" role="status">{exportMessage}</p>}
          </section>
        </div>

        <p className="save-editor-footnote">
          This first version edits only the money field of a validated Emerald save. Keep a backup before importing any edited save into an emulator. Exported files must be imported into the game separately.
        </p>
      </div>
    </main>
  )
}
