import { useState } from 'react'
import { googleDriveRomProvider } from '../core/rom/GoogleDriveRomProvider'
import { formatRomSize, type LoadedRom } from '../core/rom/RomLoader'
import type { RomSourceReference } from '../core/rom/RomSource'
import type { GameDefinition } from '../types'
import { PixelButton } from './PixelButton'

interface Props {
  game: GameDefinition
  onLoaded: (rom: LoadedRom) => void
}

export function DriveRomChooser({ game, onLoaded }: Props) {
  const [connected, setConnected] = useState(googleDriveRomProvider.connected)
  const [loading, setLoading] = useState(false)
  const [candidates, setCandidates] = useState<RomSourceReference[]>([])
  const [linked, setLinked] = useState<RomSourceReference | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [message, setMessage] = useState(
    googleDriveRomProvider.configured ? 'CONNECT DRIVE' : 'GOOGLE CLIENT ID REQUIRED',
  )
  const [error, setError] = useState(false)

  async function connect() {
    setLoading(true)
    setError(false)
    setMessage('CONNECTING...')
    try {
      await googleDriveRomProvider.connect()
      setConnected(true)
      await refreshLibrary()
    } catch (cause) {
      setError(true)
      setMessage(cause instanceof Error ? cause.message : 'Google Drive connection failed.')
    } finally {
      setLoading(false)
    }
  }

  async function refreshLibrary() {
    setLoading(true)
    setError(false)
    try {
      const [savedLink, files] = await Promise.all([
        googleDriveRomProvider.getLinkedRom(game.id),
        googleDriveRomProvider.listRomCandidates(game),
      ])
      setLinked(savedLink)
      setCandidates(files)
      if (savedLink?.fileId) setSelectedId(savedLink.fileId)
      else if (files[0]?.fileId) setSelectedId(files[0].fileId)
      setMessage(savedLink ? `LINKED • ${savedLink.fileName}` : `${files.length} COMPATIBLE ROM${files.length === 1 ? '' : 'S'} FOUND`)
    } catch (cause) {
      setError(true)
      setMessage(cause instanceof Error ? cause.message : 'Could not read your Drive ROM library.')
    } finally {
      setLoading(false)
    }
  }

  async function loadReference(reference: RomSourceReference, saveLink: boolean) {
    setLoading(true)
    setError(false)
    setMessage(`LOADING ${reference.fileName}...`)
    try {
      if (saveLink) {
        await googleDriveRomProvider.linkRom(game.id, reference)
        setLinked(reference)
      }
      const rom = await googleDriveRomProvider.loadRom(reference, game)
      onLoaded(rom)
      setMessage(`${rom.fileName} • ${formatRomSize(rom.size)} • READY`)
    } catch (cause) {
      setError(true)
      setMessage(cause instanceof Error ? cause.message : 'ROM could not be loaded from Google Drive.')
    } finally {
      setLoading(false)
    }
  }

  const selected = candidates.find(candidate => candidate.fileId === selectedId) ?? null

  return (
    <div className="drive-rom-chooser">
      <div className="inline-row">
        <PixelButton disabled={loading || !googleDriveRomProvider.configured} onClick={() => void connect()}>
          {connected ? 'REFRESH DRIVE' : 'CONNECT GOOGLE DRIVE'}
        </PixelButton>
        <span className={`status-chip ${error ? 'error' : linked ? 'ready' : 'warning'}`}>{message}</span>
      </div>

      {connected && linked && (
        <div className="drive-linked-rom">
          <div>
            <strong>LINKED ROM</strong>
            <span>{linked.fileName} • {formatRomSize(linked.size)}</span>
          </div>
          <PixelButton disabled={loading} onClick={() => void loadReference(linked, false)}>LOAD LINKED ROM</PixelButton>
        </div>
      )}

      {connected && candidates.length > 0 && (
        <div className="drive-file-row">
          <select value={selectedId} onChange={event => setSelectedId(event.target.value)}>
            {candidates.map(candidate => (
              <option key={candidate.fileId} value={candidate.fileId}>
                {candidate.fileName} ({formatRomSize(candidate.size)})
              </option>
            ))}
          </select>
          <PixelButton tone="ghost" disabled={!selected || loading} onClick={() => selected && void loadReference(selected, true)}>
            LINK & LOAD
          </PixelButton>
        </div>
      )}

      {connected && candidates.length === 0 && !loading && (
        <small>No compatible {game.platform} ROM files were found in this Google Drive.</small>
      )}
    </div>
  )
}
