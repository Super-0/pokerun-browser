import type { GameId, PartyMember } from '../../types'

const NATIONAL_SPECIES_NAMES = [
  'Bulbasaur', 'Ivysaur', 'Venusaur', 'Charmander', 'Charmeleon', 'Charizard', 'Squirtle', 'Wartortle', 'Blastoise', 'Caterpie',
  'Metapod', 'Butterfree', 'Weedle', 'Kakuna', 'Beedrill', 'Pidgey', 'Pidgeotto', 'Pidgeot', 'Rattata', 'Raticate',
  'Spearow', 'Fearow', 'Ekans', 'Arbok', 'Pikachu', 'Raichu', 'Sandshrew', 'Sandslash', 'Nidoran♀', 'Nidorina',
  'Nidoqueen', 'Nidoran♂', 'Nidorino', 'Nidoking', 'Clefairy', 'Clefable', 'Vulpix', 'Ninetales', 'Jigglypuff', 'Wigglytuff',
  'Zubat', 'Golbat', 'Oddish', 'Gloom', 'Vileplume', 'Paras', 'Parasect', 'Venonat', 'Venomoth', 'Diglett',
  'Dugtrio', 'Meowth', 'Persian', 'Psyduck', 'Golduck', 'Mankey', 'Primeape', 'Growlithe', 'Arcanine', 'Poliwag',
  'Poliwhirl', 'Poliwrath', 'Abra', 'Kadabra', 'Alakazam', 'Machop', 'Machoke', 'Machamp', 'Bellsprout', 'Weepinbell',
  'Victreebel', 'Tentacool', 'Tentacruel', 'Geodude', 'Graveler', 'Golem', 'Ponyta', 'Rapidash', 'Slowpoke', 'Slowbro',
  'Magnemite', 'Magneton', "Farfetch'd", 'Doduo', 'Dodrio', 'Seel', 'Dewgong', 'Grimer', 'Muk', 'Shellder',
  'Cloyster', 'Gastly', 'Haunter', 'Gengar', 'Onix', 'Drowzee', 'Hypno', 'Krabby', 'Kingler', 'Voltorb',
  'Electrode', 'Exeggcute', 'Exeggutor', 'Cubone', 'Marowak', 'Hitmonlee', 'Hitmonchan', 'Lickitung', 'Koffing', 'Weezing',
  'Rhyhorn', 'Rhydon', 'Chansey', 'Tangela', 'Kangaskhan', 'Horsea', 'Seadra', 'Goldeen', 'Seaking', 'Staryu',
  'Starmie', 'Mr. Mime', 'Scyther', 'Jynx', 'Electabuzz', 'Magmar', 'Pinsir', 'Tauros', 'Magikarp', 'Gyarados',
  'Lapras', 'Ditto', 'Eevee', 'Vaporeon', 'Jolteon', 'Flareon', 'Porygon', 'Omanyte', 'Omastar', 'Kabuto',
  'Kabutops', 'Aerodactyl', 'Snorlax', 'Articuno', 'Zapdos', 'Moltres', 'Dratini', 'Dragonair', 'Dragonite', 'Mewtwo',
  'Mew', 'Chikorita', 'Bayleef', 'Meganium', 'Cyndaquil', 'Quilava', 'Typhlosion', 'Totodile', 'Croconaw', 'Feraligatr',
  'Sentret', 'Furret', 'Hoothoot', 'Noctowl', 'Ledyba', 'Ledian', 'Spinarak', 'Ariados', 'Crobat', 'Chinchou',
  'Lanturn', 'Pichu', 'Cleffa', 'Igglybuff', 'Togepi', 'Togetic', 'Natu', 'Xatu', 'Mareep', 'Flaaffy',
  'Ampharos', 'Bellossom', 'Marill', 'Azumarill', 'Sudowoodo', 'Politoed', 'Hoppip', 'Skiploom', 'Jumpluff', 'Aipom',
  'Sunkern', 'Sunflora', 'Yanma', 'Wooper', 'Quagsire', 'Espeon', 'Umbreon', 'Murkrow', 'Slowking', 'Misdreavus',
  'Unown', 'Wobbuffet', 'Girafarig', 'Pineco', 'Forretress', 'Dunsparce', 'Gligar', 'Steelix', 'Snubbull', 'Granbull',
  'Qwilfish', 'Scizor', 'Shuckle', 'Heracross', 'Sneasel', 'Teddiursa', 'Ursaring', 'Slugma', 'Magcargo', 'Swinub',
  'Piloswine', 'Corsola', 'Remoraid', 'Octillery', 'Delibird', 'Mantine', 'Skarmory', 'Houndour', 'Houndoom', 'Kingdra',
  'Phanpy', 'Donphan', 'Porygon2', 'Stantler', 'Smeargle', 'Tyrogue', 'Hitmontop', 'Smoochum', 'Elekid', 'Magby',
  'Miltank', 'Blissey', 'Raikou', 'Entei', 'Suicune', 'Larvitar', 'Pupitar', 'Tyranitar', 'Lugia', 'Ho-Oh',
  'Celebi', 'Treecko', 'Grovyle', 'Sceptile', 'Torchic', 'Combusken', 'Blaziken', 'Mudkip', 'Marshtomp', 'Swampert',
  'Poochyena', 'Mightyena', 'Zigzagoon', 'Linoone', 'Wurmple', 'Silcoon', 'Beautifly', 'Cascoon', 'Dustox', 'Lotad',
  'Lombre', 'Ludicolo', 'Seedot', 'Nuzleaf', 'Shiftry', 'Taillow', 'Swellow', 'Wingull', 'Pelipper', 'Ralts',
  'Kirlia', 'Gardevoir', 'Surskit', 'Masquerain', 'Shroomish', 'Breloom', 'Slakoth', 'Vigoroth', 'Slaking', 'Nincada',
  'Ninjask', 'Shedinja', 'Whismur', 'Loudred', 'Exploud', 'Makuhita', 'Hariyama', 'Azurill', 'Nosepass', 'Skitty',
  'Delcatty', 'Sableye', 'Mawile', 'Aron', 'Lairon', 'Aggron', 'Meditite', 'Medicham', 'Electrike', 'Manectric',
  'Plusle', 'Minun', 'Volbeat', 'Illumise', 'Roselia', 'Gulpin', 'Swalot', 'Carvanha', 'Sharpedo', 'Wailmer',
  'Wailord', 'Numel', 'Camerupt', 'Torkoal', 'Spoink', 'Grumpig', 'Spinda', 'Trapinch', 'Vibrava', 'Flygon',
  'Cacnea', 'Cacturne', 'Swablu', 'Altaria', 'Zangoose', 'Seviper', 'Lunatone', 'Solrock', 'Barboach', 'Whiscash',
  'Corphish', 'Crawdaunt', 'Baltoy', 'Claydol', 'Lileep', 'Cradily', 'Anorith', 'Armaldo', 'Feebas', 'Milotic',
  'Castform', 'Kecleon', 'Shuppet', 'Banette', 'Duskull', 'Dusclops', 'Tropius', 'Chimecho', 'Absol', 'Wynaut',
  'Snorunt', 'Glalie', 'Spheal', 'Sealeo', 'Walrein', 'Clamperl', 'Huntail', 'Gorebyss', 'Relicanth', 'Luvdisc',
  'Bagon', 'Shelgon', 'Salamence', 'Beldum', 'Metang', 'Metagross', 'Regirock', 'Regice', 'Registeel', 'Latias',
  'Latios', 'Kyogre', 'Groudon', 'Rayquaza', 'Jirachi', 'Deoxys', 'Turtwig', 'Grotle', 'Torterra', 'Chimchar',
  'Monferno', 'Infernape', 'Piplup', 'Prinplup', 'Empoleon', 'Starly', 'Staravia', 'Staraptor', 'Bidoof', 'Bibarel',
  'Kricketot', 'Kricketune', 'Shinx', 'Luxio', 'Luxray', 'Budew', 'Roserade', 'Cranidos', 'Rampardos', 'Shieldon',
  'Bastiodon', 'Burmy', 'Wormadam', 'Mothim', 'Combee', 'Vespiquen', 'Pachirisu', 'Buizel', 'Floatzel', 'Cherubi',
  'Cherrim', 'Shellos', 'Gastrodon', 'Ambipom', 'Drifloon', 'Drifblim', 'Buneary', 'Lopunny', 'Mismagius', 'Honchkrow',
  'Glameow', 'Purugly', 'Chingling', 'Stunky', 'Skuntank', 'Bronzor', 'Bronzong', 'Bonsly', 'Mime Jr.', 'Happiny',
  'Chatot', 'Spiritomb', 'Gible', 'Gabite', 'Garchomp', 'Munchlax', 'Riolu', 'Lucario', 'Hippopotas', 'Hippowdon',
  'Skorupi', 'Drapion', 'Croagunk', 'Toxicroak', 'Carnivine', 'Finneon', 'Lumineon', 'Mantyke', 'Snover', 'Abomasnow',
  'Weavile', 'Magnezone', 'Lickilicky', 'Rhyperior', 'Tangrowth', 'Electivire', 'Magmortar', 'Togekiss', 'Yanmega', 'Leafeon',
  'Glaceon', 'Gliscor', 'Mamoswine', 'Porygon-Z', 'Gallade', 'Probopass', 'Dusknoir', 'Froslass', 'Rotom', 'Uxie',
  'Mesprit', 'Azelf', 'Dialga', 'Palkia', 'Heatran', 'Regigigas', 'Giratina', 'Cresselia', 'Phione', 'Manaphy',
  'Darkrai', 'Shaymin', 'Arceus', 'Victini', 'Snivy', 'Servine', 'Serperior', 'Tepig', 'Pignite', 'Emboar',
  'Oshawott', 'Dewott', 'Samurott', 'Patrat', 'Watchog', 'Lillipup', 'Herdier', 'Stoutland', 'Purrloin', 'Liepard',
  'Pansage', 'Simisage', 'Pansear', 'Simisear', 'Panpour', 'Simipour', 'Munna', 'Musharna', 'Pidove', 'Tranquill',
  'Unfezant', 'Blitzle', 'Zebstrika', 'Roggenrola', 'Boldore', 'Gigalith', 'Woobat', 'Swoobat', 'Drilbur', 'Excadrill',
  'Audino', 'Timburr', 'Gurdurr', 'Conkeldurr', 'Tympole', 'Palpitoad', 'Seismitoad', 'Throh', 'Sawk', 'Sewaddle',
  'Swadloon', 'Leavanny', 'Venipede', 'Whirlipede', 'Scolipede', 'Cottonee', 'Whimsicott', 'Petilil', 'Lilligant', 'Basculin',
  'Sandile', 'Krokorok', 'Krookodile', 'Darumaka', 'Darmanitan', 'Maractus', 'Dwebble', 'Crustle', 'Scraggy', 'Scrafty',
  'Sigilyph', 'Yamask', 'Cofagrigus', 'Tirtouga', 'Carracosta', 'Archen', 'Archeops', 'Trubbish', 'Garbodor', 'Zorua',
  'Zoroark', 'Minccino', 'Cinccino', 'Gothita', 'Gothorita', 'Gothitelle', 'Solosis', 'Duosion', 'Reuniclus', 'Ducklett',
  'Swanna', 'Vanillite', 'Vanillish', 'Vanilluxe', 'Deerling', 'Sawsbuck', 'Emolga', 'Karrablast', 'Escavalier', 'Foongus',
  'Amoonguss', 'Frillish', 'Jellicent', 'Alomomola', 'Joltik', 'Galvantula', 'Ferroseed', 'Ferrothorn', 'Klink', 'Klang',
  'Klinklang', 'Tynamo', 'Eelektrik', 'Eelektross', 'Elgyem', 'Beheeyem', 'Litwick', 'Lampent', 'Chandelure', 'Axew',
  'Fraxure', 'Haxorus', 'Cubchoo', 'Beartic', 'Cryogonal', 'Shelmet', 'Accelgor', 'Stunfisk', 'Mienfoo', 'Mienshao',
  'Druddigon', 'Golett', 'Golurk', 'Pawniard', 'Bisharp', 'Bouffalant', 'Rufflet', 'Braviary', 'Vullaby', 'Mandibuzz',
  'Heatmor', 'Durant', 'Deino', 'Zweilous', 'Hydreigon', 'Larvesta', 'Volcarona', 'Cobalion', 'Terrakion', 'Virizion',
  'Tornadus', 'Thundurus', 'Reshiram', 'Zekrom', 'Landorus', 'Kyurem', 'Keldeo', 'Meloetta', 'Genesect',
] as const

const EMERALD_INTERNAL_TO_NATIONAL: Record<number, number> = {
  252: 201, 253: 201, 254: 201, 255: 201, 256: 201, 257: 201, 258: 201, 259: 201,
  260: 201, 261: 201, 262: 201, 263: 201, 264: 201, 265: 201, 266: 201, 267: 201,
  268: 201, 269: 201, 270: 201, 271: 201, 272: 201, 273: 201, 274: 201, 275: 201,
  276: 201,
  277: 252, 278: 253, 279: 254, 280: 255, 281: 256, 282: 257, 283: 258, 284: 259,
  285: 260, 286: 261, 287: 262, 288: 263, 289: 264, 290: 265, 291: 266, 292: 267,
  293: 268, 294: 269, 295: 270, 296: 271, 297: 272, 298: 273, 299: 274, 300: 275,
  301: 290, 302: 291, 303: 292, 304: 276, 305: 277, 306: 285, 307: 286, 308: 327,
  309: 278, 310: 279, 311: 283, 312: 284, 313: 320, 314: 321, 315: 300, 316: 301,
  317: 352, 318: 343, 319: 344, 320: 299, 321: 324, 322: 302, 323: 339, 324: 340,
  325: 370, 326: 341, 327: 342, 328: 349, 329: 350, 330: 318, 331: 319, 332: 328,
  333: 329, 334: 330, 335: 296, 336: 297, 337: 309, 338: 310, 339: 322, 340: 323,
  341: 363, 342: 364, 343: 365, 344: 331, 345: 332, 346: 361, 347: 362, 348: 337,
  349: 338, 350: 298, 351: 325, 352: 326, 353: 311, 354: 312, 355: 303, 356: 307,
  357: 308, 358: 333, 359: 334, 360: 360, 361: 355, 362: 356, 363: 315, 364: 287,
  365: 288, 366: 289, 367: 316, 368: 317, 369: 357, 370: 293, 371: 294, 372: 295,
  373: 366, 374: 367, 375: 368, 376: 359, 377: 353, 378: 354, 379: 336, 380: 335,
  381: 369, 382: 304, 383: 305, 384: 306, 385: 351, 386: 313, 387: 314, 388: 345,
  389: 346, 390: 347, 391: 348, 392: 280, 393: 281, 394: 282, 395: 371, 396: 372,
  397: 373, 398: 374, 399: 375, 400: 376, 401: 377, 402: 378, 403: 379, 404: 382,
  405: 383, 406: 384, 407: 380, 408: 381, 409: 385, 410: 386, 411: 358,
}

const VERSION_SPRITE_PATH: Record<GameId, string> = {
  red: 'generation-i/red-blue',
  blue: 'generation-i/red-blue',
  yellow: 'generation-i/yellow',
  gold: 'generation-ii/gold',
  silver: 'generation-ii/silver',
  crystal: 'generation-ii/crystal',
  ruby: 'generation-iii/ruby-sapphire',
  sapphire: 'generation-iii/ruby-sapphire',
  emerald: 'generation-iii/emerald',
  firered: 'generation-iii/firered-leafgreen',
  leafgreen: 'generation-iii/firered-leafgreen',
  diamond: 'generation-iv/diamond-pearl',
  pearl: 'generation-iv/diamond-pearl',
  platinum: 'generation-iv/platinum',
  heartgold: 'generation-iv/heartgold-soulsilver',
  soulsilver: 'generation-iv/heartgold-soulsilver',
  black: 'generation-v/black-white',
  white: 'generation-v/black-white',
  black2: 'generation-v/black-white',
  white2: 'generation-v/black-white',
}

const NATIONAL_ID_BY_NAME = new Map(
  NATIONAL_SPECIES_NAMES.map((name, index) => [normalizePokemonName(name), index + 1]),
)

export interface ResolvedPartySpecies {
  name: string
  nationalDexId: number | null
}

export function emeraldInternalSpeciesToNational(internalSpeciesId: number) {
  if (internalSpeciesId >= 1 && internalSpeciesId <= 251) return internalSpeciesId
  return EMERALD_INTERNAL_TO_NATIONAL[internalSpeciesId] ?? null
}

export function resolvePartySpecies(gameId: GameId, member: PartyMember): ResolvedPartySpecies {
  let nationalDexId = member.speciesId ?? null

  if (!nationalDexId) {
    const rawNumericId = /^#(\d+)$/.exec(member.species.trim())
    if (rawNumericId) {
      const rawId = Number(rawNumericId[1])
      nationalDexId = gameId === 'emerald'
        ? emeraldInternalSpeciesToNational(rawId)
        : rawId
    } else {
      nationalDexId = NATIONAL_ID_BY_NAME.get(normalizePokemonName(member.species)) ?? null
    }
  }

  return {
    name: nationalDexId ? getPokemonSpeciesName(nationalDexId) : member.species,
    nationalDexId,
  }
}

export function getPokemonSpeciesName(nationalDexId: number) {
  return NATIONAL_SPECIES_NAMES[nationalDexId - 1] ?? `#${nationalDexId}`
}

export function getPokemonSpriteUrl(gameId: GameId, nationalDexId?: number | null) {
  if (!nationalDexId || nationalDexId < 1) return null
  const versionPath = VERSION_SPRITE_PATH[gameId]
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/${versionPath}/${nationalDexId}.png`
}

export function formatPartyLabel(nickname: string, species: string) {
  const cleanNickname = nickname.trim()
  const cleanSpecies = species.trim()

  if (!cleanNickname || normalizePokemonName(cleanNickname) === normalizePokemonName(cleanSpecies)) {
    return cleanSpecies
  }

  return `${formatNickname(cleanNickname)} (${cleanSpecies})`
}

function normalizePokemonName(value: string) {
  return value
    .toLowerCase()
    .replaceAll('♀', 'f')
    .replaceAll('♂', 'm')
    .replace(/[^a-z0-9]/g, '')
}

function formatNickname(nickname: string) {
  if (nickname !== nickname.toUpperCase() || !/[A-Z]/.test(nickname)) return nickname

  return nickname
    .toLowerCase()
    .replace(/(^|[\s-])([a-z])/g, (_, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`)
}
