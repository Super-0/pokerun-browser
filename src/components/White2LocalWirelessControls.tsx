import { useEffect, useRef, useState } from 'react'
import type { MelonDsBridge } from '../core/emulator/melonds/MelonDsBridge'
import { White2NativeRadioLink, type NativeRadioLinkOptions, type NativeRadioLinkStatus } from '../multiplayer/games/White2NativeRadioLink'
import { PixelButton } from './PixelButton'

type Props = { bridge: MelonDsBridge | null; options: NativeRadioLinkOptions }

export function White2LocalWirelessControls({ bridge, options }: Props) {
  const activeLink = useRef<White2NativeRadioLink | null>(null)
  const [status, setStatus] = useState<NativeRadioLinkStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => () => {
    activeLink.current?.stop()
    activeLink.current = null
  }, [bridge, options])

  const connecting = status?.phase === 'waiting'
  const linked = status?.phase === 'linked'

  function connect() {
    if (!bridge || bridge.status !== 'running') return
    activeLink.current?.stop()
    activeLink.current = null
    setError(null)
    try {
      const link = new White2NativeRadioLink(bridge, options, setStatus)
      activeLink.current = link
      link.start()
    } catch (reason) {
      activeLink.current?.stop()
      activeLink.current = null
      setError(reason instanceof Error ? reason.message : 'Local wireless could not start.')
    }
  }

  function disconnect() {
    activeLink.current?.stop()
    activeLink.current = null
  }

  return <section className="multiplayer-session-debug pixel-border" aria-label="White 2 local wireless">
    <h2>WHITE 2 LOCAL WIRELESS</h2>
    <p>Use a different save slot in each tab. Connect both tabs in this browser, then enter the Union Room in Pokémon.</p>
    <p role="status">{linked ? 'LOCAL WIRELESS CONNECTED' : connecting ? 'WAITING FOR THE OTHER TAB' : 'LOCAL WIRELESS DISCONNECTED'}</p>
    {(error || status?.phase === 'error') && <p role="alert">{error ?? status?.reason ?? 'Local wireless stopped.'}</p>}
    {linked || connecting
      ? <PixelButton tone="ghost" onClick={disconnect}>DISCONNECT LOCAL WIRELESS</PixelButton>
      : <PixelButton disabled={bridge?.status !== 'running'} onClick={connect}>CONNECT LOCAL WIRELESS</PixelButton>}
  </section>
}
