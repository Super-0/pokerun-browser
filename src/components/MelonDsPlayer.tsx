import { useEffect, useRef, useState } from 'react'
import { MelonDsBridge, type DsButton, type DsSpeedMultiplier } from '../core/emulator/melonds/MelonDsBridge'
import { romSessionStore } from '../core/rom/RomSessionStore'
import type { LoadedRom } from '../core/rom/RomLoader'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../multiplayer/core/MultiplayerPresence'
import { TESTED_WHITE2_SHA256 } from '../multiplayer/games/White2LiveStateAdapter'
import { White2RemoteTrainerRuntime } from '../multiplayer/games/White2RemoteTrainerRuntime'
import type { GameDefinition, RunState } from '../types'

type PlayerStatus = 'booting' | 'running' | 'error'

type RuntimeSpeedStats = {
  bridgeSpeed: DsSpeedMultiplier
  processFramesPerSecond: number
}

export type DsPartnerMarker = {
  dx: number
  dy: number
  direction: 'north' | 'south' | 'east' | 'west'
  label?: string
}

interface Props {
  game: GameDefinition
  run?: RunState
  rom?: LoadedRom
  onBridgeReady?: (bridge: MelonDsBridge | null) => void
  saveKey?: string
  batterySave?: Uint8Array | null
  onBatterySave?: (save: Uint8Array) => void | Promise<void>
  partnerMarker?: DsPartnerMarker | null
}

const keys: Record<string, DsButton> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyX: 'a', KeyZ: 'b', KeyS: 'x', KeyA: 'y', KeyQ: 'l', KeyW: 'r',
  Enter: 'start', ShiftRight: 'select',
}

const SPEED_STORAGE_KEY = 'pokerun-melonds-speed'
const SPEED_OPTIONS: DsSpeedMultiplier[] = [1, 2, 4]
const directionGlyph = { north: '↑', south: '↓', east: '→', west: '←' } as const

function storedSpeed(): DsSpeedMultiplier {
  const value = Number(localStorage.getItem(SPEED_STORAGE_KEY))
  return value === 2 || value === 4 ? value : 1
}

function formatBytes(bytes: Uint8Array) {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0').toUpperCase()).join(' ')
}

function markerFromPresence(presence: MultiplayerPresenceSnapshot): DsPartnerMarker | null {
  const local = presence.local
  const remote = presence.remote
  if (!local || !remote || local.location.mapId !== remote.location.mapId) return null
  const dx = remote.x - local.x
  const dy = remote.y - local.y
  // The DS top screen is roughly 16x12 overworld tiles. Keep the marker inside
  // the visible center-camera region until camera-boundary offsets are modeled.
  if (Math.abs(dx) > 7 || Math.abs(dy) > 5) return null
  return { dx, dy, direction: remote.direction, label: 'P2' }
}

function sameMarkerPresence(a: MultiplayerPresenceSnapshot, b: MultiplayerPresenceSnapshot) {
  const sameState = (left: MultiplayerPresenceSnapshot['local'], right: MultiplayerPresenceSnapshot['local']) => {
    if (!left || !right) return left === right
    return left.location.mapId === right.location.mapId
      && left.x === right.x
      && left.y === right.y
      && left.direction === right.direction
  }
  return sameState(a.local, b.local) && sameState(a.remote, b.remote)
}

/** React shell only: frame rendering and emulated-memory access stay inside MelonDsBridge. */
export function MelonDsPlayer({ game, run, rom: suppliedRom, onBridgeReady, saveKey, batterySave, onBatterySave, partnerMarker }: Props) {
  const topRef = useRef<HTMLCanvasElement>(null)
  const bottomRef = useRef<HTMLCanvasElement>(null)
  const bridgeRef = useRef<MelonDsBridge | null>(null)
  const [status, setStatus] = useState<PlayerStatus>('booting')
  const [statusText, setStatusText] = useState('INITIALIZING melonDS...')
  const [paused, setPaused] = useState(false)
  const [memoryText, setMemoryText] = useState('NOT READ')
  const [speed, setSpeed] = useState<DsSpeedMultiplier>(storedSpeed)
  const [presence, setPresence] = useState<MultiplayerPresenceSnapshot>({ local: null, remote: null })
  const [runtimeSpeedStats, setRuntimeSpeedStats] = useState<RuntimeSpeedStats>({ bridgeSpeed: speed, processFramesPerSecond: 0 })
  const speedRef = useRef<DsSpeedMultiplier>(speed)

  useEffect(() => multiplayerPresence.subscribe(snapshot => {
    setPresence(previous => sameMarkerPresence(previous, snapshot) ? previous : snapshot)
  }), [])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    let observedBridge: MelonDsBridge | null = null
    let unsubscribeFrame: (() => void) | null = null
    let frameCount = 0
    let windowStartedAt = performance.now()

    const bindBridge = (bridge: MelonDsBridge | null) => {
      if (bridge === observedBridge) return
      unsubscribeFrame?.()
      observedBridge = bridge
      frameCount = 0
      windowStartedAt = performance.now()
      unsubscribeFrame = bridge?.subscribeEmulatedFrame(() => { frameCount += 1 }) ?? null
    }

    const timer = window.setInterval(() => {
      const bridge = bridgeRef.current
      bindBridge(bridge)
      const now = performance.now()
      const elapsedMs = now - windowStartedAt
      if (elapsedMs < 500) return
      setRuntimeSpeedStats({
        bridgeSpeed: bridge?.getSpeedMultiplier() ?? 1,
        processFramesPerSecond: elapsedMs > 0 ? frameCount * 1000 / elapsedMs : 0,
      })
      frameCount = 0
      windowStartedAt = now
    }, 250)

    return () => {
      window.clearInterval(timer)
      unsubscribeFrame?.()
    }
  }, [])

  useEffect(() => {
    const top = topRef.current
    const bottom = bottomRef.current
    if (!top || !bottom) return
    let cancelled = false
    const bridge = new MelonDsBridge()
    bridgeRef.current = bridge
    bridge.setSpeedMultiplier(speedRef.current)
    if (saveKey) bridge.setSaveKey(saveKey)
    bridge.setBatterySaveListener(onBatterySave ?? null)

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
        if (batterySave?.length) {
          setStatusText('RESTORING IN-GAME SAVE...')
          await bridge.importBatterySave(batterySave)
        }
        if (cancelled) return
        bridge.attachScreens(top!, bottom!)
        setStatusText('LOADING melonDS WASM...')
        await bridge.loadRom(rom.bytes.slice().buffer)
        if (cancelled) return
        setStatusText('DIRECT-BOOTING ROM...')
        await bridge.start()
        if (cancelled) return
        onBridgeReady?.(bridge)
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
      onBridgeReady?.(null)
      void bridge.dispose()
    }
  }, [game.title, run?.id, suppliedRom, onBridgeReady, saveKey, batterySave, onBatterySave])

  const ready = status === 'running'
  async function togglePause() {
    const bridge = bridgeRef.current
    if (!bridge || !ready) return
    if (paused) await bridge.resume()
    else await bridge.pause()
    setPaused(value => !value)
  }
  function changeSpeed(multiplier: DsSpeedMultiplier) {
    speedRef.current = multiplier
    setSpeed(multiplier)
    localStorage.setItem(SPEED_STORAGE_KEY, String(multiplier))
    bridgeRef.current?.setSpeedMultiplier(multiplier)
  }
  async function inspectArm9() {
    try {
      const bytes = await bridgeRef.current?.readBytes(0x02000000, 16)
      setMemoryText(bytes ? `02000000: ${formatBytes(bytes)}` : 'EMULATOR UNAVAILABLE')
    } catch (error) {
      setMemoryText(error instanceof Error ? error.message.toUpperCase() : 'READ FAILED')
    }
  }

  const automaticPartnerMarker = markerFromPresence(presence)
  const nativeWhite2Trainer = game.id === 'white2' && suppliedRom?.sha256.toLowerCase() === TESTED_WHITE2_SHA256
  const visiblePartnerMarker = nativeWhite2Trainer ? null : partnerMarker === undefined ? automaticPartnerMarker : partnerMarker
  const partnerStyle = visiblePartnerMarker ? {
    '--partner-x': `${50 + visiblePartnerMarker.dx * 6.25}%`,
    '--partner-y': `${52 + visiblePartnerMarker.dy * (100 / 12)}%`,
  } as React.CSSProperties : undefined
  const multiplayerRomIdentity = suppliedRom ? {
    gameId: game.id,
    fileName: suppliedRom.fileName,
    sha256: suppliedRom.sha256,
    status: 'loaded' as const,
  } : null

  return (
    <div className="melonds-player">
      {multiplayerRomIdentity && <White2RemoteTrainerRuntime bridge={ready ? bridgeRef.current : null} rom={multiplayerRomIdentity}/>} 
      <div className="emulator-toolbar pixel-border">
        <strong>melonDS</strong>
        <div className="emulator-speed-controls" aria-label="Emulation speed">
          {SPEED_OPTIONS.map(multiplier => <button key={multiplier} disabled={!ready} className={speed === multiplier ? 'active' : ''} aria-pressed={speed === multiplier} onClick={() => changeSpeed(multiplier)}>{multiplier}×</button>)}
        </div>
        <button disabled={!ready} onClick={() => void togglePause()}>{paused ? 'RESUME' : 'PAUSE'}</button>
        <span>DUAL SCREEN</span>
      </div>
      <div className="melonds-stack pixel-border">
        <div className="melonds-screen-wrap">
          <canvas ref={topRef} className="melonds-screen" width={256} height={192} aria-label="Nintendo DS top screen" />
          {ready && visiblePartnerMarker && <div className={`ds-partner-marker facing-${visiblePartnerMarker.direction}`} style={partnerStyle} aria-label={`${visiblePartnerMarker.label ?? 'Partner'} at ${visiblePartnerMarker.dx}, ${visiblePartnerMarker.dy} tiles from you`}>
            <span className="ds-partner-label">{visiblePartnerMarker.label ?? 'P2'}</span>
            <span className="ds-partner-avatar" aria-hidden="true"><i>{directionGlyph[visiblePartnerMarker.direction]}</i></span>
          </div>}
        </div>
        <canvas ref={bottomRef} className="melonds-screen touch" width={256} height={192} aria-label="Nintendo DS touch screen" onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); bridgeRef.current?.touch(event.clientX, event.clientY) }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) bridgeRef.current?.touch(event.clientX, event.clientY) }} onPointerUp={() => bridgeRef.current?.releaseTouch()} onPointerCancel={() => bridgeRef.current?.releaseTouch()} />
        {status !== 'running' && <div className={`melonds-status ${status === 'error' ? 'error' : ''}`}><strong>{status === 'error' ? 'EMULATOR ERROR' : 'BOOTING'}</strong><span>{statusText}</span></div>}
      </div>
      <div className="mgba-meta pixel-border"><span>{statusText} • {speed}× SPEED</span><span>ARROWS MOVE • X=A • Z=B • S=X • A=Y • Q/W=L/R • ENTER=START • RIGHT SHIFT=SELECT</span><span>TOUCH: BOTTOM SCREEN</span></div>
      {import.meta.env.DEV && <div className="melonds-debug pixel-border">
        <code>BRIDGE {runtimeSpeedStats.bridgeSpeed}× • PROCESS {Math.round(runtimeSpeedStats.processFramesPerSecond)}/s</code>
        <button disabled={!ready} onClick={() => void inspectArm9()}>READ ARM9 BUS</button>
        <code>{memoryText}</code>
      </div>}
    </div>
  )
}