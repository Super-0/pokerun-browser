import { useEffect, useMemo, useState } from 'react'
import { AppHeader } from '../components/AppHeader'
import { PixelButton } from '../components/PixelButton'
import { LocalMultiplayerSession, type MultiplayerSessionSnapshot } from '../multiplayer/core/LocalMultiplayerSession'
import { multiplayerGames } from '../multiplayer/games/registry'
import { BroadcastChannelTransport } from '../multiplayer/transports/BroadcastChannelTransport'
import { gameById } from '../data/games'
import type { GameId } from '../types'

interface Props { onHome: () => void; onMyRuns: () => void; onSettings: () => void }

export function MultiplayerScreen({ onHome, onMyRuns, onSettings }: Props) {
  const session = useMemo(() => new LocalMultiplayerSession(new BroadcastChannelTransport()), [])
  const [state, setState] = useState<MultiplayerSessionSnapshot>({ connection: 'connecting', room: null, error: null })
  const [selectedGameId, setSelectedGameId] = useState<GameId | null>(null)
  const [joinCode, setJoinCode] = useState('')

  useEffect(() => { const unsubscribe = session.subscribe(setState); session.connect(); return () => unsubscribe() }, [session])
  useEffect(() => () => session.dispose(), [session])

  const selectedGame = selectedGameId ? gameById[selectedGameId] : null
  const roomGame = state.room ? gameById[state.room.gameId] : null
  const right = <><button className="text-action" onClick={onMyRuns}>MY RUNS</button><button className="text-action" onClick={onSettings}>SETTINGS</button></>

  if (state.room && roomGame) {
    const currentPlayer = state.room.players.find(player => player.id === sessionPlayerId())
    return <main className="screen home-screen"><div className="home-sky" aria-hidden="true"><div className="home-water"/><div className="home-grass"/></div><div className="screen-shell">
      <AppHeader onHome={onHome} right={right}/>
      <section className="page-title-row"><div><span className="eyebrow">MULTIPLAYER • {state.connection.toUpperCase()}</span><h1>{roomGame.title.toUpperCase()}</h1><p>Local two-tab room. Game emulation will connect here when melonDS is integrated.</p></div><PixelButton tone="ghost" onClick={() => session.leave()}>LEAVE ROOM</PixelButton></section>
      <section className="multiplayer-lobby pixel-border"><div className="lobby-room-code"><span>ROOM</span><strong>{state.room.code}</strong><small>Share this code with the second browser tab.</small></div><div className="lobby-players">{state.room.players.map((player, index) => <div className="lobby-player" key={player.id}><span>PLAYER {index + 1}</span><strong>{player.id === sessionPlayerId() ? 'YOU' : player.label}</strong><b className={player.ready ? 'ready' : ''}>{player.ready ? 'READY' : 'CONNECTED'}</b></div>)}{state.room.players.length < 2 && <div className="lobby-player waiting"><span>PLAYER 2</span><strong>WAITING FOR PLAYER</strong><b>OPEN ANOTHER TAB</b></div>}</div><div className="lobby-actions"><PixelButton onClick={() => session.toggleReady()}>{currentPlayer?.ready ? 'NOT READY' : 'READY'}</PixelButton><span>{state.room.players.length}/2 PLAYERS • LOCAL BROWSER TRANSPORT</span></div></section>
    </div></main>
  }

  if (selectedGame) return <main className="screen home-screen"><div className="home-sky" aria-hidden="true"><div className="home-water"/><div className="home-grass"/></div><div className="screen-shell">
    <AppHeader onHome={onHome} right={right}/><section className="page-title-row"><div><span className="eyebrow">MULTIPLAYER • EXPERIMENTAL</span><h1>{selectedGame.title.toUpperCase()}</h1><p>Create a local room or enter a room code from another tab.</p></div><PixelButton tone="ghost" onClick={() => setSelectedGameId(null)}>BACK</PixelButton></section>
    <section className="multiplayer-setup pixel-border"><article><h2>CREATE ROOM</h2><p>Start a two-player local test room. Nothing is sent outside this browser profile.</p><PixelButton onClick={() => session.create(selectedGame.id)}>CREATE ROOM</PixelButton></article><article><h2>JOIN ROOM</h2><p>Enter the six-character code from the host tab.</p><div className="join-row"><input aria-label="Room code" value={joinCode} maxLength={6} onChange={event => setJoinCode(event.target.value.toUpperCase())} placeholder="ABCD12"/><PixelButton onClick={() => session.join(joinCode)}>JOIN</PixelButton></div>{state.error && <span className="form-error">{state.error}</span>}</article></section>
  </div></main>

  return <main className="screen home-screen"><div className="home-sky" aria-hidden="true"><div className="home-water"/><div className="home-grass"/></div><div className="screen-shell">
    <AppHeader onHome={onHome} right={right}/><section className="page-title-row"><div><h1>CHOOSE A GAME TO PLAY TOGETHER</h1><p>Experimental local multiplayer is available for games registered below.</p></div><span className="save-count">{state.connection.toUpperCase()}</span></section>
    <section className="game-library pixel-border"><div className="generation-row"><div className="generation-label"><strong>GEN 5</strong><span>EXPERIMENTAL</span></div><div className="game-grid" style={{ '--count': multiplayerGames.length } as React.CSSProperties}>{multiplayerGames.map(definition => { const game = gameById[definition.gameId]; const style = { '--tile-accent': game.theme.accent, '--tile-accent-dark': game.theme.accentDark, '--tile-soft': game.theme.skySoft } as React.CSSProperties; return <button className="game-tile themed-game-tile pixel-border" style={style} key={game.id} onClick={() => setSelectedGameId(game.id)}><span className="game-generation">GEN {game.generation} • {game.platform}</span><strong>{game.shortTitle}</strong><span className="run-status experimental">{definition.status.toUpperCase()} • {definition.maxPlayers} PLAYERS</span></button> })}</div></div></section>
  </div></main>
}

function sessionPlayerId() { return sessionStorage.getItem('pokerun-multiplayer-player-id') ?? '' }
