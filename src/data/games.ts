import type { GameDefinition, GameId } from '../types'

const t = (
  sky: string,
  skySoft: string,
  accent: string,
  accentDark: string,
  ground: string,
  water: string,
  motif: GameDefinition['theme']['motif'],
) => ({ sky, skySoft, accent, accentDark, ground, water, motif })

export const games: GameDefinition[] = [
  { id: 'red', title: 'Pokémon Red', shortTitle: 'RED', generation: 1, platform: 'GB', region: 'Kanto', theme: t('#e98b7d','#f5b5a9','#c54a43','#7e2c2b','#9bbb65','#77a8d8','field') },
  { id: 'blue', title: 'Pokémon Blue', shortTitle: 'BLUE', generation: 1, platform: 'GB', region: 'Kanto', theme: t('#78bde8','#acd9f3','#4a82cb','#2f4f90','#88b46f','#5f92d2','ocean') },
  { id: 'yellow', title: 'Pokémon Yellow', shortTitle: 'YELLOW', generation: 1, platform: 'GB', region: 'Kanto', theme: t('#f3d977','#faebb0','#d2aa2f','#846a19','#91bb65','#7fb3dc','field') },

  { id: 'gold', title: 'Pokémon Gold', shortTitle: 'GOLD', generation: 2, platform: 'GBC', region: 'Johto', theme: t('#f1bd67','#f6d69a','#c88e27','#775218','#839f64','#6c93bd','sunset') },
  { id: 'silver', title: 'Pokémon Silver', shortTitle: 'SILVER', generation: 2, platform: 'GBC', region: 'Johto', theme: t('#a7c7db','#d4e4ed','#6e8fa8','#41596d','#7f9d70','#789db8','mountain') },
  { id: 'crystal', title: 'Pokémon Crystal', shortTitle: 'CRYSTAL', generation: 2, platform: 'GBC', region: 'Johto', theme: t('#8ed6e8','#c8eff6','#4ca3c7','#276680','#80ad83','#64a8cc','mountain') },

  { id: 'ruby', title: 'Pokémon Ruby', shortTitle: 'RUBY', generation: 3, platform: 'GBA', region: 'Hoenn', theme: t('#ef9a86','#f5c0b3','#cd4f4c','#7b2f31','#8dbb65','#70acd8','field') },
  { id: 'sapphire', title: 'Pokémon Sapphire', shortTitle: 'SAPPHIRE', generation: 3, platform: 'GBA', region: 'Hoenn', theme: t('#7cc8ef','#b6e1f6','#4489cb','#295891','#80b96d','#559dd0','ocean') },
  { id: 'emerald', title: 'Pokémon Emerald', shortTitle: 'EMERALD', generation: 3, platform: 'GBA', region: 'Hoenn', theme: t('#78d5c1','#b7eddf','#3a9c72','#266047','#61ad64','#62aed5','ocean') },
  { id: 'firered', title: 'Pokémon FireRed', shortTitle: 'FIRERED', generation: 3, platform: 'GBA', region: 'Kanto', theme: t('#f0a078','#f7c8a9','#d55b36','#86341f','#94b45f','#69a3d1','sunset') },
  { id: 'leafgreen', title: 'Pokémon LeafGreen', shortTitle: 'LEAFGREEN', generation: 3, platform: 'GBA', region: 'Kanto', theme: t('#9ad58b','#ccebbd','#5d9f54','#345f35','#659b57','#71a8cc','forest') },

  { id: 'diamond', title: 'Pokémon Diamond', shortTitle: 'DIAMOND', generation: 4, platform: 'NDS', region: 'Sinnoh', theme: t('#9cd8ef','#d1edf7','#65aaca','#3e6d86','#759e7c','#76a9ca','mountain') },
  { id: 'pearl', title: 'Pokémon Pearl', shortTitle: 'PEARL', generation: 4, platform: 'NDS', region: 'Sinnoh', theme: t('#edc0d8','#f6dfeb','#c982aa','#7e506e','#869c80','#88a8c1','mountain') },
  { id: 'platinum', title: 'Pokémon Platinum', shortTitle: 'PLATINUM', generation: 4, platform: 'NDS', region: 'Sinnoh', theme: t('#a9b6c5','#d9dfe5','#667787','#394956','#687b6d','#718ba3','mountain') },
  { id: 'heartgold', title: 'Pokémon HeartGold', shortTitle: 'HEARTGOLD', generation: 4, platform: 'NDS', region: 'Johto', theme: t('#efc66f','#f6dfa7','#c99a34','#77591e','#88a565','#7094b9','sunset') },
  { id: 'soulsilver', title: 'Pokémon SoulSilver', shortTitle: 'SOULSILVER', generation: 4, platform: 'NDS', region: 'Johto', theme: t('#bacbd8','#e0e8ed','#7d98ac','#4a5e6f','#809b75','#7597b0','mountain') },

  { id: 'black', title: 'Pokémon Black', shortTitle: 'BLACK', generation: 5, platform: 'NDS', region: 'Unova', theme: t('#8fa9bd','#c8d5de','#3f596a','#263846','#6f8875','#6988a1','city') },
  { id: 'white', title: 'Pokémon White', shortTitle: 'WHITE', generation: 5, platform: 'NDS', region: 'Unova', theme: t('#d7e8ed','#eff6f7','#7f9eaa','#566d76','#8da484','#87a8b3','city') },
  { id: 'black2', title: 'Pokémon Black 2', shortTitle: 'BLACK 2', generation: 5, platform: 'NDS', region: 'Unova', theme: t('#81c8ee','#b8e0f4','#4c88cd','#2f5790','#6f9f78','#67a0cf','city') },
  { id: 'white2', title: 'Pokémon White 2', shortTitle: 'WHITE 2', generation: 5, platform: 'NDS', region: 'Unova', theme: t('#b6ddef','#e0f1f8','#6ca3c7','#426d8a','#8fac85','#78acc9','city') },
]

export const gamesByGeneration = ([1,2,3,4,5] as const).map(generation => ({
  generation,
  games: games.filter(game => game.generation === generation),
}))

export const gameById = Object.fromEntries(games.map(game => [game.id, game])) as Record<GameId, GameDefinition>
