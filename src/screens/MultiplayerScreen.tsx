import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppHeader } from '../components/AppHeader'
import { MelonDsPlayer } from '../components/MelonDsPlayer'
import { MultiplayerPlayerPanel } from '../components/MultiplayerPlayerPanel'
import { White2MemoryResearchPanel } from '../components/White2MemoryResearchPanel'
import { PixelButton } from '../components/PixelButton'
import { loadRomFile } from '../core/rom/RomLoader'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import { multiplayerSaveStore, type MultiplayerSaveProfile } from '../core/storage/MultiplayerSaveStore'
import { gameById } from '../data/games'
import { LocalMultiplayerSession, type MultiplayerSessionSnapshot } from '../multiplayer/core/LocalMultiplayerSession'
import type { MultiplayerPlayerState } from '../multiplayer/core/protocol'
import { identifyWhite2Rom } from '../multiplayer/games/white2Rom'
import { White2LiveStateAdapter } from '../multiplayer/games/White2LiveStateAdapter'
import { White2WorldPositionReader } from '../multiplayer/games/White2WorldPositionReader'
import { multiplayerGames } from '../multiplayer/games/registry'
import { BroadcastChannelTransport } from '../multiplayer/transports/BroadcastChannelTransport'
import type { GameId } from '../types'
import '../styles/my-runs.css'
import '../styles/multiplayer-session.css'

interface Props { onHome: () => void; onMyRuns: () => void; onSettings: () => void }

export function MultiplayerScreen({ onHome, onMyRuns, onSettings }: Props) {
  const session = useMemo(() => new LocalMultiplayerSession(new BroadcastChannelTransport()), [])
  const [state, setState] = useState<MultiplayerSessionSnapshot>({ connection: 'connecting', room: null, error: null, localRom: null, remoteStates: {} })
  const [selectedGameId, setSelectedGameId] = useState<GameId | null>(null)
  const [joinCode, setJoinCode] = useState('')
  useEffect(() => { const unsubscribe = session.subscribe(setState); session.connect(); return () => { unsubscribe() } }, [session])
  useEffect(() => () => session.dispose(), [session])
  const selectedGame = selectedGameId ? gameById[selectedGameId] : null
  const roomGame = state.room ? gameById[state.room.gameId] : null
  const right = <><button className="text-action" onClick={onMyRuns}>MY RUNS</button><button className="text-action" onClick={onSettings}>SETTINGS</button></>

  if (state.room?.gameStart && roomGame && state.localRom) return <MultiplayerGame roomGame={roomGame} session={session} state={state} onHome={onHome} right={right}/>
  if (state.room && roomGame) return <Lobby roomGame={roomGame} session={session} state={state} onHome={onHome} right={right}/>
  if (selectedGame) return <Setup gameId={selectedGame.id} title={selectedGame.title} joinCode={joinCode} setJoinCode={setJoinCode} onCreate={() => session.create(selectedGame.id)} onJoin={() => session.join(joinCode)} error={state.error} onBack={() => setSelectedGameId(null)} onHome={onHome} right={right}/>
  return <Picker games={multiplayerGames.map(definition => ({ definition, game: gameById[definition.gameId] }))} connection={state.connection} onSelect={setSelectedGameId} onHome={onHome} right={right}/>
}

function Lobby({ roomGame, session, state, onHome, right }: { roomGame: typeof gameById[GameId]; session: LocalMultiplayerSession; state: MultiplayerSessionSnapshot; onHome: () => void; right: React.ReactNode }) {
  const picker = useRef<HTMLInputElement>(null)
  const [loading, setLoading] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedGames, setSavedGames] = useState<MultiplayerSaveProfile[]>(() => multiplayerSaveStore.list(roomGame.id))
  const room = state.room!
  const localId = session.localPlayerId
  const currentPlayer = room.players.find(player => player.id === localId)
  const host = room.hostId === localId

  useEffect(() => setSavedGames(multiplayerSaveStore.list(roomGame.id)), [roomGame.id])
  const refreshSavedGames = () => setSavedGames(multiplayerSaveStore.list(roomGame.id))

  async function selectRom(file: File | null) {
    if (!file) return
    try {
      setLoading(true); setSaveError(null)
      const rom = await loadRomFile(file, roomGame)
      const identity = identifyWhite2Rom(rom)
      const profile = identity.status === 'verified' ? multiplayerSaveStore.create(roomGame.id, rom, identity) : null
      session.setLocalRom({ gameId: roomGame.id, rom, identity, saveProfileId: profile?.id })
      refreshSavedGames()
    } catch (error) {
      console.error('Could not load multiplayer ROM.', error)
      setSaveError(error instanceof Error ? error.message.toUpperCase() : 'COULD NOT LOAD MULTIPLAYER ROM.')
    } finally { setLoading(false); if (picker.current) picker.current.value = '' }
  }

  async function continueSavedGame(profile: MultiplayerSaveProfile) {
    try {
      setLoading(true); setSaveError(null)
      const rom = await multiplayerSaveStore.restoreRom(profile.id)
      if (!rom) throw new Error('The saved ROM data is unavailable on this browser. Select the ROM file again to create a new local save.')
      const identity = identifyWhite2Rom(rom)
      if (identity.status !== 'verified' || identity.sha256 !== profile.romSha256) throw new Error('The saved ROM fingerprint no longer matches this save profile.')
      session.setLocalRom({ gameId: roomGame.id, rom, identity, saveProfileId: profile.id })
    } catch (error) {
      console.error('Could not continue multiplayer save.', error)
      setSaveError(error instanceof Error ? error.message.toUpperCase() : 'COULD NOT CONTINUE SAVED GAME.')
    } finally { setLoading(false) }
  }

  return <main className="screen home-screen"><div className="home-sky" aria-hidden="true"><div className="home-water"/><div className="home-grass"/></div><div className="screen-shell">
    <AppHeader onHome={onHome} right={right}/>
    <section className="page-title-row"><div><span className="eyebrow">MULTIPLAYER • {state.connection.toUpperCase()}</span><h1>{roomGame.title.toUpperCase()}</h1><p>Each player supplies their own local ROM or continues a saved game. ROM and save bytes never leave this browser.</p></div><PixelButton tone="ghost" onClick={() => session.leave()}>LEAVE ROOM</PixelButton></section>
    <section className="multiplayer-lobby pixel-border"><div className="lobby-room-code"><span>ROOM</span><strong>{room.code}</strong><small>Share this code with the second browser tab.</small></div>
      <div className="lobby-players">{room.players.map((player, index) => <div className="lobby-player" key={player.id}><span>PLAYER {index + 1}{player.id === localId ? ' • YOU' : ''}</span><strong>{player.id === localId ? 'YOU' : player.label}</strong><RomStatus player={player} compatible={room.players.length === 2 && room.players.every(candidate => candidate.rom.sha256 === player.rom.sha256 && candidate.rom.status === 'verified')}/><b className={player.ready ? 'ready' : ''}>{player.ready ? 'READY' : 'NOT READY'}</b></div>)}{room.players.length < 2 && <div className="lobby-player waiting"><span>PLAYER 2</span><strong>WAITING FOR PLAYER</strong><b>OPEN ANOTHER TAB</b></div>}</div>
      <div className="lobby-actions"><input ref={picker} type="file" accept=".nds" hidden onChange={event => void selectRom(event.target.files?.[0] ?? null)}/><PixelButton tone="ghost" disabled={loading} onClick={() => picker.current?.click()}>{loading ? 'LOADING...' : state.localRom ? 'START ANOTHER LOCAL SAVE' : 'SELECT WHITE 2 ROM'}</PixelButton><PixelButton disabled={!session.canReady} onClick={() => session.toggleReady()}>{currentPlayer?.ready ? 'NOT READY' : 'READY'}</PixelButton>{host && <PixelButton disabled={!session.canStart} onClick={() => session.startGame()}>START GAME</PixelButton>}<span>{room.players.length}/2 PLAYERS • {host ? 'HOST' : 'GUEST'}</span></div>
      {saveError && <p className="form-error">{saveError}</p>}
      {room.players.length === 2 && !session.canReady && <p className="form-error">ROM MISMATCH OR MISSING: BOTH PLAYERS NEED THE SAME VERIFIED WHITE 2 SHA-256.</p>}
    </section>

    <section className="page-title-row"><div><span className="eyebrow">LOCAL ONLY</span><h2>SAVED GAMES</h2><p>Continue a multiplayer cartridge save without re-selecting the ROM. In-game saves are stored locally in this browser.</p></div><span className="save-count">{savedGames.length} SAVED</span></section>
    {savedGames.length === 0 ? <section className="runs-empty pixel-border"><h2>NO SAVED GAMES YET</h2><p>Select your White 2 ROM above. PokéRun will create a local save slot and persist the game's normal in-game save when you save from the Pokémon menu.</p></section> : <section className="runs-list">{savedGames.map(profile => <article className="run-card pixel-border" key={profile.id}><div className="run-card-main"><span className="eyebrow">{roomGame.title.toUpperCase()}</span><h2>SAVE {String(profile.slotNumber).padStart(3, '0')}</h2><div className="run-card-meta"><span>{profile.lastSavedAt ? `IN-GAME SAVE • ${new Date(profile.lastSavedAt).toLocaleString()}` : 'NO IN-GAME SAVE YET'}</span><span>{profile.fileName}</span><span>SHA {profile.romSha256.slice(0, 12)}…</span></div></div><div className="run-card-actions"><PixelButton disabled={loading} onClick={() => void continueSavedGame(profile)}>CONTINUE</PixelButton></div></article>)}</section>}
  </div></main>
}

function RomStatus({ player, compatible }: { player: MultiplayerSessionSnapshot['room'] extends infer _ ? import('../multiplayer/core/protocol').MultiplayerPlayer : never; compatible: boolean }) {
  if (player.rom.status === 'missing') return <small>ROM NOT SELECTED</small>
  if (player.rom.status === 'unsupported') return <small className="form-error">UNSUPPORTED ROM • {player.rom.title || 'UNKNOWN HEADER'} {player.rom.gameCode || ''}</small>
  return <small>ROM VERIFIED • {player.rom.fileName}<br/>SHA: {player.rom.sha256?.slice(0, 12)}… {compatible ? '• COMPATIBLE' : ''}</small>
}

function MultiplayerGame({ roomGame, session, state, onHome, right }: { roomGame: typeof gameById[GameId]; session: LocalMultiplayerSession; state: MultiplayerSessionSnapshot; onHome: () => void; right: React.ReactNode }) {
  const room = state.room!
  const localPlayer = room.players.find(player => player.id === session.localPlayerId)
  const localIndex = Math.max(0, room.players.findIndex(player => player.id === session.localPlayerId))
  const remote = room.players.find(player => player.id !== session.localPlayerId)
  const remoteIndex = Math.max(0, room.players.findIndex(player => player.id !== session.localPlayerId))
  const remoteState = remote ? state.remoteStates[remote.id] : null
  const [bridge, setBridge] = useState<MelonDsBridge | null>(null)
  const [localState, setLocalState] = useState<MultiplayerPlayerState | null>(null)
  const [liveStateError, setLiveStateError] = useState<string | null>(null)
  const [batterySave, setBatterySave] = useState<Uint8Array | null>(null)
  const [batteryReady, setBatteryReady] = useState(false)
  const [saveStatus, setSaveStatus] = useState('WAITING FOR IN-GAME SAVE')
  const localRomIdentity = state.localRom!.identity
  const saveProfileId = state.localRom!.saveProfileId
  useEffect(() => {
    let cancelled = false
    setBatteryReady(false)
    setBatterySave(null)
    if (!saveProfileId) { setBatteryReady(true); return () => { cancelled = true } }
    void multiplayerSaveStore.loadBatterySave(saveProfileId).then(save => {
      if (cancelled) return
      setBatterySave(save)
      setSaveStatus(save ? 'RESTORED LOCAL IN-GAME SAVE' : 'NO PRIOR IN-GAME SAVE — SAVE NORMALLY IN POKÉMON')
      setBatteryReady(true)
    })
    return () => { cancelled = true }
  }, [saveProfileId])

  const persistBatterySave = useCallback(async (save: Uint8Array) => {
    if (!saveProfileId) return
    try {
      await multiplayerSaveStore.saveBatterySave(saveProfileId, save)
      setSaveStatus(`SAVED LOCALLY • ${new Date().toLocaleTimeString()}`)
    } catch (error) {
      console.error('Could not persist multiplayer battery save.', error)
      setSaveStatus('LOCAL SAVE FAILED')
    }
  }, [saveProfileId])

  useEffect(() => {
    if (!bridge) {
      setLocalState(null)
      setLiveStateError(null)
      return
    }
    if (!White2LiveStateAdapter.supportsRom(localRomIdentity)) {
      setLocalState(null)
      setLiveStateError('LIVE STATE IS NOT ENABLED FOR THIS WHITE 2 ROM FINGERPRINT.')
      return
    }

    const adapter = new White2LiveStateAdapter(bridge)
    const worldReader = new White2WorldPositionReader(bridge)
    let cancelled = false
    let reading = false
    let lastPublished = ''
    let lastPanelKey = ''

    async function poll() {
      if (cancelled || reading) return
      reading = true
      try {
        const [live, worldPosition] = await Promise.all([adapter.read(), worldReader.read()])
        if (cancelled) return
        const normalized: MultiplayerPlayerState = { location: live.location, x: live.x, y: live.y, direction: live.direction, worldPosition }
        const panelKey = `${normalized.location.mapId}:${normalized.x}:${normalized.y}:${normalized.direction}`
        if (panelKey !== lastPanelKey) {
          lastPanelKey = panelKey
          setLocalState(normalized)
        }
        setLiveStateError(null)
        const key = `${panelKey}:${worldPosition.x}:${worldPosition.y}:${worldPosition.z}`
        if (key !== lastPublished) {
          lastPublished = key
          session.publishGameState(normalized)
        }
      } catch (reason) {
        if (!cancelled) setLiveStateError(reason instanceof Error ? reason.message.toUpperCase() : 'WHITE 2 LIVE STATE READ FAILED.')
      } finally { reading = false }
    }

    void poll()
    const timer = window.setInterval(() => void poll(), 40)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [bridge, localRomIdentity, session])

  const remoteDifferentMap = Boolean(localState && remoteState && localState.location.mapId !== remoteState.location.mapId)
  const relation: 'together' | 'apart' | 'waiting' = !localState || !remoteState ? 'waiting' : remoteDifferentMap ? 'apart' : 'together'
  const localLabel = localPlayer?.label && localPlayer.label !== 'PLAYER' ? localPlayer.label : 'YOU'
  const remoteLabel = remote?.label && remote.label !== 'PLAYER' ? remote.label : 'PARTNER'

  return <main className="screen themed-screen active-run" style={{ '--theme-sky': roomGame.theme.sky, '--theme-sky-soft': roomGame.theme.skySoft, '--theme-accent': roomGame.theme.accent, '--theme-accent-dark': roomGame.theme.accentDark, '--theme-ground': roomGame.theme.ground, '--theme-water': roomGame.theme.water } as React.CSSProperties}>
    <div className="screen-shell">
      <AppHeader onHome={onHome} right={right}/>
      <section className="page-title-row"><div><span className="eyebrow">MULTIPLAYER SESSION • {room.gameStart!.startId.slice(0, 8)}</span><h1>{roomGame.title.toUpperCase()}</h1><p>Both players keep independent saves. Live position is shared between the two games; party and gym reads are the next adapter fields.</p><span className={saveStatus === 'LOCAL SAVE FAILED' ? 'form-error' : 'memory-ok'}>{saveStatus}</span></div><PixelButton tone="ghost" onClick={() => session.leave()}>LEAVE SESSION</PixelButton></section>

      <section className="multiplayer-play-layout">
        <MultiplayerPlayerPanel playerLabel={localLabel} roleLabel={`PLAYER ${localIndex + 1} • YOU`} state={localState} relation={relation} error={liveStateError}/>
        <div className="multiplayer-emulator-center"><section className="emulator-column">{batteryReady ? <MelonDsPlayer game={roomGame} rom={state.localRom!.rom} onBridgeReady={setBridge} saveKey={saveProfileId ?? session.localPlayerId} batterySave={batterySave} onBatterySave={persistBatterySave}/> : <section className="runs-empty pixel-border"><h2>RESTORING LOCAL SAVE...</h2></section>}</section></div>
        <MultiplayerPlayerPanel playerLabel={remoteLabel} roleLabel={`PLAYER ${remoteIndex + 1} • PARTNER`} state={remoteState} relation={relation}/>
      </section>

      {import.meta.env.DEV && <><White2MemoryResearchPanel bridge={bridge} rom={localRomIdentity}/><section className="multiplayer-debug multiplayer-session-debug pixel-border"><h2>PLAYER STATE DEBUG</h2><div><strong>LOCAL</strong>{localState ? <span>MAP {localState.location.mapId} • X {localState.x} • Y {localState.y} • {localState.direction.toUpperCase()}</span> : liveStateError ? <span className="form-error">{liveStateError}</span> : <span>WAITING FOR WHITE 2 LIVE STATE</span>}</div><div><strong>REMOTE</strong>{remoteState ? <span>MAP {remoteState.location.mapId} • X {remoteState.x} • Y {remoteState.y} • {remoteState.direction.toUpperCase()}{remoteDifferentMap ? ' • DIFFERENT LOCATION' : ''}</span> : <span>NO REMOTE STATE YET</span>}</div></section></>}
    </div>
  </main>
}

function Setup({ gameId, title, joinCode, setJoinCode, onCreate, onJoin, error, onBack, onHome, right }: { gameId: GameId; title: string; joinCode: string; setJoinCode: (code: string) => void; onCreate: () => void; onJoin: () => void; error: string | null; onBack: () => void; onHome: () => void; right: React.ReactNode }) { return <main className="screen home-screen"><div className="home-sky" aria-hidden="true"><div className="home-water"/><div className="home-grass"/></div><div className="screen-shell"><AppHeader onHome={onHome} right={right}/><section className="page-title-row"><div><span className="eyebrow">MULTIPLAYER • EXPERIMENTAL</span><h1>{title.toUpperCase()}</h1><p>Create a local room or enter a room code from another tab.</p></div><PixelButton tone="ghost" onClick={onBack}>BACK</PixelButton></section><section className="multiplayer-setup pixel-border"><article><h2>CREATE ROOM</h2><p>Start a two-player local test room. Nothing is sent outside this browser profile.</p><PixelButton onClick={onCreate}>CREATE ROOM</PixelButton></article><article><h2>JOIN ROOM</h2><p>Enter the six-character code from the host tab.</p><div className="join-row"><input aria-label="Room code" value={joinCode} maxLength={6} onChange={event => setJoinCode(event.target.value.toUpperCase())} placeholder="ABCD12"/><PixelButton onClick={onJoin}>JOIN</PixelButton></div>{error && <span className="form-error">{error}</span>}</article></section></div></main> }
function Picker({ games, connection, onSelect, onHome, right }: { games: { definition: typeof multiplayerGames[number]; game: typeof gameById[GameId] }[]; connection: string; onSelect: (id: GameId) => void; onHome: () => void; right: React.ReactNode }) { return <main className="screen home-screen"><div className="home-sky" aria-hidden="true"><div className="home-water"/><div className="home-grass"/></div><div className="screen-shell"><AppHeader onHome={onHome} right={right}/><section className="page-title-row"><div><h1>CHOOSE A GAME TO PLAY TOGETHER</h1><p>Experimental local multiplayer is available for games registered below.</p></div><span className="save-count">{connection.toUpperCase()}</span></section><section className="game-library pixel-border"><div className="generation-row"><div className="generation-label"><strong>GEN 5</strong><span>EXPERIMENTAL</span></div><div className="game-grid" style={{ '--count': games.length } as React.CSSProperties}>{games.map(({ definition, game }) => <button className="game-tile themed-game-tile pixel-border" style={{ '--tile-accent': game.theme.accent, '--tile-accent-dark': game.theme.accentDark, '--tile-soft': game.theme.skySoft } as React.CSSProperties} key={game.id} onClick={() => onSelect(game.id)}><span className="game-generation">GEN {game.generation} • {game.platform}</span><strong>{game.shortTitle}</strong><span className="run-status experimental">{definition.status.toUpperCase()} • {definition.maxPlayers} PLAYERS</span></button>)}</div></div></section></div></main> }