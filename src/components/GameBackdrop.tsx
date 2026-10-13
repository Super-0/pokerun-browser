import type { GameDefinition } from '../types'

export function GameBackdrop({ game }: { game: GameDefinition }) {
  return (
    <div className={`game-backdrop motif-${game.theme.motif} game-${game.id}`} aria-hidden="true">
      <div className="theme-orb" />
      <div className="pixel-cloud cloud-a" />
      <div className="pixel-cloud cloud-b" />
      <div className="pixel-cloud cloud-c" />
      <div className="pixel-spark spark-a" />
      <div className="pixel-spark spark-b" />
      <div className="distant-shape one" />
      <div className="distant-shape two" />
      <div className="water-band" />
      <div className="ground-band" />
      <div className="grass-edge" />
      <div className="foreground-detail" />
    </div>
  )
}
