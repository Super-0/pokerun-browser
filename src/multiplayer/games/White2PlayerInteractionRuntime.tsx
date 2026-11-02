import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerDirection, MultiplayerEmote, MultiplayerEmoteKind, MultiplayerPlayerState } from '../core/protocol'

const GAME_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyX', 'KeyZ', 'KeyS', 'KeyA', 'KeyQ', 'KeyW',
  'Enter', 'ShiftRight',
])

const MENU_ITEMS = ['TRAINER CARD', 'EMOTE', 'FOLLOW', 'CLOSE'] as const
const EMOTES: { kind: MultiplayerEmoteKind; label: string; glyph: string }[] = [
  { kind: 'hello', label: 'HELLO', glyph: 'HI!' },
  { kind: 'heart', label: 'HEART', glyph: '♥' },
  { kind: 'surprised', label: 'SURPRISED', glyph: '!' },
  { kind: 'cheer', label: 'CHEER', glyph: '★' },
]
const EMOTE_VISIBLE_MS = 1150

type MenuItem = typeof MENU_ITEMS[number]
type MenuPage = 'root' | 'trainer' | 'emotes' | 'soon'

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

function emoteGlyph(kind: MultiplayerEmoteKind) {
  return EMOTES.find(emote => emote.kind === kind)?.glyph ?? '!'
}

function remoteBubblePosition(local: MultiplayerPlayerState | null, remote: MultiplayerPlayerState | null) {
  if (!local || !remote || local.location.mapId !== remote.location.mapId) return null
  const dx = remote.x - local.x
  const dy = remote.y - local.y
  if (Math.abs(dx) > 7 || Math.abs(dy) > 5) return null
  return {
    left: `${50 + dx * 6.25}%`,
    top: `${42 + dy * (100 / 12)}%`,
  }
}

export function White2PlayerInteractionRuntime() {
  const [presence, setPresence] = useState<MultiplayerPresenceSnapshot>({ local: null, remote: null })
  const [menuOpen, setMenuOpen] = useState(false)
  const [selection, setSelection] = useState(0)
  const [page, setPage] = useState<MenuPage>('root')
  const [soonFeature, setSoonFeature] = useState('')
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)
  const [visibleLocalEmote, setVisibleLocalEmote] = useState<MultiplayerEmote | null>(null)
  const [visibleRemoteEmote, setVisibleRemoteEmote] = useState<MultiplayerEmote | null>(null)
  const localEmoteTimer = useRef<number | null>(null)
  const remoteEmoteTimer = useRef<number | null>(null)

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

  useEffect(() => {
    const emote = presence.local?.emote
    if (!emote) return
    setVisibleLocalEmote(previous => previous?.id === emote.id ? previous : emote)
    if (localEmoteTimer.current !== null) window.clearTimeout(localEmoteTimer.current)
    localEmoteTimer.current = window.setTimeout(() => {
      setVisibleLocalEmote(previous => previous?.id === emote.id ? null : previous)
      localEmoteTimer.current = null
    }, EMOTE_VISIBLE_MS)
  }, [presence.local?.emote?.id])

  useEffect(() => {
    const emote = presence.remote?.emote
    if (!emote) return
    setVisibleRemoteEmote(previous => previous?.id === emote.id ? previous : emote)
    if (remoteEmoteTimer.current !== null) window.clearTimeout(remoteEmoteTimer.current)
    remoteEmoteTimer.current = window.setTimeout(() => {
      setVisibleRemoteEmote(previous => previous?.id === emote.id ? null : previous)
      remoteEmoteTimer.current = null
    }, EMOTE_VISIBLE_MS)
  }, [presence.remote?.emote?.id])

  useEffect(() => () => {
    if (localEmoteTimer.current !== null) window.clearTimeout(localEmoteTimer.current)
    if (remoteEmoteTimer.current !== null) window.clearTimeout(remoteEmoteTimer.current)
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
      setSoonFeature('')
    }
  }, [menuOpen, presence.local, presence.remote])

  const closeMenu = () => {
    setMenuOpen(false)
    setPage('root')
    setSelection(0)
    setSoonFeature('')
    console.info('[PokéRun interaction] PLAYER MENU CLOSED')
  }

  const selectRootItem = (item: MenuItem) => {
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
    if (item === 'EMOTE') {
      setSelection(0)
      setPage('emotes')
      return
    }
    setSoonFeature(item)
    setPage('soon')
    console.info('[PokéRun interaction] FEATURE SELECTED', { feature: item, implemented: false })
  }

  const sendEmote = (kind: MultiplayerEmoteKind) => {
    const sent = multiplayerPresence.sendEmote(kind)
    if (!sent) {
      setSoonFeature('EMOTE UNAVAILABLE')
      setPage('soon')
      console.info('[PokéRun interaction] EMOTE BLOCKED', { kind, reason: 'No active multiplayer game state.' })
      return
    }
    console.info('[PokéRun interaction] EMOTE SELECTED', { kind })
    closeMenu()
  }

  useEffect(() => {
    const block = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return false
      if (!GAME_KEYS.has(event.code) && event.code !== 'Escape') return false
      event.preventDefault()
      event.stopImmediatePropagation()
      return true
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
          setSelection(0)
          setSoonFeature('')
        } else {
          closeMenu()
        }
        return
      }

      if (page === 'trainer' || page === 'soon') {
        if (event.code === 'KeyX' || event.code === 'Enter') {
          setPage('root')
          setSelection(0)
          setSoonFeature('')
        }
        return
      }

      const itemCount = page === 'emotes' ? EMOTES.length : MENU_ITEMS.length
      if (event.code === 'ArrowUp') {
        setSelection(value => (value + itemCount - 1) % itemCount)
      } else if (event.code === 'ArrowDown') {
        setSelection(value => (value + 1) % itemCount)
      } else if (event.code === 'KeyX' || event.code === 'Enter') {
        if (page === 'emotes') sendEmote(EMOTES[selection].kind)
        else selectRootItem(MENU_ITEMS[selection])
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

  const remoteBubble = remoteBubblePosition(presence.local, presence.remote)
  const hasOverlay = menuOpen || interactable || visibleLocalEmote || (visibleRemoteEmote && remoteBubble)
  if (!hasOverlay) return null

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
      .w2-emote-bubble {
        position: absolute;
        z-index: 14;
        display: grid;
        place-items: center;
        min-width: 18px;
        height: 18px;
        padding: 0;
        transform: translate(-50%, -100%);
        color: #f4f7fa;
        font-family: Arial Black, Arial, Helvetica, sans-serif;
        font-size: 16px;
        line-height: 1;
        font-weight: 900;
        white-space: nowrap;
        text-shadow:
          -1px -1px 0 #20272e,
           1px -1px 0 #20272e,
          -1px  1px 0 #20272e,
           1px  1px 0 #20272e,
           0 2px 0 rgba(0,0,0,.35);
        animation: w2-emote-field-pop ${EMOTE_VISIBLE_MS}ms ease-out both;
      }
      .w2-emote-bubble.hello {
        font-size: 9px;
        letter-spacing: -.03em;
      }
      .w2-emote-bubble.heart {
        color: #e95c79;
        font-size: 17px;
      }
      .w2-emote-bubble.surprised {
        color: #f7f2d7;
        font-size: 19px;
      }
      .w2-emote-bubble.cheer {
        color: #f1c44d;
        font-size: 17px;
      }
      @keyframes w2-emote-field-pop {
        0% { opacity: 0; transform: translate(-50%, -72%) scale(.45); }
        12% { opacity: 1; transform: translate(-50%, -108%) scale(1.18); }
        24% { transform: translate(-50%, -100%) scale(1); }
        72% { opacity: 1; transform: translate(-50%, -112%) scale(1); }
        100% { opacity: 0; transform: translate(-50%, -142%) scale(.86); }
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

  const remote = presence.remote

  return createPortal(
    <div className="w2-interact-root">
      {shellStyles}

      {visibleLocalEmote && (
        <div
          className={`w2-emote-bubble ${visibleLocalEmote.kind}`}
          style={{ left: '50%', top: '42%' }}
          aria-label={`Your ${visibleLocalEmote.kind} emote`}
        >
          {emoteGlyph(visibleLocalEmote.kind)}
        </div>
      )}

      {visibleRemoteEmote && remoteBubble && (
        <div
          className={`w2-emote-bubble ${visibleRemoteEmote.kind}`}
          style={remoteBubble}
          aria-label={`Partner ${visibleRemoteEmote.kind} emote`}
        >
          {emoteGlyph(visibleRemoteEmote.kind)}
        </div>
      )}

      {!menuOpen && interactable && <div className="w2-interact-prompt"><b>A</b>INTERACT</div>}

      {menuOpen && (
        <div
          className="w2-menu-layer"
          role="presentation"
          onMouseDown={closeMenu}
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
                    onClick={() => selectRootItem(item)}
                  >
                    <span>{item}</span>
                    {item === 'FOLLOW' && <small>SOON</small>}
                  </button>
                ))}
              </div>
            </section>
          )}

          {page === 'emotes' && (
            <section
              className="w2-menu-window"
              role="dialog"
              aria-modal="true"
              aria-label="Choose an emote"
              onMouseDown={event => event.stopPropagation()}
            >
              <div className="w2-menu-header">Emote</div>
              <div className="w2-menu-list">
                {EMOTES.map((emote, index) => (
                  <button
                    key={emote.kind}
                    className={`w2-menu-item ${selection === index ? 'selected' : ''}`}
                    onMouseEnter={() => setSelection(index)}
                    onClick={() => sendEmote(emote.kind)}
                  >
                    <span>{emote.glyph} {emote.label}</span>
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
              <span>{soonFeature === 'EMOTE UNAVAILABLE' ? 'Wait until multiplayer live state is ready, then try again.' : "This multiplayer action isn't connected yet."}</span>
            </section>
          )}

          <div className="w2-menu-help">↑↓ MOVE · A SELECT · B BACK</div>
        </div>
      )}
    </div>,
    portalTarget,
  )
}
