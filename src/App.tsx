import { useEffect, useMemo, useState } from 'react'
import type { LoadedRom } from './core/rom/RomLoader'
import { romSessionStore } from './core/rom/RomSessionStore'
import { gameById } from './data/games'
import { ActiveRunScreen } from './screens/ActiveRunScreen'
import { HomeScreen } from './screens/HomeScreen'
import { MyRunsScreen } from './screens/MyRunsScreen'
import { MultiplayerScreen } from './screens/MultiplayerScreen'
import { NewRunScreen } from './screens/NewRunScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { createRun, loadRuns, saveRuns } from './store/runStore'
import type { GameDefinition, RunSettings, RunState } from './types'

export default function App() {
  const [runs, setRuns] = useState<RunState[]>(loadRuns)
  const [selectedGame, setSelectedGame] = useState<GameDefinition | null>(null)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [showMyRuns, setShowMyRuns] = useState(false)
  const [showMultiplayer, setShowMultiplayer] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const activeRun = useMemo(() => runs.find(run => run.id === activeRunId) ?? null, [runs, activeRunId])

  useEffect(() => saveRuns(runs), [runs])

  function chooseGame(game: GameDefinition) {
    setShowSettings(false)
    setShowMyRuns(false)
    setShowMultiplayer(false)
    setSelectedGame(game)
    setActiveRunId(null)
  }

  function openRun(run: RunState) {
    setShowSettings(false)
    setShowMyRuns(false)
    setShowMultiplayer(false)
    setSelectedGame(gameById[run.gameId])
    setActiveRunId(run.id)
  }

  function goHome() {
    setShowSettings(false)
    setShowMyRuns(false)
    setShowMultiplayer(false)
    setSelectedGame(null)
    setActiveRunId(null)
  }

  function openMyRuns() {
    setShowSettings(false)
    setSelectedGame(null)
    setActiveRunId(null)
    setShowMyRuns(true)
    setShowMultiplayer(false)
  }

  function openMultiplayer() {
    setShowSettings(false)
    setShowMyRuns(false)
    setSelectedGame(null)
    setActiveRunId(null)
    setShowMultiplayer(true)
  }

  function openSettings() {
    setShowSettings(true)
  }

  function closeSettings() {
    setShowSettings(false)
  }

  function startRun(runType: RunState['runType'], settings: RunSettings, seed: string, rom: LoadedRom) {
    if (!selectedGame) return
    const run = createRun(selectedGame.id, runType, settings, seed, rom)
    romSessionStore.set(run.id, rom)
    setRuns(current => [...current, run])
    setActiveRunId(run.id)
  }

  if (showSettings) {
    return <SettingsScreen onBack={closeSettings} onHome={goHome} onMyRuns={openMyRuns} />
  }

  if (showMyRuns) {
    return <MyRunsScreen
      runs={runs}
      onHome={goHome}
      onOpenRun={openRun}
      onNewRun={chooseGame}
      onSettings={openSettings}
    />
  }

  if (showMultiplayer) {
    return <MultiplayerScreen onHome={goHome} onMyRuns={openMyRuns} onSettings={openSettings} />
  }

  if (!selectedGame) {
    return <HomeScreen
      runs={runs}
      onChooseGame={chooseGame}
      onMultiplayer={openMultiplayer}
      onMyRuns={openMyRuns}
      onSettings={openSettings}
    />
  }

  if (activeRun) {
    return <ActiveRunScreen
      game={gameById[activeRun.gameId]}
      run={activeRun}
      onHome={goHome}
      onMyRuns={openMyRuns}
      onSettings={openSettings}
      onChange={updated => setRuns(current => current.map(run => run.id === updated.id ? updated : run))}
    />
  }

  return <NewRunScreen
    game={selectedGame}
    onHome={goHome}
    onSettings={openSettings}
    onStart={startRun}
  />
}
