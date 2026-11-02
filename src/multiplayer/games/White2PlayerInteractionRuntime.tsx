import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { PixelButton } from '../../components/PixelButton'
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

  if (!menuOpen) {
    if (!interactable) return null
    return createPortal(
      <div style={{
        position: 'absolute',
        left: '50%',
        bottom: 14,
        transform: 'translateX(-50%)',
        zIndex: 12,
        padding: '7px 11px',
        border: '2px solid #243f54',
        boxShadow: '3px 3px 0 rgba(0,0,0,.24)',
        background: 'rgba(248, 252, 255, .96)',
        color: '#243f54',
        fontSize: 12,
        fontWeight: 800,
        letterSpacing: '.06em',
        pointerEvents: 'none',
      }}>
        X • INTERACT
      </div>,
      portalTarget,
    )
  }

  const remote = presence.remote

  return createPortal(
    <div
      role="presentation"
      onMouseDown={() => {
        setMenuOpen(false)
        setPage('root')
        setSoonFeature('')
      }}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 13,
        display: 'grid',
        placeItems: 'center',
        background: 'rgba(9, 20, 31, .42)',
        overflow: 'hidden',
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Player interaction menu"
        onMouseDown={event => event.stopPropagation()}
        className="pixel-border"
        style={{
          width: 'min(390px, calc(100% - 28px))',
          maxHeight: 'calc(100% - 28px)',
          overflow: 'auto',
          padding: 16,
          background: '#f8fcff',
          color: '#243f54',
          boxShadow: '6px 6px 0 rgba(0,0,0,.28)',
        }}
      >
        <span className="eyebrow">MULTIPLAYER • PARTNER</span>
        <h2 style={{ margin: '5px 0 4px' }}>PLAYER INTERACTION</h2>
        <p style={{ margin: '0 0 12px', opacity: .75 }}>Choose what you want to do with the nearby player.</p>

        {page === 'root' && (
          <div style={{ display: 'grid', gap: 7 }}>
            {MENU_ITEMS.map((item, index) => (
              <button
                key={item}
                onMouseEnter={() => setSelection(index)}
                onClick={() => {
                  if (item === 'CLOSE') {
                    setMenuOpen(false)
                    setPage('root')
                    return
                  }
                  if (item === 'TRAINER CARD') {
                    setPage('trainer')
                    return
                  }
                  setSoonFeature(item)
                  setPage('soon')
                }}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  width: '100%',
                  padding: '9px 11px',
                  border: selection === index ? '3px solid #243f54' : '2px solid #8ca1b0',
                  background: selection === index ? '#e8f5ff' : '#fff',
                  color: '#243f54',
                  font: 'inherit',
                  fontWeight: 800,
                  cursor: 'pointer',
                }}
              >
                <span>{selection === index ? '▶ ' : ''}{item}</span>
                {(item === 'EMOTE' || item === 'FOLLOW') && <small>SOON</small>}
              </button>
            ))}
          </div>
        )}

        {page === 'trainer' && (
          <div>
            <div style={{ display: 'grid', gap: 7, padding: 12, border: '2px solid #8ca1b0', background: '#fff', marginBottom: 12 }}>
              <strong>PARTNER</strong>
              <span>MAP {String(remote?.location.mapId ?? '—')}</span>
              <span>POSITION {remote ? `${remote.x}, ${remote.y}` : '—'}</span>
              <span>FACING {remote ? describeDirection(remote.direction) : '—'}</span>
            </div>
            <PixelButton onClick={() => setPage('root')}>BACK</PixelButton>
          </div>
        )}

        {page === 'soon' && (
          <div>
            <div style={{ padding: 12, border: '2px solid #8ca1b0', background: '#fff', marginBottom: 12 }}>
              <strong>{soonFeature}</strong>
              <p style={{ marginBottom: 0 }}>The interaction hook is working. This action is the next layer to wire through multiplayer messages.</p>
            </div>
            <PixelButton onClick={() => { setPage('root'); setSoonFeature('') }}>BACK</PixelButton>
          </div>
        )}

        <small style={{ display: 'block', marginTop: 10, opacity: .65 }}>↑↓ MOVE • X/ENTER SELECT • Z/ESC BACK</small>
      </section>
    </div>,
    portalTarget,
  )
}
