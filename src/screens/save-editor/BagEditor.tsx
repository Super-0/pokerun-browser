import { useEffect, useState } from 'react'
import type { Pouch } from '@pkhex-everywhere/engine'
import { PixelButton } from '../../components/PixelButton'
import { readSaveBag, setSaveBagItem } from '../../core/save-editor/pkhexEditor'

interface Props {
  onChanged: () => void
}

export function BagEditor({ onChanged }: Props) {
  const [pouches, setPouches] = useState<Pouch[]>([])
  const [activePouch, setActivePouch] = useState('')
  const [item, setItem] = useState<number | null>(null)
  const [count, setCount] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [filter, setFilter] = useState('')
  const [view, setView] = useState<'owned' | 'catalog'>('owned')

  useEffect(() => {
    let active = true
    void readSaveBag().then(result => {
      if (!active) return
      setPouches(result)
      setActivePouch(result[0]?.name ?? '')
      setLoading(false)
    }).catch(reason => {
      if (!active) return
      setError(reason instanceof Error ? reason.message : 'Could not inspect the bag.')
      setLoading(false)
    })
    return () => { active = false }
  }, [])

  const pouch = pouches.find(p => p.name === activePouch)
  const owned = pouch?.items ?? []
  const available = (view === 'owned'
    ? owned.map(entry => ({ ...entry, owned: true }))
    : (pouch?.addable ?? []).map(entry => ({ ...entry, count: 0, owned: false, isUnknown: false }))
  ).filter(entry => entry.name.toLowerCase().includes(filter.toLowerCase()))
  const selected = available.find(entry => entry.id === item) ??
    [...owned, ...(pouch?.addable ?? [])].find(entry => entry.id === item)
  const currentCount = owned.find(entry => entry.id === item)?.count ?? 0

  function selectItem(id: number) {
    setItem(id)
    setCount(String(owned.find(entry => entry.id === id)?.count ?? 0))
    setError('')
    setMessage('')
  }

  async function apply() {
    if (!pouch || !selected || saving) return
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const raw = count.trim()
      const amount = Number(raw)
      if (!raw || !Number.isSafeInteger(amount) || amount < 0 || amount > selected.maxCount) {
        throw new Error('Quantity must be between 0 and ' + selected.maxCount + '.')
      }
      const next = await setSaveBagItem(pouch.name, selected.id, amount)
      setPouches(next)
      setMessage('Item quantity updated in the editor. Export your save to keep it.')
      onChanged()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not edit item.')
    } finally {
      setSaving(false)
    }
  }


  return (
    <section className="save-editor-panel pixel-border editor-bag-panel">
      <div className="editor-section-heading">
        <div><span className="eyebrow">BAG / ITEMS</span><h3>YOUR INVENTORY</h3></div>
        <span className="editor-info-chip">{pouches.reduce((sum, entry) => sum + entry.items.length, 0)} UNIQUE ITEMS</span>
      </div>
      {loading && <p>READING INVENTORY...</p>}
      {error && <p role="alert" className="save-editor-error">{error}</p>}
      {message && <p role="status" className="save-editor-success">{message}</p>}
      {!loading && pouches.length === 0 && <p>Inventory editing isn't available for this save format.</p>}

      {pouches.length > 0 && (
        <>
          <nav className="editor-pocket-tabs" aria-label="Bag pockets">
            {pouches.map(entry => (
              <button type="button" key={entry.name} aria-current={entry.name === activePouch ? 'page' : undefined}
                className={entry.name === activePouch ? 'selected' : ''}
                onClick={() => {
                  setActivePouch(entry.name)
                  setItem(null)
                  setFilter('')
                  setView('owned')
                  setError('')
                  setMessage('')
                }}>
                <strong>{entry.name.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase()}</strong>
                <small>{entry.items.length}</small>
              </button>
            ))}
          </nav>

          <div className="editor-bag-toolbar">
            <div className="editor-bag-view-switch" role="group" aria-label="Inventory view">
              <button type="button" className={view === 'owned' ? 'selected' : ''}
                onClick={() => { setView('owned'); setItem(null) }}>
                OWNED ITEMS ({owned.length})
              </button>
              <button type="button" className={view === 'catalog' ? 'selected' : ''}
                onClick={() => { setView('catalog'); setItem(null) }}>
                + ADD ITEMS
              </button>
            </div>
            <label className="save-editor-field">FIND ITEM
              <input type="search" value={filter} placeholder="Search this pouch..."
                onChange={event => setFilter(event.target.value)}/>
            </label>
          </div>

          <div className="save-editor-inventory-layout editor-bag-layout">
            <div className="editor-bag-list-column">
              <div className="editor-bag-list-caption">
                <span>{view === 'owned' ? 'IN YOUR BAG' : 'AVAILABLE TO ADD'}</span>
                <small>{available.length} MATCHES</small>
              </div>
              <div className="save-editor-inventory-list" aria-label="Bag items">
                {available.slice(0, 150).map(entry => (
                  <button key={entry.id} className={item === entry.id ? 'active' : ''} type="button"
                    onClick={() => selectItem(entry.id)}>
                    <span>{entry.name}{entry.isUnknown ? ' (unknown)' : ''}</span>
                    <small>{entry.owned ? '×' + entry.count : '+ ADD'}</small>
                  </button>
                ))}
                {available.length === 0 && (
                  <div className="editor-bag-empty">
                    <strong>{view === 'owned' ? 'THIS POCKET IS EMPTY' : 'NO MATCHES'}</strong>
                    <p>{view === 'owned'
                      ? 'Switch to + ADD ITEMS to browse what can be added.'
                      : 'Try another search or a different pocket.'}</p>
                  </div>
                )}
                {available.length > 150 && <p className="editor-bag-more">Showing 150 items. Search to narrow the list.</p>}
              </div>
            </div>

            <div className="save-editor-inventory-detail editor-bag-inspector">
              {selected ? (
                <>
                  <span className="eyebrow">{owned.some(entry => entry.id === selected.id) ? 'EDIT QUANTITY' : 'ADD TO BAG'}</span>
                  <h3>{selected.name}</h3>
                  <p>Current quantity <strong>{currentCount}</strong> • Max {selected.maxCount}</p>
                  <label className="save-editor-field">QUANTITY
                    <input type="number" min="0" max={selected.maxCount} value={count}
                      disabled={saving} onChange={event => setCount(event.target.value)}/>
                  </label>
                  <div className="editor-quantity-shortcuts">
                    <button type="button" disabled={saving} onClick={() => setCount(String(Math.max(0, (Number(count) || 0) - 1)))}>− 1</button>
                    <button type="button" disabled={saving} onClick={() => setCount(String(Math.min(selected.maxCount, (Number(count) || 0) + 1)))}>+ 1</button>
                    <button type="button" disabled={saving} onClick={() => setCount(String(selected.maxCount))}>MAX</button>
                  </div>
                  <PixelButton disabled={saving || count.trim() === String(currentCount)}
                    onClick={() => void apply()}>
                    {saving ? 'APPLYING...' : 'APPLY ITEM CHANGE'}
                  </PixelButton>
                  <p className="save-editor-help">Setting quantity to 0 removes the item. Nothing changes in the original file until you export your edited save.</p>
                </>
              ) : (
                <div className="editor-bag-inspector-empty">
                  <div className="editor-selection-icon" aria-hidden="true">?</div>
                  <strong>SELECT AN ITEM</strong>
                  <p>Pick an item on the left to change its quantity, or open Add Items to find something new.</p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  )
}
