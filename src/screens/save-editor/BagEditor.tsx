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
  const available = [
    ...owned.map(entry => ({ ...entry, owned: true })),
    ...(pouch?.addable ?? []).map(entry => ({ ...entry, count: 0, owned: false, isUnknown: false })),
  ].filter(entry => entry.name.toLowerCase().includes(filter.toLowerCase()))
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
    <section className="save-editor-panel pixel-border">
      <span className="eyebrow">BAG / ITEMS</span>
      {loading && <p>READING INVENTORY...</p>}
      {error && <p role="alert" className="save-editor-error">{error}</p>}
      {message && <p role="status" className="save-editor-success">{message}</p>}
      {!loading && pouches.length === 0 && <p>Inventory editing isn't available for this save format.</p>}
      {pouches.length > 0 && (
        <div className="save-editor-inventory-layout">
          <div>
            <label className="save-editor-field">POUCH
              <select value={activePouch} onChange={event => {
                setActivePouch(event.target.value)
                setItem(null)
                setFilter('')
                setError('')
                setMessage('')
              }}>
                {pouches.map(entry => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
              </select>
            </label>
            <label className="save-editor-field">FIND ITEM
              <input type="search" value={filter} placeholder="Search this pouch..."
                onChange={event => setFilter(event.target.value)}/>
            </label>
            <div className="save-editor-inventory-list" aria-label="Bag items">
              {available.map(entry => (
                <button key={entry.id} className={item === entry.id ? 'active' : ''} type="button"
                  onClick={() => selectItem(entry.id)}>
                  <span>{entry.name}{entry.isUnknown ? ' (unknown)' : ''}</span>
                  <small>{entry.owned ? '×' + entry.count : 'ADD'}</small>
                </button>
              ))}
              {available.length === 0 && <p>No matching items in this pouch.</p>}
            </div>
          </div>
          <div className="save-editor-inventory-detail">
            {selected ? (
              <>
                <span className="eyebrow">{owned.some(entry => entry.id === selected.id) ? 'EDIT ITEM' : 'ADD ITEM'}</span>
                <h3>{selected.name}</h3>
                <p>Current: {currentCount} · Maximum: {selected.maxCount}</p>
                <label className="save-editor-field">QUANTITY
                  <input type="number" min="0" max={selected.maxCount} value={count}
                    disabled={saving} onChange={event => setCount(event.target.value)}/>
                </label>
                <PixelButton disabled={saving || count.trim() === String(currentCount)}
                  onClick={() => void apply()}>
                  {saving ? 'APPLYING...' : 'APPLY ITEM CHANGE'}
                </PixelButton>
                <p className="save-editor-help">A quantity of 0 removes the item. An edited save is downloaded only when you export.</p>
              </>
            ) : <p>Select an existing item or choose one to add to this pouch.</p>}
          </div>
        </div>
      )}
    </section>
  )
}
