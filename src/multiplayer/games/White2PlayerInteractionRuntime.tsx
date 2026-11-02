import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerDirection, MultiplayerPlayerState } from '../core/protocol'

const GAME_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyX', 'KeyZ', 'KeyS', 'KeyA', 'KeyQ', 'KeyW',
  'Enter', 'ShiftRight',
])

const MENU_ITEMS = ['TRAINER CARD', 'EMOTE', 'FOLLOW', 'CLOSE'] as const

type MenuItem = typeof MENU_ITEMS[number]
type MenuPage = 'root' | 'trainer' | 'soon'

function facingDelta(direction: MultiplayerDirection) {
  if (direction === 'north') return { x: 0, y: -1 }
  if (direction === 'south') return { x: 0, y: 1 }
  if (direction === 'west') return { x: -1, y: 0 }
  return { x: 1, y: 0 }
}

function canInteract(local: MultiplayerPlayerState | null, remote: MultiplayerPlayerState | null) {
  if (!local || !remote || local.location.mapId !== remote.location.mapId) return false
  const expected = facingDelta(local.direction)
  return remote.x - local.x === expected.x && remote.y - local.y === expected.y
}

function describeDirection(direction: MultiplayerDirection) {
  return direction.toUpperCase()
}

export function White2PlayerInteractionRuntime() {
  const [presence, setPresence] = useState<MultiplayerPresenceSnapshot>({ local: null, remote: null })
  const [menuOpen, setMenuOpen] = useState(false)
  const [selection, setSelection] = useState(0)
  const [page, setPage] = useState<MenuPage>('root')
  const [soonFeature, setSoonFeature] = useState('')
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)

  useEffect(() => multiplayerPresence.subscribe(setPresence), [])

  useEffect(() => {
    const findTarget = () => {
      const target = document.querySelector<HTMLElement>('.melonds-screen-wrap')
      setPortalTarget(previous => previous === target ? previous : target)
    }

    findTarget()
    const observer = new MutationObserver(findTarget)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  const interactable = useMemo(
    () => canInteract(presence.local, presence.remote),
    [presence.local, presence.remote],
  )

  useEffect(() => {
    if (!menuOpen) return
    const local = presence.local
    const remote = presence.remote
    if (!local || !remote || local.location.mapId !== remote.location.mapId) {
      setMenuOpen(false)
      setPage('root')
    }
  }, [menuOpen, presence.local, presence.remote])

  useEffect(() => {
    const block = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return false
      if (!GAME_KEYS.has(event.code) && event.code !== 'Escape') return false
      event.preventDefault()
      event.stopImmediatePropagation()
      return true
    }

    const closeMenu = () => {
      setMenuOpen(false)
      setPage('root')
      setSoonFeature('')
      console.info('[PokéRun interaction] PLAYER MENU CLOSED')
    }

    const selectItem = (item: MenuItem) => {
      if (item === 'CLOSE') {
        closeMenu()
        return
      }
      if (item === 'TRAINER CARD') {
        setPage('trainer')
        console.info('[PokéRun interaction] TRAINER CARD OPENED', {
          remoteMapId: presence.remote?.location.mapId ?? null,
          remoteX: presence.remote?.x ?? null,
          remoteY: presence.remote?.y ?? null,
        })
        return
      }
      setSoonFeature(item)
      setPage('soon')
      console.info('[PokéRun interaction] FEATURE SELECTED', { feature: item, implemented: false })
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (!menuOpen) {
        if (event.code !== 'KeyX' || event.repeat || !interactable) return
        if (!block(event)) return
        setSelection(0)
        setPage('root')
        setSoonFeature('')
        setMenuOpen(true)
        console.info('[PokéRun interaction] PLAYER MENU OPEN', {
          mapId: presence.local?.location.mapId ?? null,
          local: presence.local ? { x: presence.local.x, y: presence.local.y, direction: presence.local.direction } : null,
          remote: presence.remote ? { x: presence.remote.x, y: presence.remote.y, direction: presence.remote.direction } : null,
        })
        return
      }

      if (!block(event)) return
      if (event.repeat && event.code !== 'ArrowUp' && event.code !== 'ArrowDown') return

      if (event.code === 'KeyZ' || event.code === 'Escape') {
        if (page !== 'root') {
          setPage('root')
          setSoonFeature('')
        } else {
          closeMenu()
        }
        return
      }

      if (page !== 'root') {
        if (event.code === 'KeyX' || event.code === 'Enter') {
          setPage('root')
          setSoonFeature('')
        }
        return
      }

      if (event.code === 'ArrowUp') {
        setSelection(value => (value + MENU_ITEMS.length - 1) % MENU_ITEMS.length)
      } else if (event.code === 'ArrowDown') {
        setSelection(value => (value + 1) % MENU_ITEMS.length)
      } else if (event.code === 'KeyX' || event.code === 'Enter') {
        selectItem(MENU_ITEMS[selection])
      }
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (!menuOpen) return
      block(event)
    }

    window.addEventListener('keydown', onKeyDown, { capture: true, passive: false })
    window.addEventListener('keyup', onKeyUp, { capture: true, passive: false })
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [interactable, menuOpen, page, presence.local, presence.remote, selection])

  if (!portalTarget) return null

  const shellStyles = (
    <style>{`
      .w2-interact-root {
        position: absolute;
        inset: 0;
        z-index: 12;
        pointer-events: none;
        font-family: Arial, Helvetica, sans-serif;
        image-rendering: pixelated;
        color: #25292d;
      }
      .w2-interact-prompt {
        position: absolute;
        left: 50%;
        bottom: 9px;
        transform: translateX(-50%);
        min-width: 126px;
        padding: 5px 10px 6px;
        border: 2px solid #373d43;
        border-radius: 6px;
        background: linear-gradient(#ffffff 0 68%, #edf0f2 68% 100%);
        box-shadow:
          inset 0 0 0 2px #c9d0d5,
          inset 0 0 0 4px #f8f9fa,
          2px 2px 0 rgba(0,0,0,.28);
        text-align: center;
        font-size: 11px;
        line-height: 1.15;
        font-weight: 800;
        letter-spacing: .015em;
        white-space: nowrap;
      }
      .w2-interact-prompt b {
        display: inline-block;
        margin-right: 5px;
        color: #225d97;
      }
      .w2-menu-layer {
        position: absolute;
        inset: 0;
        z-index: 13;
        pointer-events: auto;
      }
      .w2-menu-window {
        position: absolute;
        right: 10px;
        top: 12px;
        width: 168px;
        padding: 7px;
        border: 3px solid #31363b;
        border-radius: 8px;
        background:
          linear-gradient(135deg, rgba(255,255,255,.46) 25%, transparent 25%) 0 0 / 8px 8px,
          linear-gradient(315deg, rgba(255,255,255,.3) 25%, transparent 25%) 0 0 / 8px 8px,
          #e8ecef;
        box-shadow:
          inset 0 0 0 2px #f9fafb,
          inset 0 0 0 4px #aab3ba,
          2px 2px 0 rgba(0,0,0,.35);
      }
      .w2-menu-header {
        margin: 1px 5px 5px;
        color: #4b535a;
        font-size: 8px;
        font-weight: 800;
        letter-spacing: .06em;
        text-transform: uppercase;
      }
      .w2-menu-list {
        display: grid;
        gap: 2px;
      }
      .w2-menu-item {
        position: relative;
        display: flex;
        align-items: center;
        min-height: 26px;
        width: 100%;
        padding: 4px 7px 4px 25px;
        border: 0;
        border-radius: 4px;
        background: rgba(255,255,255,.78);
        color: #202428;
        font: inherit;
        font-size: 11px;
        font-weight: 700;
        text-align: left;
        cursor: pointer;
      }
      .w2-menu-item.selected {
        background: linear-gradient(90deg, #dceeff, #f7fbff 72%);
        box-shadow: inset 0 0 0 1px #87aaca;
      }
      .w2-menu-item.selected::before {
        content: '';
        position: absolute;
        left: 8px;
        top: 50%;
        transform: translateY(-50%);
        width: 0;
        height: 0;
        border-top: 5px solid transparent;
        border-bottom: 5px solid transparent;
        border-left: 8px solid #285f94;
        filter: drop-shadow(1px 1px 0 #fff);
      }
      .w2-menu-item small {
        margin-left: auto;
        color: #7f878e;
        font-size: 7px;
        font-weight: 800;
      }
      .w2-info-window {
        position: absolute;
        left: 10px;
        right: 10px;
        bottom: 10px;
        min-height: 76px;
        padding: 10px 13px;
        border: 3px solid #31363b;
        border-radius: 8px;
        background: #f7f8f9;
        box-shadow:
          inset 0 0 0 2px #fefefe,
          inset 0 0 0 4px #aab3ba,
          2px 2px 0 rgba(0,0,0,.35);
        font-size: 10px;
        line-height: 1.35;
      }
      .w2-info-window strong {
        display: block;
        margin-bottom: 5px;
        font-size: 11px;
      }
      .w2-info-grid {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 2px 8px;
      }
      .w2-info-grid span:nth-child(odd) {
        color: #687078;
        font-size: 8px;
        font-weight: 800;
      }
      .w2-menu-help {
        position: absolute;
        left: 10px;
        bottom: 6px;
        color: rgba(255,255,255,.96);
        text-shadow: 1px 1px 0 rgba(0,0,0,.8);
        font-size: 7px;
        font-weight: 800;
        letter-spacing: .02em;
      }
    `}</style>
  )

  if (!menuOpen) {
    if (!interactable) return null
    return createPortal(
      <div className="w2-interact-root">
        {shellStyles}
        <div className="w2-interact-prompt"><b>A</b>INTERACT</div>
      </div>,
      portalTarget,
    )
  }

  const remote = presence.remote

  return createPortal(
    <div className="w2-interact-root">
      {shellStyles}
      <div
        className="w2-menu-layer"
        role="presentation"
        onMouseDown={() => {
          setMenuOpen(false)
          setPage('root')
          setSoonFeature('')
        }}
      >
        {page === 'root' && (
          <section
            className="w2-menu-window"
            role="dialog"
            aria-modal="true"
            aria-label="Player interaction menu"
            onMouseDown={event => event.stopPropagation()}
          >
            <div className="w2-menu-header">Partner</div>
            <div className="w2-menu-list">
              {MENU_ITEMS.map((item, index) => (
                <button
                  key={item}
                  className={`w2-menu-item ${selection === index ? 'selected' : ''}`}
                  onMouseEnter={() => setSelection(index)}
                  onClick={() => {
                    if (item === 'CLOSE') {
                      setMenuOpen(false)
                      setPage('root')
                      setSoonFeature('')
                      return
                    }
                    if (item === 'TRAINER CARD') {
                      setPage('trainer')
                      return
                    }
                    setSoonFeature(item)
                    setPage('soon')
                  }}
                >
                  <span>{item}</span>
                  {(item === 'EMOTE' || item === 'FOLLOW') && <small>SOON</small>}
                </button>
              ))}
            </div>
          </section>
        )}

        {page === 'trainer' && (
          <section className="w2-info-window" role="dialog" aria-label="Partner trainer card" onMouseDown={event => event.stopPropagation()}>
            <strong>PARTNER</strong>
            <div className="w2-info-grid">
              <span>AREA</span><b>{String(remote?.location.mapId ?? '—')}</b>
              <span>POSITION</span><b>{remote ? `${remote.x}, ${remote.y}` : '—'}</b>
              <span>FACING</span><b>{remote ? describeDirection(remote.direction) : '—'}</b>
            </div>
          </section>
        )}

        {page === 'soon' && (
          <section className="w2-info-window" role="dialog" aria-label={`${soonFeature} coming soon`} onMouseDown={event => event.stopPropagation()}>
            <strong>{soonFeature}</strong>
            <span>This multiplayer action isn't connected yet.</span>
          </section>
        )}

        <div className="w2-menu-help">↑↓ MOVE · A SELECT · B BACK</div>
      </div>
    </div>,
    portalTarget,
  )
}
