import { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { multiplayerSaveStore, type MultiplayerSaveProfile } from './core/storage/MultiplayerSaveStore'
import { loadRomFile } from './core/rom/RomLoader'
import { gameById } from './data/games'
import { identifyWhite2Rom } from './multiplayer/games/white2Rom'
import { MultiplayerScreen } from './screens/MultiplayerScreen'
import './styles/app.css'
import './styles/emulator.css'
import './styles/game-themes.css'
import './styles/cover-mascots.css'
import './styles/emerald-scene.css'
import './styles/my-runs.css'
import './styles/multiplayer-session.css'


const DEV_ROOM_KEY = 'pokerun-multiplayer-dev-room-v1'
const DEV_SAVE_KEYS = {
  1: 'pokerun-multiplayer-dev-save-player-1-v1',
  2: 'pokerun-multiplayer-dev-save-player-2-v1',
} as const
const AUTO_RETRY_MS = 1000

function goToMainApp() {
  window.location.href = '/'
}

function buttonByText(...labels: string[]) {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => {
    const text = button.textContent?.trim().toUpperCase() ?? ''
    return labels.some(label => text === label)
  }) ?? null
}

function savedProfileForPlayer(player: 1 | 2) {
  const profileId = localStorage.getItem(DEV_SAVE_KEYS[player])
  if (!profileId) return null
  return multiplayerSaveStore.list('white2').find(profile => profile.id === profileId) ?? null
}

function profileCard(profile: MultiplayerSaveProfile) {
  const expectedTitle = `SAVE ${String(profile.slotNumber).padStart(3, '0')}`
  return [...document.querySelectorAll<HTMLElement>('.run-card')].find(card =>
    card.querySelector('h2')?.textContent?.trim().toUpperCase() === expectedTitle,
  ) ?? null
}

/**
 * Dev-only UI driver. Production multiplayer code stays untouched: this component
 * drives the existing White 2 picker/lobby controls exactly like a person would.
 * Every asynchronous phase is verified from the next rendered UI state and retried
 * after a bounded delay instead of assuming one synthetic click succeeded.
 */
function MultiplayerPlayer({ player }: { player: 1 | 2 }) {
  const [autoStatus, setAutoStatus] = useState('BOOTING')
  const [restoreBlocked, setRestoreBlocked] = useState<string | null>(null)

  useEffect(() => {
    document.title = `PokéRun Multiplayer Dev • Player ${player}`
    let cancelled = false
    let activeRoomCode = ''
    let lastCreateAt = 0
    let lastJoinAt = 0
    let lastSaveAt = 0
    let lastReadyAt = 0
    let lastStartAt = 0
    let lastStatus = ''
    let checkedRomId = ''
    let checkingRomId = ''
    let failedRomId = ''

    function status(next: string) {
      if (next === lastStatus) return
      lastStatus = next
      setAutoStatus(next)
    }

    function retryJoin(code: string) {
      const now = Date.now()
      if (now - lastJoinAt < AUTO_RETRY_MS) return
      lastJoinAt = now
      // The dev-only listener in MultiplayerScreen calls session.join(code).
      // Repeating this message is safe until the host confirms the guest.
      window.dispatchEvent(new CustomEvent('pokerun:dev-join-room', { detail: { code } }))
    }

    function retryReady(button: HTMLButtonElement) {
      const now = Date.now()
      if (button.disabled || now - lastReadyAt < AUTO_RETRY_MS) return
      lastReadyAt = now
      button.click()
    }

    function tick() {
      if (cancelled) return

      if (document.querySelector('.active-run')) {
        status('GAME RUNNING')
        return
      }

      const now = Date.now()
      const requestedRoomCode = new URLSearchParams(window.location.search).get('room')?.trim().toUpperCase() ?? ''
      const sharedRoomCode = requestedRoomCode || (localStorage.getItem(DEV_ROOM_KEY)?.trim().toUpperCase() ?? '')
      const roomCodeElement = document.querySelector<HTMLElement>('.lobby-room-code strong')
      const visibleRoomCode = roomCodeElement?.textContent?.trim().toUpperCase() ?? ''

      if (visibleRoomCode) {
        activeRoomCode = visibleRoomCode

        if (player === 1) {
          if (sharedRoomCode !== visibleRoomCode) localStorage.setItem(DEV_ROOM_KEY, visibleRoomCode)
        } else if (sharedRoomCode && sharedRoomCode !== visibleRoomCode) {
          status('ROOM CHANGED • REJOINING')
          buttonByText('LEAVE ROOM')?.click()
          activeRoomCode = ''
          lastSaveAt = 0
          return
        }

        if (player === 2) {
          const confirmed = document.querySelector<HTMLElement>('.multiplayer-lobby')
            ?.dataset.pokerunRealPeerConfirmed === 'true'
          if (!confirmed) {
            status('WAITING FOR HOST ROOM ACK • RETRYING JOIN')
            retryJoin(visibleRoomCode)
            return
          }
        }

        const playerCards = [...document.querySelectorAll<HTMLElement>('.lobby-player')]
        const localCard = playerCards.find(card => card.textContent?.includes('• YOU'))
        const localRomReady = localCard?.textContent?.includes('ROM VERIFIED') ?? false

        if (!localRomReady) {
          const profile = savedProfileForPlayer(player)
          if (!profile) {
            // Manual selection is intentional and must remain usable for the
            // first cartridge import or when the user wants to pick a ROM.
            if (!localStorage.getItem(DEV_SAVE_KEYS[player])) {
              status(`MANUAL PLAYER ${player} SAVE SELECTION`)
              setRestoreBlocked(null)
            } else {
              status(`PLAYER ${player} SAVED SLOT NO LONGER EXISTS`)
              setRestoreBlocked('The remembered save slot no longer exists. Use CHANGE SAVE / REPAIR ROM to select a different one.')
            }
            return
          }

          // One read-only preflight check per selected slot. The old driver
          // repeatedly clicked CONTINUE on a missing-ROM slot forever, leaving
          // the user stuck in the lobby after a test-save import.
          if (failedRomId === profile.id) {
            status('ROM NOT AVAILABLE — CHANGE SAVE OR REPAIR ROM')
            return
          }
          if (checkedRomId !== profile.id) {
            if (checkingRomId !== profile.id) {
              checkingRomId = profile.id
              void multiplayerSaveStore.restoreRom(profile.id).then(rom => {
                if (cancelled || checkingRomId !== profile.id) return
                if (rom && rom.sha256 === profile.romSha256) {
                  checkedRomId = profile.id
                  setRestoreBlocked(null)
                } else {
                  failedRomId = profile.id
                  setRestoreBlocked(`SAVE ${String(profile.slotNumber).padStart(3, '0')} could not restore its ROM. Choose an earlier slot, or reattach your verified .nds on the launcher. This check did not change the .sav.`)
                }
              }).catch(error => {
                if (cancelled || checkingRomId !== profile.id) return
                failedRomId = profile.id
                setRestoreBlocked(error instanceof Error ? error.message : 'ROM restore failed. Change save or reattach the .nds.')
              })
            }
            status('CHECKING SELECTED SAVE ROM')
            return
          }
          const visibleError = document.querySelector<HTMLElement>('.multiplayer-lobby .form-error')?.textContent?.toUpperCase() ?? ''
          if (visibleError.includes('SAVED ROM DATA IS UNAVAILABLE') ||
              visibleError.includes('FINGERPRINT NO LONGER MATCHES')) {
            failedRomId = profile.id
            setRestoreBlocked(visibleError)
            status('ROM RESTORE FAILED — CHANGE SAVE')
            return
          }
          const card = profileCard(profile)
          const continueButton = card
            ? [...card.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim().toUpperCase() === 'CONTINUE')
            : null

          if (!continueButton) {
            status(`WAITING FOR SAVE ${String(profile.slotNumber).padStart(3, '0')} UI`)
            return
          }

          status(`RESTORING SAVE ${String(profile.slotNumber).padStart(3, '0')}`)
          if (!continueButton.disabled && now - lastSaveAt >= AUTO_RETRY_MS) {
            lastSaveAt = now
            continueButton.click()
          }
          return
        }

        const ready = buttonByText('READY')
        if (ready) {
          if (ready.disabled) {
            status(player === 1
              ? 'WAITING FOR REAL P2 TO JOIN / VERIFY ROM'
              : 'WAITING FOR ROOM COMPATIBILITY')
            return
          }
          status('READYING')
          retryReady(ready)
          return
        }

        if (player === 1) {
          const start = buttonByText('START GAME')
          if (start) {
            if (start.disabled) {
              status('WAITING FOR PLAYER 2 READY')
            } else {
              status('STARTING GAME')
              if (now - lastStartAt >= AUTO_RETRY_MS) {
                lastStartAt = now
                start.click()
              }
            }
            return
          }
        }

        status(player === 1 ? 'WAITING FOR START CONTROL' : 'READY • WAITING FOR HOST')
        return
      }

      if (player === 2 && activeRoomCode && sharedRoomCode && activeRoomCode !== sharedRoomCode) {
        const leave = buttonByText('LEAVE SESSION', 'LEAVE ROOM')
        if (leave) {
          status('ROOM CHANGED • LEAVING OLD SESSION')
          leave.click()
          activeRoomCode = ''
          lastJoinAt = 0
          lastSaveAt = 0
          return
        }
      }

      const gameTile = document.querySelector<HTMLButtonElement>('.game-tile')
      if (gameTile) {
        status('SELECTING WHITE 2')
        gameTile.click()
        return
      }

      if (player === 1) {
        const create = buttonByText('CREATE ROOM')
        if (create) {
          status('CREATING ROOM')
          if (!create.disabled && now - lastCreateAt >= AUTO_RETRY_MS) {
            lastCreateAt = now
            create.click()
          }
        } else {
          status('WAITING FOR CREATE ROOM UI')
        }
        return
      }

      if (!sharedRoomCode) {
        status('WAITING FOR HOST ROOM CODE')
        return
      }

      // PRK68: join directly through the already-connected session, rather
      // than synthesize keypresses in a controlled React input and hope
      // state has settled by the time the JOIN button is clicked.
      status(`JOINING REAL HOST ROOM ${sharedRoomCode}`)
      retryJoin(sharedRoomCode)
    }

    const timer = window.setInterval(tick, 100)
    tick()
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [player])

  return <>
    <div style={{
      position: 'fixed',
      left: 12,
      bottom: 12,
      zIndex: 10000,
      padding: '8px 10px',
      background: 'rgba(244, 249, 252, 0.97)',
      border: '2px solid #35546b',
      fontSize: 11,
      color: '#243f54',
    }}><b>AUTO P{player}</b> • {autoStatus}
      <div style={{ marginTop: 6 }}>
        <button type="button" style={{ fontSize: 11, padding: '4px 6px', cursor: 'pointer' }}
          onClick={() => { window.location.href = '/multiplayer-dev.html' }}>
          CHANGE SAVE / REPAIR ROM
        </button>
      </div>
      {restoreBlocked && <p role="alert" style={{ marginTop: 6, fontSize: 11, maxWidth: 280 }}>
        {restoreBlocked}
      </p>}
    </div>
    <MultiplayerScreen onHome={goToMainApp} onMyRuns={goToMainApp} onSettings={goToMainApp} />
  </>
}

function storedSelection(player: 1 | 2, profiles: MultiplayerSaveProfile[]) {
  const stored = localStorage.getItem(DEV_SAVE_KEYS[player])
  if (stored && profiles.some(profile => profile.id === stored)) return stored
  const index = player - 1
  return profiles[index]?.id ?? ''
}

function MultiplayerDevLauncher() {
  const profiles = useMemo(
    () => multiplayerSaveStore.list('white2').slice().sort((a, b) => a.slotNumber - b.slotNumber),
    [],
  )
  const [player1Save, setPlayer1Save] = useState(() => storedSelection(1, profiles))
  const [player2Save, setPlayer2Save] = useState(() => storedSelection(2, profiles))
  const [radioIsolation, setRadioIsolation] = useState(true)
  const reattachPicker = useRef<HTMLInputElement>(null)
  const reattachTarget = useRef<1 | 2>(1)
  const [reattaching, setReattaching] = useState(false)
  const [reattachMessage, setReattachMessage] = useState<string | null>(null)
  const [reattachError, setReattachError] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  const [launchStatus, setLaunchStatus] = useState<string | null>(null)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [manualLaunchReady, setManualLaunchReady] = useState(false)
  const launchInProgress = useRef(false)

  async function reattachSelectedRom(file: File | null) {
    if (!file || reattaching) return
    setReattaching(true)
    setReattachMessage(null)
    setReattachError(null)
    try {
      const player = reattachTarget.current
      const targetId = player === 1 ? player1Save : player2Save
      if (!targetId) throw new Error('Select a saved slot before reattaching the ROM.')
      const profile = profiles.find(item => item.id === targetId)
      if (!profile) throw new Error('The selected save slot could not be found.')
      const rom = await loadRomFile(file, gameById.white2)
      const identity = identifyWhite2Rom(rom)
      await multiplayerSaveStore.attachRomToProfile(profile.id, rom, identity)
      setReattachMessage(`ROM verified and restored for SAVE ${String(profile.slotNumber).padStart(3, '0')}. Your battery save was not changed. Click PLAYER ${player} to auto-launch.`)
    } catch (error) {
      setReattachError(error instanceof Error ? error.message : 'Could not reattach the ROM.')
    } finally {
      setReattaching(false)
      if (reattachPicker.current) reattachPicker.current.value = ''
    }
  }

  useEffect(() => {
    if (player1Save) localStorage.setItem(DEV_SAVE_KEYS[1], player1Save)
    else localStorage.removeItem(DEV_SAVE_KEYS[1])
  }, [player1Save])

  useEffect(() => {
    if (player2Save) localStorage.setItem(DEV_SAVE_KEYS[2], player2Save)
    else localStorage.removeItem(DEV_SAVE_KEYS[2])
  }, [player2Save])

  function persistPlayerSelections() {
    // Persist synchronously before navigating. React effects may not run
    // between selecting a new slot and pressing PLAYER 1.
    for (const [player, id] of [[1, player1Save], [2, player2Save]] as const) {
      if (id) localStorage.setItem(DEV_SAVE_KEYS[player], id)
      else localStorage.removeItem(DEV_SAVE_KEYS[player])
    }
  }

  /**
   * PRK66: one-click setup with a non-destructive second battery-save slot.
   * The browser opens a blank tab synchronously to preserve the click gesture,
   * then navigates it only AFTER the copied save is durably committed.
   */
  async function launchBoth() {
    if (launchInProgress.current) return
    launchInProgress.current = true
    setLaunching(true)
    setLaunchError(null)
    setLaunchStatus(null)
    setManualLaunchReady(false)
    let secondWindow: Window | null = null
    let createdProfile: MultiplayerSaveProfile | null = null
    let createdCommitted = false
    try {
      const source = profiles.find(profile => profile.id === player1Save)
      if (!source) throw new Error('Select an existing White 2 save under PLAYER 1 SAVE first.')

      // Open immediately, before the async IndexedDB operations. Browsers
      // otherwise reject popup opening after the user gesture has expired.
      secondWindow = window.open('about:blank', '_blank')

      let secondId = player2Save
      const shouldMakeCopy = !secondId || secondId === source.id
      if (shouldMakeCopy) {
        setLaunchStatus('PREPARING AN INDEPENDENT PLAYER 2 TEST SAVE...')
        const battery = await multiplayerSaveStore.loadBatterySave(source.id)
        if (!battery?.byteLength) {
          throw new Error('Player 1 does not have a stored battery save to clone. Save in White 2 first, or select an existing independent Player 2 save.')
        }
        const rom = await multiplayerSaveStore.restoreRom(source.id)
        if (!rom || rom.sha256 !== source.romSha256) {
          throw new Error('Cannot restore the verified White 2 ROM for Player 1. Reattach it on this launcher before creating a Player 2 test copy.')
        }
        const identity = identifyWhite2Rom(rom)
        if (identity.status !== 'verified' || identity.sha256 !== source.romSha256) {
          throw new Error('Player 1 ROM failed the White 2 verification required for a safe test copy.')
        }
        createdProfile = multiplayerSaveStore.createDerived(source.id, rom, identity)
        await multiplayerSaveStore.saveBatterySave(createdProfile.id, battery)
        createdCommitted = true
        secondId = createdProfile.id
        setPlayer2Save(secondId)
        setLaunchStatus(`CREATED INDEPENDENT P2 TEST SLOT ${String(createdProfile.slotNumber).padStart(3, '0')}.`)
        console.info('[PokéRun PRK66] CREATED INDEPENDENT P2 SAVE COPY', {
          sourceSlot: source.slotNumber, player2Slot: createdProfile.slotNumber,
          originalSaveUnchanged: true,
        })
      } else {
        const second = profiles.find(profile => profile.id === secondId)
        if (!second) throw new Error('Selected Player 2 save is missing. Choose another save.')
        if (second.romSha256 !== source.romSha256) {
          throw new Error('The two players must use the same verified White 2 ROM. Select a matching save for Player 2.')
        }
      }
      if (!secondId || secondId === source.id) {
        throw new Error('Two independent save slots are required for the two real DS emulators.')
      }
      // Use resolved IDs instead of relying on React effects to run before
      // navigation. Preserve the existing source profile and battery bytes.
      localStorage.setItem(DEV_SAVE_KEYS[1], source.id)
      localStorage.setItem(DEV_SAVE_KEYS[2], secondId)
      localStorage.removeItem(DEV_ROOM_KEY)
      if (secondWindow && !secondWindow.closed) {
        secondWindow.location.replace(`/multiplayer-dev.html?player=2${radioIsolation ? '&radioIsolation=1' : ''}`)
        window.location.href = `/multiplayer-dev.html?player=1${radioIsolation ? '&radioIsolation=1' : ''}`
      } else {
        setManualLaunchReady(true)
        setLaunchStatus('THE BROWSER BLOCKED PLAYER 2. OPEN THE TWO PLAYER LINKS BELOW MANUALLY.')
      }
    } catch (error) {
      try { secondWindow?.close() } catch { /* popup unavailable */ }
      if (createdProfile && !createdCommitted) {
        // Roll back an incomplete derived profile, but never the source slot.
        try { await multiplayerSaveStore.delete(createdProfile.id) } catch { /* present diagnostic below */ }
      }
      setLaunchError(error instanceof Error ? error.message : 'Could not prepare a two-player session.')
    } finally {
      launchInProgress.current = false
      setLaunching(false)
    }
  }

  function openPlayer(player: 1 | 2) {
    persistPlayerSelections()
    if (player === 1) localStorage.removeItem(DEV_ROOM_KEY)
    window.location.href = `/multiplayer-dev.html?player=${player}${radioIsolation ? '&radioIsolation=1' : ''}`
  }

  return <main className="screen home-screen">
    <div className="home-sky" aria-hidden="true"><div className="home-water"/><div className="home-grass"/></div>
    <div className="screen-shell">
      <section className="page-title-row">
        <div>
          <span className="eyebrow">LOCAL DEVELOPMENT ONLY</span>
          <h1>MULTIPLAYER DEV HARNESS</h1>
          <p>Launch both White 2 players, restore their saved cartridges, join the same room, ready up, and start automatically.</p>
        </div>
      </section>

      <section className="multiplayer-setup pixel-border">
        <article>
          <h2>PLAYER 1 SAVE</h2>
          <p>Remembered for future launches.</p>
          <select value={player1Save} onChange={event => setPlayer1Save(event.target.value)}>
            <option value="">MANUAL SELECTION</option>
            {profiles.map(profile => <option key={profile.id} value={profile.id}>SAVE {String(profile.slotNumber).padStart(3, '0')} • {profile.fileName}</option>)}
          </select>
        </article>
        <article>
          <h2>PLAYER 2 SAVE</h2>
          <p>Remembered for future launches. Use a different slot than Player 1.</p>
          <select value={player2Save} onChange={event => setPlayer2Save(event.target.value)}>
            <option value="">MANUAL SELECTION</option>
            {profiles.map(profile => <option key={profile.id} value={profile.id}>SAVE {String(profile.slotNumber).padStart(3, '0')} • {profile.fileName}</option>)}
          </select>
        </article>
      </section>

      <section className="multiplayer-setup pixel-border">
        <article>
          <h2>RECOVER A SAVE'S ROM</h2>
          <p>If auto-launch reports that the ROM is missing, reattach your own
            matching White 2 .nds file to the selected slot. This does not
            overwrite the Pokémon save or create another slot.</p>
          <input type="file" accept=".nds" hidden ref={reattachPicker}
            onChange={event => void reattachSelectedRom(event.target.files?.[0] ?? null)}/>
          <div className="join-row">
            <button className="pixel-button ghost" disabled={reattaching || !player1Save}
              onClick={() => { reattachTarget.current = 1; reattachPicker.current?.click() }}>
              {reattaching ? 'VERIFYING...' : 'REATTACH PLAYER 1 ROM'}
            </button>
            <button className="pixel-button ghost" disabled={reattaching || !player2Save}
              onClick={() => { reattachTarget.current = 2; reattachPicker.current?.click() }}>
              REATTACH PLAYER 2 ROM
            </button>
          </div>
          {reattachMessage && <p role="status">{reattachMessage}</p>}
          {reattachError && <p role="alert" className="form-error">{reattachError}</p>}
        </article>
        <article>
          <h2>RETURN TO A WORKING SAVE</h2>
          <p>Choose the earlier save above, then click PLAYER 1 below.
            Existing save slots are preserved, including test imports.</p>
        </article>
      </section>

      <section className="multiplayer-setup pixel-border">
        <article>
          <h2>LAUNCH TEST SESSION</h2>
          <p>The current tab becomes Player 1 and a new tab opens for Player 2.
            If Player 2 is empty or points to Player 1's save, the launcher creates
            an <strong>independent test copy</strong> of Player 1's stored battery save first.
            The original save remains unchanged. <strong>Important:</strong> the
            copied game initially has the same in-game trainer ID and progress
            as Player 1. That's fine for radio transport tests, but may
            prevent realistic game-level peer discovery or trading.</p>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
            <input type="checkbox" checked={radioIsolation}
              onChange={event => setRadioIsolation(event.target.checked)} />
            <span><strong>PRK75 RADIO ISOLATION (RECOMMENDED)</strong> — disables
              PokeRun's older injected trainer, custom interaction menu, and
              field-actor transition code in both real players. melonDS game,
              native Wi-Fi bridge and PRK72 counters stay active. Uncheck
              only when deliberately testing older native actor rendering.</span>
          </label>
          <button className="pixel-button" disabled={launching || !player1Save}
            onClick={() => void launchBoth()}>
            {launching ? 'PREPARING TWO REAL DS PLAYERS...' : 'LAUNCH PLAYER 1 + PLAYER 2'}
          </button>
          {!player1Save && <p className="form-error" role="alert">
            Select a Player 1 save to enable two-player launch.
          </p>}
          {player1Save && (!player2Save || player1Save === player2Save) && <p style={{ fontSize: 12 }}>
            A separate Player 2 test save will be cloned automatically and saved under its own slot.
          </p>}
          {launchStatus && <p role="status" style={{ fontSize: 12 }}>{launchStatus}</p>}
          {launchError && <p role="alert" className="form-error">{launchError}</p>}
          {manualLaunchReady && <div className="join-row">
            <a className="pixel-button ghost" href={`/multiplayer-dev.html?player=2${radioIsolation ? '&radioIsolation=1' : ''}`} target="_blank" rel="noopener noreferrer">
              OPEN PLAYER 2 IN NEW TAB
            </a>
            <a className="pixel-button ghost" href={`/multiplayer-dev.html?player=1${radioIsolation ? '&radioIsolation=1' : ''}`}>
              THEN OPEN PLAYER 1
            </a>
          </div>}
        </article>
        <article>
          <h2>RESTART ONE PLAYER</h2>
          <p>Useful when only one emulator needs to be restarted.</p>
          <div className="join-row">
            <button className="pixel-button ghost" onClick={() => openPlayer(1)}>PLAYER 1</button>
            <button className="pixel-button ghost" onClick={() => openPlayer(2)}>PLAYER 2</button>
          </div>
        </article>
      </section>

      <section className="runs-empty pixel-border">
        <h2>SAVED CARTRIDGES FOUND: {profiles.length}</h2>
        <p>If a player is set to MANUAL SELECTION, that tab will stop in the normal White 2 lobby so you can choose a ROM/save yourself.</p>
      </section>
    </div>
  </main>
}

const player = new URLSearchParams(window.location.search).get('player')
ReactDOM.createRoot(document.getElementById('root')!).render(player === '1' || player === '2' ? <MultiplayerPlayer player={Number(player) as 1 | 2} /> : <MultiplayerDevLauncher />)
