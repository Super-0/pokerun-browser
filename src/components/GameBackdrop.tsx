import type { GameDefinition } from '../types'

export function GameBackdrop({ game }: { game: GameDefinition }) {
  return (
    <div className={`game-backdrop motif-${game.theme.motif}`} aria-hidden="true">
      <div className="pixel-cloud cloud-a" />
      <div className="pixel-cloud cloud-b" />
      <div className="pixel-cloud cloud-c" />
      <div className="distant-shape one" />
      <div className="distant-shape two" />
      <div className="water-band" />
      <div className="ground-band" />
      <div className="grass-edge" />
    </div>
  )
}
