import type { mGBAEmulator } from '@thenick775/mgba-wasm'
import type { PartyMember } from '../../../types'

export interface EmeraldLiveSnapshot {
  capturedAt: number
  currentMap: string
  mapGroup: number
  mapNum: number
  party: PartyMember[]
}

type HeapBackedMgba = mGBAEmulator & {
  HEAPU8?: Uint8Array
  wasmMemory?: WebAssembly.Memory
}

type MemoryCandidate = {
  iwram: number
  ewram: number
  score: number
}

const EWRAM_BASE = 0x02000000
const EWRAM_SIZE = 0x00040000
const IWRAM_BASE = 0x03000000
const IWRAM_SIZE = 0x00008000

const SAVE_BLOCK_1_PTR = 0x03005d8c
const SAVE_BLOCK_2_PTR = 0x03005d90
const POKEMON_STORAGE_PTR = 0x03005d94
const PARTY_COUNT = 0x020244e9
const PARTY_BASE = 0x020244ec
const PARTY_MON_SIZE = 100

const SAVE_BLOCK_1_PTR_OFFSET = SAVE_BLOCK_1_PTR - IWRAM_BASE
const SCAN_WORDS_PER_PASS = 2_000_000
const MAX_EMERALD_SPECIES_ID = 411

const SUBSTRUCT_SELECTOR = [
  [0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 1, 3], [0, 3, 1, 2],
  [0, 2, 3, 1], [0, 3, 2, 1], [1, 0, 2, 3], [1, 0, 3, 2],
  [2, 0, 1, 3], [3, 0, 1, 2], [2, 0, 3, 1], [3, 0, 2, 1],
  [1, 2, 0, 3], [1, 3, 0, 2], [2, 1, 0, 3], [3, 1, 0, 2],
  [2, 3, 0, 1], [3, 2, 0, 1], [1, 2, 3, 0], [1, 3, 2, 0],
  [2, 1, 3, 0], [3, 1, 2, 0], [2, 3, 1, 0], [3, 2, 1, 0],
] as const

const MAP_GROUPS: Record<number, readonly string[]> = {
  0: [
    'PetalburgCity', 'SlateportCity', 'MauvilleCity', 'RustboroCity', 'FortreeCity',
    'LilycoveCity', 'MossdeepCity', 'SootopolisCity', 'EverGrandeCity', 'LittlerootTown',
    'OldaleTown', 'DewfordTown', 'LavaridgeTown', 'FallarborTown', 'VerdanturfTown',
    'PacifidlogTown', 'Route101', 'Route102', 'Route103', 'Route104', 'Route105',
    'Route106', 'Route107', 'Route108', 'Route109', 'Route110', 'Route111', 'Route112',
    'Route113', 'Route114', 'Route115', 'Route116', 'Route117', 'Route118', 'Route119',
    'Route120', 'Route121', 'Route122', 'Route123', 'Route124', 'Route125', 'Route126',
    'Route127', 'Route128', 'Route129', 'Route130', 'Route131', 'Route132', 'Route133',
    'Route134', 'Underwater_Route124', 'Underwater_Route126', 'Underwater_Route127',
    'Underwater_Route128', 'Underwater_Route129', 'Underwater_Route105', 'Underwater_Route125',
  ],
  1: [
    'LittlerootTown_BrendansHouse_1F',
    'LittlerootTown_BrendansHouse_2F',
    'LittlerootTown_MaysHouse_1F',
    'LittlerootTown_MaysHouse_2F',
    'LittlerootTown_ProfessorBirchsLab',
  ],
  2: [
    'OldaleTown_House1',
    'OldaleTown_House2',
    'OldaleTown_PokemonCenter_1F',
    'OldaleTown_PokemonCenter_2F',
    'OldaleTown_Mart',
  ],
}

/**
 * Reads Pokémon Emerald state from mGBA's shared WASM heap.
 *
 * mGBA allocates GBA EWRAM and IWRAM as one contiguous block. PokéRun locates
 * that block by finding Emerald's adjacent save-pointer globals. Multiple copies
 * of RAM-like data can exist in the WASM heap, so the reader scans a full pass
 * and chooses the strongest candidate instead of accepting the first match.
 */
export class EmeraldLiveStateReader {
  private iwramHeapBase: number | null = null
  private ewramHeapBase: number | null = null
  private heapBuffer: ArrayBufferLike | null = null
  private scanWordIndex = 0
  private scanPass = 0
  private bestCandidate: MemoryCandidate | null = null
  private diagnostic = 'SEARCHING RAM 0%'

  constructor(private readonly emulator: mGBAEmulator) {}

  getDiagnostic() {
    return this.diagnostic
  }

  readSnapshot(): EmeraldLiveSnapshot | null {
    const heap = this.getHeap()
    if (!heap) {
      this.diagnostic = 'WASM HEAP UNAVAILABLE'
      return null
    }

    if (this.heapBuffer !== heap.buffer) {
      this.heapBuffer = heap.buffer
      this.resetLayout()
    }

    if (!this.ensureLayout(heap)) return null

    const saveBlock1 = this.readU32(heap, SAVE_BLOCK_1_PTR)
    if (!isEwramAddress(saveBlock1)) {
      this.resetLayout()
      return null
    }

    const mapGroup = this.readU8(heap, saveBlock1 + 4)
    const mapNum = this.readU8(heap, saveBlock1 + 5)
    const mapLayoutId = this.readU16(heap, saveBlock1 + 0x32)
    const partyCount = this.readU8(heap, PARTY_COUNT)

    if (partyCount > 6 || mapGroup > 33 || mapLayoutId === 0) {
      this.resetLayout()
      return null
    }

    const party: PartyMember[] = []
    for (let index = 0; index < partyCount; index += 1) {
      const member = this.readPartyMember(heap, PARTY_BASE + index * PARTY_MON_SIZE, index)
      if (member) party.push(member)
    }

    if (party.length !== partyCount) {
      this.resetLayout()
      return null
    }

    this.diagnostic = 'CONNECTED'
    return {
      capturedAt: Date.now(),
      currentMap: getMapName(mapGroup, mapNum),
      mapGroup,
      mapNum,
      party,
    }
  }

  private getHeap() {
    const module = this.emulator as HeapBackedMgba
    if (module.HEAPU8 && module.HEAPU8.byteLength > 0) return module.HEAPU8

    const buffer = module.wasmMemory?.buffer
    if (buffer) return new Uint8Array(buffer)

    return null
  }

  private ensureLayout(heap: Uint8Array) {
    if (this.iwramHeapBase !== null && this.ewramHeapBase !== null) return true
    if (heap.byteOffset % 4 !== 0) {
      this.diagnostic = 'WASM HEAP MISALIGNED'
      return false
    }

    const words = new Uint32Array(
      heap.buffer,
      heap.byteOffset,
      Math.floor(heap.byteLength / Uint32Array.BYTES_PER_ELEMENT),
    )
    const minimumPointerWord = Math.ceil((EWRAM_SIZE + SAVE_BLOCK_1_PTR_OFFSET) / 4)
    const start = Math.max(this.scanWordIndex, minimumPointerWord)
    const end = Math.min(words.length - 2, start + SCAN_WORDS_PER_PASS)

    for (let index = start; index < end; index += 1) {
      const save1 = words[index] >>> 0
      if (!isEwramAddress(save1)) continue

      const save2 = words[index + 1] >>> 0
      const storage = words[index + 2] >>> 0
      if (
        !isEwramAddress(save2)
        || !isEwramAddress(storage)
        || save1 === save2
        || save1 === storage
        || save2 === storage
      ) {
        continue
      }

      const pointerHeapOffset = index * 4
      const iwram = pointerHeapOffset - SAVE_BLOCK_1_PTR_OFFSET
      const ewram = iwram - EWRAM_SIZE
      if (ewram < 0 || iwram + IWRAM_SIZE > heap.byteLength) continue

      const score = this.scoreMemoryPair(heap, iwram, ewram)
      if (score === null) continue

      if (!this.bestCandidate || score > this.bestCandidate.score) {
        this.bestCandidate = { iwram, ewram, score }
      }
    }

    if (end >= words.length - 2) {
      if (this.bestCandidate) {
        this.iwramHeapBase = this.bestCandidate.iwram
        this.ewramHeapBase = this.bestCandidate.ewram
        this.diagnostic = `RAM CANDIDATE ${this.bestCandidate.score}`
        this.bestCandidate = null
        this.scanWordIndex = minimumPointerWord
        return true
      }

      this.scanPass += 1
      this.scanWordIndex = minimumPointerWord
      this.diagnostic = `RAM SIGNATURE NOT FOUND • RETRY ${this.scanPass}`
      return false
    }

    this.scanWordIndex = end
    const scannedBytes = Math.max(0, end * 4 - (EWRAM_SIZE + SAVE_BLOCK_1_PTR_OFFSET))
    const searchableBytes = Math.max(1, heap.byteLength - (EWRAM_SIZE + SAVE_BLOCK_1_PTR_OFFSET))
    const percent = Math.min(99, Math.floor(scannedBytes / searchableBytes * 100))
    const best = this.bestCandidate ? ` • BEST ${this.bestCandidate.score}` : ''
    this.diagnostic = `SEARCHING RAM ${percent}%${best}`
    return false
  }

  private scoreMemoryPair(heap: Uint8Array, iwramBase: number, ewramBase: number) {
    if (ewramBase + EWRAM_SIZE !== iwramBase) return null
    if (iwramBase + IWRAM_SIZE > heap.byteLength) return null

    const save1 = readHeapU32(heap, iwramBase + (SAVE_BLOCK_1_PTR - IWRAM_BASE))
    const save2 = readHeapU32(heap, iwramBase + (SAVE_BLOCK_2_PTR - IWRAM_BASE))
    const storage = readHeapU32(heap, iwramBase + (POKEMON_STORAGE_PTR - IWRAM_BASE))
    if (!isEwramAddress(save1) || !isEwramAddress(save2) || !isEwramAddress(storage)) return null
    if ((save1 & 3) !== 0 || (save2 & 3) !== 0 || (storage & 3) !== 0) return null

    const save1Heap = ewramBase + (save1 - EWRAM_BASE)
    const save2Heap = ewramBase + (save2 - EWRAM_BASE)
    const storageHeap = ewramBase + (storage - EWRAM_BASE)
    const partyCountHeap = ewramBase + (PARTY_COUNT - EWRAM_BASE)
    const partyHeap = ewramBase + (PARTY_BASE - EWRAM_BASE)

    if (
      save1Heap + 0x239 >= iwramBase
      || save2Heap + 0x0b >= iwramBase
      || storageHeap >= iwramBase
      || partyCountHeap >= iwramBase
      || partyHeap + PARTY_MON_SIZE * 6 > iwramBase
    ) {
      return null
    }

    const mapGroup = heap[save1Heap + 4]
    const mapNum = heap[save1Heap + 5]
    const mapLayoutId = readHeapU16(heap, save1Heap + 0x32)
    const currentBox = heap[storageHeap]
    const partyCount = heap[partyCountHeap]
    const playerGender = heap[save2Heap + 8]
    const playerName = decodeGen3Text(heap.slice(save2Heap, save2Heap + 8))

    if (
      mapLayoutId === 0
      || mapGroup > 33
      || mapNum > 127
      || currentBox > 13
      || partyCount > 6
      || playerGender > 1
      || !playerName
    ) {
      return null
    }

    let score = 40
    if (MAP_GROUPS[mapGroup]?.[mapNum]) score += 25
    score += 20 // valid trainer name + gender from SaveBlock2

    const savedPartyCount = heap[save1Heap + 0x234]
    if (savedPartyCount <= 6 && savedPartyCount === partyCount) score += 20

    if (partyCount === 0) {
      const firstPersonality = readHeapU32(heap, partyHeap)
      if (firstPersonality === 0) score += 5
      return score
    }

    score += 100 + partyCount * 20
    for (let index = 0; index < partyCount; index += 1) {
      const memberScore = scoreRawPartyMember(heap, partyHeap + index * PARTY_MON_SIZE)
      if (memberScore === null) return null
      score += memberScore
    }

    return score
  }

  private readPartyMember(heap: Uint8Array, address: number, index: number): PartyMember | null {
    const personality = this.readU32(heap, address)
    if (personality === 0) return null

    const otId = this.readU32(heap, address + 4)
    const nickname = decodeGen3Text(this.readBytes(heap, address + 8, 10)) || `SLOT ${index + 1}`
    const level = this.readU8(heap, address + 0x54)
    const hp = this.readU16(heap, address + 0x56)
    const maxHp = this.readU16(heap, address + 0x58)
    const rawStatus = this.readU32(heap, address + 0x50)
    const speciesId = decryptSpeciesIdFromAddress(heap, this.toHeapOffset(address, PARTY_MON_SIZE), personality, otId)

    if (
      level === 0
      || level > 100
      || hp > maxHp
      || maxHp === 0
      || maxHp > 999
      || speciesId === 0
      || speciesId > MAX_EMERALD_SPECIES_ID
    ) {
      return null
    }

    return {
      id: `emerald-${index}-${personality.toString(16).padStart(8, '0')}`,
      species: `#${speciesId}`,
      nickname,
      level,
      hp,
      maxHp,
      status: getStatus(rawStatus, hp),
    }
  }

  private readBytes(heap: Uint8Array, address: number, length: number) {
    const offset = this.toHeapOffset(address, length)
    if (offset === null) return new Uint8Array()
    return heap.slice(offset, offset + length)
  }

  private readU8(heap: Uint8Array, address: number) {
    const offset = this.toHeapOffset(address, 1)
    return offset === null ? 0 : heap[offset]
  }

  private readU16(heap: Uint8Array, address: number) {
    const offset = this.toHeapOffset(address, 2)
    if (offset === null) return 0
    return heap[offset] + heap[offset + 1] * 0x100
  }

  private readU32(heap: Uint8Array, address: number) {
    const offset = this.toHeapOffset(address, 4)
    if (offset === null) return 0
    return readHeapU32(heap, offset)
  }

  private toHeapOffset(address: number, length: number) {
    if (isEwramAddress(address) && this.ewramHeapBase !== null) {
      const offset = this.ewramHeapBase + (address - EWRAM_BASE)
      return offset + length <= this.ewramHeapBase + EWRAM_SIZE ? offset : null
    }

    if (address >= IWRAM_BASE && address < IWRAM_BASE + IWRAM_SIZE && this.iwramHeapBase !== null) {
      const offset = this.iwramHeapBase + (address - IWRAM_BASE)
      return offset + length <= this.iwramHeapBase + IWRAM_SIZE ? offset : null
    }

    return null
  }

  private resetLayout() {
    this.iwramHeapBase = null
    this.ewramHeapBase = null
    this.scanWordIndex = 0
    this.bestCandidate = null
    this.diagnostic = 'SEARCHING RAM 0%'
  }
}

function scoreRawPartyMember(heap: Uint8Array, offset: number) {
  if (offset < 0 || offset + PARTY_MON_SIZE > heap.byteLength) return null

  const personality = readHeapU32(heap, offset)
  const otId = readHeapU32(heap, offset + 4)
  const level = heap[offset + 0x54]
  const hp = readHeapU16(heap, offset + 0x56)
  const maxHp = readHeapU16(heap, offset + 0x58)
  const speciesId = decryptSpeciesIdFromAddress(heap, offset, personality, otId)

  if (
    personality === 0
    || level === 0
    || level > 100
    || maxHp === 0
    || maxHp > 999
    || hp > maxHp
    || speciesId === 0
    || speciesId > MAX_EMERALD_SPECIES_ID
  ) {
    return null
  }

  let score = 40
  const nickname = decodeGen3Text(heap.slice(offset + 8, offset + 18))
  if (nickname) score += 15
  return score
}

function decryptSpeciesIdFromAddress(
  heap: Uint8Array,
  offset: number | null,
  personality: number,
  otId: number,
) {
  if (offset === null || offset < 0 || offset + PARTY_MON_SIZE > heap.byteLength) return 0

  const key = (personality ^ otId) >>> 0
  const order = SUBSTRUCT_SELECTOR[personality % 24]
  const growthPhysicalIndex = order.indexOf(0)
  if (growthPhysicalIndex < 0) return 0

  const encryptedGrowthWord = readHeapU32(heap, offset + 0x20 + growthPhysicalIndex * 12)
  return ((encryptedGrowthWord ^ key) >>> 0) & 0xffff
}

function readHeapU16(heap: Uint8Array, offset: number) {
  if (offset < 0 || offset + 2 > heap.byteLength) return 0
  return heap[offset] + heap[offset + 1] * 0x100
}

function readHeapU32(heap: Uint8Array, offset: number) {
  if (offset < 0 || offset + 4 > heap.byteLength) return 0
  return (
    heap[offset]
    + heap[offset + 1] * 0x100
    + heap[offset + 2] * 0x10000
    + heap[offset + 3] * 0x1000000
  ) >>> 0
}

function isEwramAddress(address: number) {
  return address >= EWRAM_BASE && address < EWRAM_BASE + EWRAM_SIZE
}

function decodeGen3Text(bytes: Uint8Array) {
  let value = ''

  for (const byte of bytes) {
    if (byte === 0xff) break
    if (byte === 0x00) value += ' '
    else if (byte >= 0xa1 && byte <= 0xaa) value += String(byte - 0xa1)
    else if (byte >= 0xbb && byte <= 0xd4) value += String.fromCharCode(65 + byte - 0xbb)
    else if (byte >= 0xd5 && byte <= 0xee) value += String.fromCharCode(97 + byte - 0xd5)
    else if (byte === 0xab) value += '!'
    else if (byte === 0xac) value += '?'
    else if (byte === 0xad) value += '.'
    else if (byte === 0xae) value += '-'
    else if (byte === 0xb4) value += "'"
    else if (byte === 0xb5) value += '♂'
    else if (byte === 0xb6) value += '♀'
  }

  return value.trim()
}

function getStatus(rawStatus: number, hp: number): PartyMember['status'] {
  if (hp === 0) return 'FAINTED'
  if (rawStatus & 0x7) return 'SLP'
  if (rawStatus & 0x88) return 'PSN'
  if (rawStatus & 0x10) return 'BRN'
  if (rawStatus & 0x20) return 'FRZ'
  if (rawStatus & 0x40) return 'PAR'
  return 'OK'
}

function getMapName(group: number, map: number) {
  const rawName = MAP_GROUPS[group]?.[map]
  if (!rawName) return `Map ${group}:${map}`

  return rawName
    .replaceAll('_', ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d+)/g, '$1 $2')
    .replace(/\bPokemon\b/g, 'Pokémon')
}
