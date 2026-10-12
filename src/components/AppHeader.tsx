import { PixelButton } from './PixelButton'

interface Props {
  onHome: () => void
  onSettings?: () => void
  right?: React.ReactNode
}

export function AppHeader({ onHome, onSettings, right }: Props) {
  return (
    <header className="app-header pixel-border">
      <button className="brand" onClick={onHome} aria-label="PokéRun home">
        <strong>POKÉRUN</strong>
        <span>POKÉMON RUN MANAGER</span>
      </button>
      <div className="header-actions">
        {right ?? (onSettings ? <PixelButton tone="ghost" onClick={onSettings}>SETTINGS</PixelButton> : null)}
      </div>
    </header>
  )
}
