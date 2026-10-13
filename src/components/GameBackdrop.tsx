import type { GameDefinition } from '../types'

export function GameBackdrop({ game }: { game: GameDefinition }) {
  return (
    <div
      className={`game-backdrop universal-pixel-backdrop game-${game.id}`}
      aria-hidden="true"
    />
  )
}
