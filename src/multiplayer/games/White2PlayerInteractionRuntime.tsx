import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerDirection, MultiplayerPlayerState } from '../core/protocol'

export const WHITE2_INTERACT_EVENT = 'pokerun:white2-interact'

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

export function White2PlayerInteractionRuntime() {
  const [presence, setPresence] = useState<MultiplayerPresenceSnapshot>({ local: null, remote: null })
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
    if (!interactable) return

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.code !== 'KeyX' && event.code !== 'KeyS') || event.repeat) return
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return

      console.info('[PokéRun interaction] PROMPT DISPATCH', {
        code: event.code,
        local: presence.local ? {
          mapId: presence.local.location.mapId,
          x: presence.local.x,
          y: presence.local.y,
          direction: presence.local.direction,
        } : null,
        remote: presence.remote ? {
          mapId: presence.remote.location.mapId,
          x: presence.remote.x,
          y: presence.remote.y,
          direction: presence.remote.direction,
        } : null,
      })

      event.preventDefault()
      window.dispatchEvent(new CustomEvent(WHITE2_INTERACT_EVENT, {
        detail: { code: event.code },
      }))
    }

    window.addEventListener('keydown', onKeyDown, { capture: true, passive: false })
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [interactable, presence.local, presence.remote])

  if (!portalTarget || !interactable) return null

  return createPortal(
    <div className="w2-interact-root">
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
      `}</style>
      <div className="w2-interact-prompt"><b>X</b> INTERACT</div>
    </div>,
    portalTarget,
  )
}
