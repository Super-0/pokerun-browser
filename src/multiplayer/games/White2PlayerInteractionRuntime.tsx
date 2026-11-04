import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerDirection, MultiplayerPlayerState } from '../core/protocol'
import type { White2NativeYesNoResult } from './White2NativeYesNoInteractionProbe'

export const WHITE2_INTERACT_EVENT = 'pokerun:white2-interact'
// PRK56: consume the already verified post-teardown result. Deliberately
// no room send, player-state mutation, trade request, or native guest call.
const WHITE2_NATIVE_YES_NO_RESULT_EVENT = 'pokerun:white2-native-yes-no-result'

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
  const latestPresenceRef = useRef<MultiplayerPresenceSnapshot>({ local: null, remote: null })
  const prk56VerifiedChoicesRef = useRef<Array<'yes' | 'no'>>([])

  // Multiplayer presence can update every field frame. Keep the native
  // result listener stable instead of resubscribing on every position tick.
  useEffect(() => multiplayerPresence.subscribe(snapshot => {
    latestPresenceRef.current = snapshot
    setPresence(snapshot)
  }), [])

  useEffect(() => {
    const onNativeYesNoResult = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const payload: unknown = event.detail
      const candidate = payload as Partial<White2NativeYesNoResult> | null
      const wellFormed = candidate !== null && typeof candidate === 'object' &&
        candidate.interaction === 'trade' &&
        (candidate.choice === 'yes' || candidate.choice === 'no') &&
        (candidate.sequence === 1 || candidate.sequence === 2) &&
        candidate.totalAllowed === 2 &&
        candidate.nativeWindowClosed === true &&
        candidate.originalBg2Restored === true &&
        candidate.guestTradeInitiated === false
      if (!wellFormed || !candidate) {
        console.info('[PokéRun interaction] PRK56 APP RESULT REJECTED', {
          reason: 'Unrecognized or incomplete post-close Yes/No event.',
          note: 'Untrusted DOM event details are never used to authorize a trade.',
        })
        return
      }
      const snapshot = latestPresenceRef.current
      if (!canInteract(snapshot.local, snapshot.remote)) {
        console.info('[PokéRun interaction] PRK56 APP RESULT REJECTED', {
          reason: 'Players no longer occupy the expected facing/adjacent same-map tiles.',
          choice: candidate.choice,
          sequence: candidate.sequence,
          hasLocal: snapshot.local !== null,
          hasRemote: snapshot.remote !== null,
          note: 'Result is ignored; no trade/network action exists in PRK56.',
        })
        return
      }
      if (candidate.sequence === 1) {
        // A new two-interaction experiment starts with a first result.
        prk56VerifiedChoicesRef.current = []
      } else if (prk56VerifiedChoicesRef.current.length !== 1) {
        console.info('[PokéRun interaction] PRK56 APP RESULT REJECTED', {
          reason: 'Second result arrived without an accepted first result.',
          sequence: candidate.sequence,
          note: 'No remote requests or guest writes were attempted.',
        })
        return
      }
      prk56VerifiedChoicesRef.current.push(candidate.choice!)
      const acceptedChoices = [...prk56VerifiedChoicesRef.current]
      console.info('[PokéRun interaction] PRK56 APP POST-CLOSE RESULT CONSUMED', {
        choice: candidate.choice,
        sequence: candidate.sequence,
        totalAllowed: candidate.totalAllowed,
        nativeWindowClosed: candidate.nativeWindowClosed,
        originalBg2Restored: candidate.originalBg2Restored,
        sameMapAdjacentFacing: true,
        mapId: snapshot.local!.location.mapId,
        localTile: { x: snapshot.local!.x, y: snapshot.local!.y },
        remoteTile: { x: snapshot.remote!.x, y: snapshot.remote!.y },
        acceptedChoices,
        tradeRequestSent: false,
        gameTradeInitiated: false,
        note: 'Multiplayer UI consumed a bounded native result AFTER teardown; no transport or trade side effects. DOM events are not security/authentication proof.',
      })
      // PRK58: inspect the actual LocalMultiplayerSession rather than
      // trusting the app-level event to identify a peer or room. These
      // diagnostics never send a message, grant authorization, or change game
      // state; the development transport currently has no server-side identity.
      if (candidate.choice === 'yes') {
        const preview = multiplayerPresence.previewTradeRequest()
        console.info(preview.eligible
          ? '[PokéRun interaction] PRK58 SESSION TRADE PREFLIGHT READY - NO SEND'
          : '[PokéRun interaction] PRK58 SESSION TRADE PREFLIGHT BLOCKED - NO SEND', {
          ...preview,
          selectionSequence: candidate.sequence,
          nativeWindowClosed: candidate.nativeWindowClosed,
          appResultConsumed: true,
          serverIdentityAuthenticated: false,
          guestTradeInitiated: false,
          note: 'PRK58 pre-send dry-run; PRK60 separately decides whether to send a dev-only trade request. No guest writes.',
        })
        // PRK60 asks the session, not an untrusted DOM payload, to bind
        // every room, game-start and peer ID and recheck freshness before
        // sending. Explicit native No never calls the publisher.
        if (preview.eligible) {
          const requested = multiplayerPresence.requestTradeFromConfirmedNativeChoice()
          console.info(requested
            ? '[PokéRun trade] PRK60 NATIVE YES REQUEST DISPATCHED'
            : '[PokéRun trade] PRK60 NATIVE YES REQUEST BLOCKED', {
            resultSequence: candidate.sequence,
            postNativeTeardown: true,
            freshSessionPreflight: preview.eligible,
            devHandshakeMessageSent: requested,
            guestTradeInitiated: false,
            note: 'Protocol-only development request. No Pokémon, save data or guest writes.',
          })
        }
      } else {
        console.info('[PokéRun interaction] PRK58 NO CHOICE DECLINED - NO SEND', {
          choice: candidate.choice,
          sequence: candidate.sequence,
          gameTradeInitiated: false,
          transportMessagesSent: 0,
          note: 'No was confirmed after native cleanup; the application does not initiate a trade.',
        })
      }
      if (candidate.sequence === 2) {
        const coveredBothChoices = acceptedChoices.includes('yes') &&
          acceptedChoices.includes('no')
        console.info(coveredBothChoices
          ? '[PokéRun interaction] PRK56 APP BOTH CHOICES RECEIVED'
          : '[PokéRun interaction] PRK56 APP TWO RESULTS RECEIVED - CHOICE COVERAGE INCOMPLETE', {
          choices: acceptedChoices,
          coveredBothChoices,
          sameMapAdjacentFacing: true,
          networkMessagesSentByNativeRenderer: 0,
          guestTradeInitiated: false,
          note: 'Native renderer itself sends no messages. PRK60 session protocol separately handles any dev-only trade handshake; still no game/party exchange.',
        })
      }
    }
    window.addEventListener(WHITE2_NATIVE_YES_NO_RESULT_EVENT, onNativeYesNoResult)
    return () => window.removeEventListener(WHITE2_NATIVE_YES_NO_RESULT_EVENT, onNativeYesNoResult)
  }, [])

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
