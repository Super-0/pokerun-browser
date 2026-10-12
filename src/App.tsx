import { useEffect, useMemo, useState } from 'react'
import type { LoadedRom } from './core/rom/RomLoader'
import { romSessionStore } from './core/rom/RomSessionStore'
import { gameById } from './data/games'
import { ActiveRunScreen } from './screens/ActiveRunScreen'
import { HomeScreen } from './screens/HomeScreen'
import { NewRunScreen } from './screens/NewRunScreen'
import { createRun, loadRuns, saveRuns } from './store/runStore'
import type { GameDefinition, RunSettings, RunState } from './types'

export default function App() {
  const [runs, setRuns] = useState<RunState[]>(loadRuns)
  const [selectedGame, setSelectedGame] = useState<GameDefinition | null>(null)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const activeRun = useMemo(() => runs.find(run => run.id === activeRunId) ?? null, [runs, activeRunId])

  useEffect(() => saveRuns(runs), [runs])

  function chooseGame(game: GameDefinition) {
    const existing = runs.filter(run => run.gameId === game.id).at(-1)
    setSelectedGame(game)
    if (existing) setActiveRunId(existing.id)
  }

  function goHome() {
    setSelectedGame(null)
    setActiveRunId(null)
  }

  function startRun(runType: RunState['runType'], settings: RunSettings, seed: string, rom: LoadedRom) {
    if (!selectedGame) return
    const run = createRun(selectedGame.id, runType, settings, seed, rom)
    romSessionStore.set(run.id, rom)
    setRuns(current => [...current, run])
    setActiveRunId(run.id)
  }

  if (!selectedGame) return <HomeScreen runs={runs} onChooseGame={chooseGame} />

  if (activeRun) {
    return <ActiveRunScreen
      game={gameById[activeRun.gameId]}
      run={activeRun}
      onHome={goHome}
      onChange={updated => setRuns(current => current.map(run => run.id === updated.id ? updated : run))}
    />
  }

  return <NewRunScreen
    game={selectedGame}
    onHome={goHome}
    onStart={startRun}
  />
}
