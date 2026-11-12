import { useEffect, useRef, useState } from 'react'
import type { GiftAlbum, GiftEvent, WonderCardPreview } from '@pkhex-everywhere/engine'
import { PixelButton } from '../../components/PixelButton'
import {
  insertGiftFile, insertKnownGift, listKnownGifts, previewGiftFile,
  previewKnownGift, readGiftAlbum, removeGift, unlockMysteryGift,
} from '../../core/save-editor/pkhexEditor'

interface Props {
  onChanged: () => void
}

export function MysteryGiftPanel({ onChanged }: Props) {
  const upload = useRef<HTMLInputElement>(null)
  const [album, setAlbum] = useState<GiftAlbum | null>(null)
  const [events, setEvents] = useState<GiftEvent[] | null>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<GiftEvent | null>(null)
  const [preview, setPreview] = useState<WonderCardPreview | null>(null)
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null)
  const [fileName, setFileName] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    let live = true
    void readGiftAlbum().then(result => {
      if (!live) return
      setAlbum(result)
      setLoading(false)
    }).catch(reason => {
      if (!live) return
      setError(reason instanceof Error ? reason.message : 'Mystery Gift album unavailable.')
      setLoading(false)
    })
    return () => { live = false }
  }, [])

  async function browseEvents() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      setEvents(await listKnownGifts())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not read known event cards.')
    } finally {
      setBusy(false)
    }
  }

  async function chooseEvent(event: GiftEvent) {
    if (busy) return
    setBusy(true)
    setError('')
    setMessage('')
    setSelected(event)
    setFileBytes(null)
    setPreview(null)
    try {
      setPreview(await previewKnownGift(event.id))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'This event card could not be previewed.')
    } finally {
      setBusy(false)
    }
  }

  async function chooseFile(file?: File) {
    if (!file || busy) return
    setBusy(true)
    setError('')
    setMessage('')
    setSelected(null)
    setPreview(null)
    setFileBytes(null)
    setFileName('')
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      setPreview(await previewGiftFile(bytes))
      setFileBytes(bytes)
      setFileName(file.name)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The Wonder Card file is not supported.')
    } finally {
      setBusy(false)
    }
  }

  const emptySlot = album?.slots.find(slot => !slot.card)?.index
  const filtered = events?.filter(event => {
    const query = filter.toLowerCase().trim()
    return !query || [event.title, event.species?.name, event.item?.name, event.language, String(event.cardId)]
      .some(value => value?.toLowerCase().includes(query))
  }) ?? []

  async function addSelected() {
    if (!album || !preview || emptySlot === undefined || busy) return
    const source = selected ? 'the known event "' + selected.title + '"' : 'the file "' + fileName + '"'
    if (!window.confirm('Insert ' + source + ' into the save? This marks the card as received and may affect in-game gift delivery.')) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const next = selected
        ? await insertKnownGift(selected.id, emptySlot)
        : await insertGiftFile(fileBytes!, emptySlot)
      setAlbum(next)
      setPreview(null)
      setFileBytes(null)
      setSelected(null)
      onChanged()
      setMessage('Wonder Card inserted in memory. Export the edited save to keep it.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not insert this Wonder Card.')
    } finally {
      setBusy(false)
    }
  }

  async function deleteCard(slot: number, title: string) {
    if (busy || !window.confirm('Remove "' + title + '" from the album? The received-card history may remain set.')) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      setAlbum(await removeGift(slot))
      onChanged()
      setMessage('Wonder Card removed in memory. Export to keep the change.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not remove the card.')
    } finally {
      setBusy(false)
    }
  }

  async function changeUnlocked(value: boolean) {
    if (busy || !window.confirm(value ? 'Unlock Mystery Gift in the game menu?' : 'Hide Mystery Gift in the game menu?')) return
    setBusy(true)
    setError('')
    try {
      setAlbum(await unlockMysteryGift(value))
      onChanged()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update Mystery Gift visibility.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="save-editor-panel pixel-border save-editor-gifts">
      <span className="eyebrow">GENERATION IV–V</span>
      <h2>MYSTERY GIFT / WONDER CARDS</h2>
      <p className="save-editor-help">Edit the Wonder Card album in the save, not the party or bag. Gifts normally have to be claimed from the in-game delivery person.</p>
      {loading && <p>READING MYSTERY GIFT ALBUM...</p>}
      {album && (
        <>
          <div className="save-editor-gift-meta">
            <span>{album.slots.filter(slot => slot.card).length} / {album.slots.length} CARDS</span>
            {album.unlocked !== null && (
              <label className="save-editor-check">
                <input type="checkbox" checked={album.unlocked} disabled={busy}
                  onChange={event => void changeUnlocked(event.target.checked)}/>
                <span>MYSTERY GIFT UNLOCKED</span>
              </label>
            )}
          </div>
          <div className="save-editor-gift-slots">
            {album.slots.map(slot => (
              <div key={slot.index} className="save-editor-gift-slot">
                <small>SLOT {slot.index + 1}</small>
                {slot.card ? (
                  <>
                    <strong>{slot.card.title}</strong>
                    <span>{slot.card.kind.toUpperCase()}{slot.card.language ? ' · ' + slot.card.language : ''}</span>
                    <PixelButton tone="ghost" disabled={busy} onClick={() => void deleteCard(slot.index, slot.card!.title)}>
                      REMOVE CARD
                    </PixelButton>
                  </>
                ) : <span>EMPTY</span>}
              </div>
            ))}
          </div>
          <div className="save-editor-tool-row">
            <div className="save-editor-tool-card">
              <h3>KNOWN DISTRIBUTIONS</h3>
              <p>Browse known event cards compatible with this save's generation.</p>
              {!events && <PixelButton tone="ghost" disabled={busy} onClick={() => void browseEvents()}>
                LOAD EVENT CATALOG
              </PixelButton>}
              {events && (
                <>
                  <label className="save-editor-field">SEARCH EVENTS
                    <input type="search" value={filter} placeholder="Victini, Liberty Pass, language..."
                      onChange={event => setFilter(event.target.value)}/>
                  </label>
                  <div className="save-editor-gift-results">
                    {filtered.slice(0, 75).map(event => (
                      <button key={event.id} type="button" disabled={busy}
                        className={selected?.id === event.id ? 'selected' : ''}
                        onClick={() => void chooseEvent(event)}>
                        <strong>{event.title}</strong>
                        <small>{event.species?.name ?? event.item?.name ?? event.kind}
                          {event.language ? ' · ' + event.language : ''}{event.received ? ' · RECEIVED' : ''}</small>
                      </button>
                    ))}
                  </div>
                  {filtered.length > 75 && <p>Showing 75 of {filtered.length} cards. Search to narrow.</p>}
                </>
              )}
            </div>
            <div className="save-editor-tool-card">
              <h3>IMPORT WONDER CARD</h3>
              <p>Load a .pgt, .pcd or .wc4 for Gen IV, or a .pgf for Gen V.</p>
              <input ref={upload} type="file" aria-label="Choose Wonder Card file" accept=".pgt,.pcd,.wc4,.pgf"
                className="save-editor-file-input" onChange={event => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  void chooseFile(file)
                }}/>
              <PixelButton tone="ghost" disabled={busy} onClick={() => upload.current?.click()}>
                CHOOSE WONDER CARD FILE
              </PixelButton>
              {preview && (
                <div className="save-editor-file-preview">
                  <strong>{preview.title}</strong>
                  <p>{preview.pokemon?.species ?? preview.item?.name ?? preview.kind}</p>
                  <p>{preview.language ?? 'Unspecified language'} · #{preview.cardId}</p>
                  <PixelButton disabled={busy || emptySlot === undefined} onClick={() => void addSelected()}>
                    INSERT INTO ALBUM
                  </PixelButton>
                </div>
              )}
              {emptySlot === undefined && <p>The album is full. Remove a card before inserting another.</p>}
            </div>
          </div>
        </>
      )}
      {error && <p className="save-editor-error" role="alert">{error}</p>}
      {message && <p className="save-editor-success" role="status">{message}</p>}
    </section>
  )
}
