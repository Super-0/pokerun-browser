import { getPokemonSpeciesName, getPokemonSpriteUrl } from '../core/game/pokemonSpecies'
import type { GameDefinition, GameId } from '../types'

const COVER_MASCOTS: Record<GameId, { dexId: number, label?: string }> = {
  red: { dexId: 6 },
  blue: { dexId: 9 },
  yellow: { dexId: 25 },
  gold: { dexId: 250 },
  silver: { dexId: 249 },
  crystal: { dexId: 245 },
  ruby: { dexId: 383 },
  sapphire: { dexId: 382 },
  emerald: { dexId: 384 },
  firered: { dexId: 6 },
  leafgreen: { dexId: 3 },
  diamond: { dexId: 483 },
  pearl: { dexId: 484 },
  platinum: { dexId: 487 },
  heartgold: { dexId: 250 },
  soulsilver: { dexId: 249 },
  black: { dexId: 643 },
  white: { dexId: 644 },
  black2: { dexId: 646, label: 'BLACK KYUREM' },
  white2: { dexId: 646, label: 'WHITE KYUREM' },
}

const EMERALD_RAYQUAZA_ARTWORK = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/384.png'

export function GameBackdrop({ game }: { game: GameDefinition }) {
  const mascot = COVER_MASCOTS[game.id]
  const mascotName = mascot.label ?? getPokemonSpeciesName(mascot.dexId).toUpperCase()
  const mascotSprite = game.id === 'emerald'
    ? EMERALD_RAYQUAZA_ARTWORK
    : getPokemonSpriteUrl(game.id, mascot.dexId)
  const isEmerald = game.id === 'emerald'

  return (
    <div className={`game-backdrop motif-${game.theme.motif} game-${game.id}`} aria-hidden="true">
      {isEmerald && (
        <div className="emerald-scene">
          <div className="emerald-vignette" />
          <div className="emerald-storm-glow" />
          <div className="emerald-storm-shelf" />
          <div className="emerald-rain" />

          <div className="emerald-cloud-mass emerald-cloud-mass-a" />
          <div className="emerald-cloud-mass emerald-cloud-mass-b" />
          <div className="emerald-cloud-mass emerald-cloud-mass-c" />
          <div className="emerald-cloud-mass emerald-cloud-mass-d" />

          <div className="emerald-wind-arc emerald-wind-arc-a" />
          <div className="emerald-wind-arc emerald-wind-arc-b" />
          <div className="emerald-wind-arc emerald-wind-arc-c" />

          <div className="emerald-energy-ring emerald-energy-ring-a" />
          <div className="emerald-energy-ring emerald-energy-ring-b" />
          <div className="emerald-energy-ring emerald-energy-ring-c" />

          <div className="emerald-lightning emerald-lightning-a" />
          <div className="emerald-lightning emerald-lightning-b" />

          <div className="emerald-sky-pillar" />
          <div className="emerald-island emerald-island-left" />
          <div className="emerald-island emerald-island-right" />
          <div className="emerald-horizon-haze" />
          <div className="emerald-sea-reflection" />
          <div className="emerald-foreground-haze" />
        </div>
      )}

      <div className="cover-mascot">
        <div className="cover-mascot-aura" />
        {mascotSprite && (
          <img
            className="cover-mascot-sprite"
            src={mascotSprite}
            alt=""
            crossOrigin="anonymous"
          />
        )}
        <div className="cover-mascot-copy">
          <span>{mascotName}</span>
          <small>{game.region.toUpperCase()} • GEN {game.generation}</small>
        </div>
      </div>

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
