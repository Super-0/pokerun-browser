import { useEffect, useRef, useState } from 'react'
import { MelonDsBridge, type DsButton } from '../core/emulator/melonds/MelonDsBridge'
import { romSessionStore } from '../core/rom/RomSessionStore'
import type { LoadedRom } from '../core/rom/RomLoader'
import type { GameDefinition, RunState } from '../types'

type PlayerStatus = 'booting' | 'running' | 'error'

interface Props { game: GameDefinition; run?: RunState; rom?: LoadedRom }

const keys: Record<string, DsButton> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyX: 'a', KeyZ: 'b', KeyS: 'x', KeyA: 'y', KeyQ: 'l', KeyW: 'r',
  Enter: 'start', ShiftRight: 'select',
}

function formatBytes(bytes: Uint8Array) {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0').toUpperCase()).join(' ')
}

/** React shell only: frame rendering and emulated-memory access stay inside MelonDsBridge. */
export function MelonDsPlayer({ game, run, rom: suppliedRom }: Props) {
  const topRef = useRef<HTMLCanvasElement>(null)
  const bottomRef = useRef<HTMLCanvasElement>(null)
  const bridgeRef = useRef<MelonDsBridge | null>(null)
  const [status, setStatus] = useState<PlayerStatus>('booting')
  const [statusText, setStatusText] = useState('INITIALIZING melonDS...')
  const [paused, setPaused] = useState(false)
  const [memoryText, setMemoryText] = useState('NOT READ')

  useEffect(() => {
    const top = topRef.current
    const bottom = bottomRef.current
    if (!top || !bottom) return
    let cancelled = false
    const bridge = new MelonDsBridge()
    bridgeRef.current = bridge

    const onKey = (event: KeyboardEvent, pressed: boolean) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      const button = keys[event.code]
      if (!button) return
      event.preventDefault()
      bridge.press(button, pressed)
    }
    const keyDown = (event: KeyboardEvent) => onKey(event, true)
    const keyUp = (event: KeyboardEvent) => onKey(event, false)
    window.addEventListener('keydown', keyDown, { passive: false })
    window.addEventListener('keyup', keyUp, { passive: false })

    async function boot() {
      try {
        setStatus('booting')
        setStatusText('RESTORING LOCAL ROM...')
        const rom = suppliedRom ?? (run ? romSessionStore.get(run.id) ?? await romSessionStore.restore(run.id) : null)
        if (!rom) throw new Error('This run does not have a ROM saved on this device. Choose the ROM again to continue.')
        if (rom.platform !== 'NDS' || rom.extension.toLowerCase() !== '.nds') throw new Error('melonDS needs a valid .nds ROM for this run.')
        if (cancelled) return
        bridge.attachScreens(top!, bottom!)
        setStatusText('LOADING melonDS WASM...')
        await bridge.loadRom(rom.bytes.slice().buffer)
        if (cancelled) return
        setStatusText('DIRECT-BOOTING ROM...')
        await bridge.start()
        if (cancelled) return
        setStatus('running')
        setStatusText(`READY • ${game.title.toUpperCase()}`)
      } catch (error) {
        if (!cancelled) {
          console.error('melonDS failed to boot.', error)
          setStatus('error')
          setStatusText(error instanceof Error ? error.message : 'melonDS failed to start.')
        }
      }
    }
    void boot()

    return () => {
      cancelled = true
      window.removeEventListener('keydown', keyDown)
      window.removeEventListener('keyup', keyUp)
      bridgeRef.current = null
      void bridge.dispose()
    }
  }, [game.title, run?.id, suppliedRom])

  const ready = status === 'running'
  async function togglePause() {
    const bridge = bridgeRef.current
    if (!bridge || !ready) return
    if (paused) await bridge.resume()
    else await bridge.pause()
    setPaused(value => !value)
  }
  async function inspectArm9() {
    try {
      const bytes = await bridgeRef.current?.readBytes(0x02000000, 16)
      setMemoryText(bytes ? `02000000: ${formatBytes(bytes)}` : 'EMULATOR UNAVAILABLE')
    } catch (error) {
      setMemoryText(error instanceof Error ? error.message.toUpperCase() : 'READ FAILED')
    }
  }

  return (
    <div className="melonds-player">
      <div className="emulator-toolbar pixel-border"><strong>melonDS</strong><button disabled={!ready} onClick={() => void togglePause()}>{paused ? 'RESUME' : 'PAUSE'}</button><span>DUAL SCREEN</span></div>
      <div className="melonds-stack pixel-border">
        <canvas ref={topRef} className="melonds-screen" width={256} height={192} aria-label="Nintendo DS top screen" />
        <canvas ref={bottomRef} className="melonds-screen touch" width={256} height={192} aria-label="Nintendo DS touch screen" onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); bridgeRef.current?.touch(event.clientX, event.clientY) }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) bridgeRef.current?.touch(event.clientX, event.clientY) }} onPointerUp={() => bridgeRef.current?.releaseTouch()} onPointerCancel={() => bridgeRef.current?.releaseTouch()} />
        {status !== 'running' && <div className={`melonds-status ${status === 'error' ? 'error' : ''}`}><strong>{status === 'error' ? 'EMULATOR ERROR' : 'BOOTING'}</strong><span>{statusText}</span></div>}
      </div>
      <div className="mgba-meta pixel-border"><span>{statusText}</span><span>ARROWS MOVE • X=A • Z=B • S=X • A=Y • Q/W=L/R • ENTER=START • RIGHT SHIFT=SELECT</span><span>TOUCH: BOTTOM SCREEN</span></div>
      {import.meta.env.DEV && <div className="melonds-debug pixel-border"><button disabled={!ready} onClick={() => void inspectArm9()}>READ ARM9 BUS</button><code>{memoryText}</code></div>}
    </div>
  )
}
