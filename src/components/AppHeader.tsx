import { PixelButton } from './PixelButton'

interface Props {
  onHome: () => void
  right?: React.ReactNode
}

export function AppHeader({ onHome, right }: Props) {
  return (
    <header className="app-header pixel-border">
      <button className="brand" onClick={onHome} aria-label="PokéRun home">
        <strong>POKÉRUN</strong>
        <span>NUZLOCKE RUN MANAGER</span>
      </button>
      <div className="header-actions">{right ?? <PixelButton tone="ghost">SETTINGS</PixelButton>}</div>
    </header>
  )
}
