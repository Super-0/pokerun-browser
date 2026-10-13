import { useEffect, useRef, useState } from 'react'
import type { mGBAEmulator } from '@thenick775/mgba-wasm'
import { EmeraldLiveStateReader, type EmeraldLiveSnapshot } from '../core/game/emerald/EmeraldLiveState'
import { hasDevelopmentRom, loadDevelopmentRom } from '../core/rom/DevRomLoader'
import { romSessionStore } from '../core/rom/RomSessionStore'
import type { GameDefinition, RunState } from '../types'

type PlayerStatus = 'booting' | 'running' | 'error'

type DebuggableMgba = mGBAEmulator & {
  HEAPU8?: Uint8Array
  wasmMemory?: WebAssembly.Memory
}

interface Props {
  game: GameDefinition
  run: RunState
  onLiveState?: (snapshot: EmeraldLiveSnapshot | null) => void
}

const blockedKeys = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Backspace',
])

function getMemoryDiagnostic(emulator: mGBAEmulator) {
  const module = emulator as DebuggableMgba

  let heapText = 'missing'
  try {
    const heap = module.HEAPU8
    heapText = heap ? `${heap.byteLength}B` : 'missing'
  } catch (error) {
    heapText = `error:${error instanceof Error ? error.name : 'unknown'}`
  }

  let memoryText = 'missing'
  try {
    const memory = module.wasmMemory
    memoryText = memory?.buffer ? `${memory.buffer.byteLength}B` : 'missing'
  } catch (error) {
    memoryText = `error:${error instanceof Error ? error.name : 'unknown'}`
  }

  const heapOwn = Object.prototype.hasOwnProperty.call(module, 'HEAPU8') ? 'own' : 'no-own'
  const memoryOwn = Object.prototype.hasOwnProperty.call(module, 'wasmMemory') ? 'own' : 'no-own'

  return `U8=${heapText}/${heapOwn} • MEM=${memoryText}/${memoryOwn}`
}

export function MgbaPlayer({ game, run, onLiveState }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const emulatorRef = useRef<mGBAEmulator | null>(null)
  const [status, setStatus] = useState<PlayerStatus>('booting')
  const [statusText, setStatusText] = useState('INITIALIZING mGBA...')
  const [paused, setPaused] = useState(false)
  const [muted, setMuted] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [liveStateStatus, setLiveStateStatus] = useState(game.id === 'emerald' ? 'SEARCHING RAM 0%' : 'UNSUPPORTED')

  useEffect(() => {
    function preventBrowserNavigation(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      if (blockedKeys.has(event.key)) event.preventDefault()
    }

    window.addEventListener('keydown', preventBrowserNavigation, { passive: false })
    return () => window.removeEventListener('keydown', preventBrowserNavigation)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false
    let emulator: mGBAEmulator | null = null
    let saveSyncTimer: number | undefined
    let liveStateTimer: number | undefined
    let lastLiveStateKey = ''

    async function boot() {
      try {
        setStatus('booting')
        setStatusText('CHECKING RUNTIME...')
        setLiveStateStatus(game.id === 'emerald' ? 'SEARCHING RAM 0%' : 'UNSUPPORTED')
        onLiveState?.(null)

        if (!window.crossOriginIsolated) {
          throw new Error('mGBA needs cross-origin isolation. Restart the Vite server after pulling the new vite.config.ts.')
        }

        let rom = romSessionStore.get(run.id) ?? await romSessionStore.restore(run.id)
        if (!rom && import.meta.env.DEV && hasDevelopmentRom(game)) {
          rom = await loadDevelopmentRom(game)
          if (rom) romSessionStore.set(run.id, rom)
        }

        if (!rom) {
          throw new Error('This run does not have a ROM saved on this device. Choose the ROM again to continue.')
        }

        setStatusText('LOADING mGBA WASM...')
        const { default: createMgba } = await import('@thenick775/mgba-wasm')
        if (cancelled) return

        emulator = await createMgba({ canvas: canvas! })
        if (cancelled) {
          emulator.quitMgba()
          return
        }

        emulatorRef.current = emulator
        await emulator.FSInit()
        if (cancelled) return

        emulator.setCoreSettings({
          autoSaveStateEnable: false,
          restoreAutoSaveStateOnLoad: false,
          showFpsCounter: false,
        })

        emulator.setLogger(entry => {
          if (entry.level === 'FATAL' || entry.level === 'ERROR') {
            console.error(`[mGBA ${entry.category}] ${entry.message}`)
          }
        })

        emulator.addCoreCallbacks({
          saveDataUpdatedCallback: () => {
            window.clearTimeout(saveSyncTimer)
            saveSyncTimer = window.setTimeout(() => {
              void emulator?.FSSync().catch(error => console.error('Could not persist mGBA save data.', error))
            }, 750)
          },
        })

        setStatusText('LOADING ROM...')
        const copy = new Uint8Array(rom.bytes.byteLength)
        copy.set(rom.bytes)
        const runtimeFileName = `pokerun-${run.id}${rom.extension}`
        const romFile = new File([copy.buffer], runtimeFileName, { type: 'application/octet-stream' })

        await new Promise<void>(resolve => emulator?.uploadRom(romFile, resolve))
        if (cancelled || !emulator) return

        const paths = emulator.filePaths()
        const romPath = `${paths.gamePath}/${runtimeFileName}`
        const savePath = `${paths.savePath}/${run.id}.sav`

        if (!emulator.loadGame(romPath, savePath)) {
          throw new Error('mGBA could not boot this ROM.')
        }

        emulator.setVolume(1)
        setStatus('running')
        setStatusText(`${emulator.version.projectName} ${emulator.version.projectVersion}`)

        if (game.id === 'emerald') {
          const liveReader = new EmeraldLiveStateReader(emulator)
          const pollLiveState = () => {
            if (cancelled || !emulator) return
            const snapshot = liveReader.readSnapshot()

            if (!snapshot) {
              const diagnostic = liveReader.getDiagnostic()
              setLiveStateStatus(
                diagnostic === 'WASM HEAP UNAVAILABLE'
                  ? `${diagnostic} • ${getMemoryDiagnostic(emulator)}`
                  : diagnostic,
              )
              return
            }

            setLiveStateStatus('CONNECTED')
            const nextKey = JSON.stringify([
              snapshot.mapGroup,
              snapshot.mapNum,
              snapshot.party.map(member => [member.id, member.level, member.hp, member.maxHp, member.status]),
            ])

            if (nextKey !== lastLiveStateKey) {
              lastLiveStateKey = nextKey
              onLiveState?.(snapshot)
            }
          }

          pollLiveState()
          liveStateTimer = window.setInterval(pollLiveState, 200)
        }
      } catch (error) {
        if (cancelled) return
        console.error(error)
        setStatus('error')
        setStatusText(error instanceof Error ? error.message : 'mGBA failed to start.')
      }
    }

    void boot()

    return () => {
      cancelled = true
      window.clearTimeout(saveSyncTimer)
      window.clearInterval(liveStateTimer)
      emulatorRef.current = null
      onLiveState?.(null)

      if (!emulator) return

      try {
        emulator.pauseGame()
      } catch {
        // The core may already be stopped during a failed initialization.
      }

      void emulator.FSSync()
        .catch(error => console.error('Could not flush mGBA save data.', error))
        .finally(() => {
          try { emulator?.quitGame() } catch { /* already stopped */ }
          try { emulator?.quitMgba() } catch { /* already stopped */ }
        })
    }
  }, [game, onLiveState, run.id])

  function togglePause() {
    const emulator = emulatorRef.current
    if (!emulator || status !== 'running') return

    if (paused) {
      emulator.resumeGame()
      if (muted) emulator.pauseAudio()
    } else {
      emulator.pauseGame()
      void emulator.FSSync().catch(error => console.error('Could not persist mGBA save data.', error))
    }
    setPaused(value => !value)
  }

  function toggleAudio() {
    const emulator = emulatorRef.current
    if (!emulator || status !== 'running') return

    if (muted) emulator.resumeAudio()
    else emulator.pauseAudio()
    setMuted(value => !value)
  }

  function cycleSpeed() {
    const emulator = emulatorRef.current
    if (!emulator || status !== 'running') return

    const next = speed === 1 ? 2 : speed === 2 ? 4 : 1
    emulator.setFastForwardMultiplier(next)
    setSpeed(next)
  }

  function enterFullscreen() {
    void frameRef.current?.requestFullscreen().catch(() => undefined)
  }

  const ready = status === 'running'

  return (
    <div className="mgba-player">
      <div className="emulator-toolbar pixel-border">
        <strong>mGBA</strong>
        <button disabled={!ready} onClick={cycleSpeed}>{speed}×</button>
        <button disabled={!ready} onClick={togglePause}>{paused ? 'RESUME' : 'PAUSE'}</button>
        <button disabled={!ready} onClick={toggleAudio}>{muted ? 'UNMUTE' : 'AUDIO'}</button>
        <button onClick={enterFullscreen}>FULLSCREEN</button>
      </div>

      <div ref={frameRef} className="mgba-frame pixel-border">
        <canvas ref={canvasRef} className="mgba-canvas" width={240} height={160} />
        {status !== 'running' && (
          <div className={`mgba-status ${status === 'error' ? 'error' : ''}`}>
            <strong>{status === 'error' ? 'EMULATOR ERROR' : 'BOOTING'}</strong>
            <span>{statusText}</span>
          </div>
        )}
      </div>

      <div className="mgba-meta pixel-border">
        <span>{status === 'running' ? `READY • ${statusText}` : statusText}</span>
        <span>ARROWS MOVE • X=A • Z=B • ENTER=START • BACKSPACE=SELECT • A/S=L/R</span>
        <span>BATTERY SAVE: AUTO</span>
        {game.id === 'emerald' && <span>LIVE STATE: {liveStateStatus}</span>}
      </div>
    </div>
  )
}
