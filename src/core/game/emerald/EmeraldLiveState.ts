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

const PAGE_SIZE = 0x1000
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
 * mGBA allocates GBA EWRAM and IWRAM as one contiguous block:
 * EWRAM first, then IWRAM exactly 0x40000 bytes later. PokéRun locates IWRAM by
 * the three fixed Emerald save-block pointer globals, then derives EWRAM directly.
 * This avoids depending on mGBA's internal C struct layout.
 */
export class EmeraldLiveStateReader {
  private iwramHeapBase: number | null = null
  private ewramHeapBase: number | null = null
  private heapBuffer: ArrayBufferLike | null = null

  constructor(private readonly emulator: mGBAEmulator) {}

  readSnapshot(): EmeraldLiveSnapshot | null {
    const heap = this.getHeap()
    if (!heap) return null

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

    if (partyCount > 6 || mapGroup > 33) {
      this.resetLayout()
      return null
    }

    const party: PartyMember[] = []
    for (let index = 0; index < partyCount; index += 1) {
      const member = this.readPartyMember(heap, PARTY_BASE + index * PARTY_MON_SIZE, index)
      if (member) party.push(member)
    }

    return {
      capturedAt: Date.now(),
      currentMap: mapLayoutId === 0 ? 'Loading overworld' : getMapName(mapGroup, mapNum),
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

    const iwram = this.locateIwram(heap)
    if (iwram === null) return false

    // mGBA allocates EWRAM + IWRAM in one block and sets iwram = wram + 0x40000.
    const ewram = iwram - EWRAM_SIZE
    if (ewram < 0 || ewram % PAGE_SIZE !== 0) return false
    if (!this.validateMemoryPair(heap, iwram, ewram)) return false

    this.iwramHeapBase = iwram
    this.ewramHeapBase = ewram
    return true
  }

  private locateIwram(heap: Uint8Array) {
    const save1Offset = SAVE_BLOCK_1_PTR - IWRAM_BASE
    const save2Offset = SAVE_BLOCK_2_PTR - IWRAM_BASE
    const storageOffset = POKEMON_STORAGE_PTR - IWRAM_BASE

    for (let base = EWRAM_SIZE; base + IWRAM_SIZE <= heap.byteLength; base += PAGE_SIZE) {
      const save1 = readHeapU32(heap, base + save1Offset)
      const save2 = readHeapU32(heap, base + save2Offset)
      const storage = readHeapU32(heap, base + storageOffset)

      if (
        isEwramAddress(save1)
        && isEwramAddress(save2)
        && isEwramAddress(storage)
        && save1 !== save2
        && save1 !== storage
        && save2 !== storage
      ) {
        const ewram = base - EWRAM_SIZE
        if (ewram >= 0 && this.validateMemoryPair(heap, base, ewram)) return base
      }
    }

    return null
  }

  private validateMemoryPair(heap: Uint8Array, iwramBase: number, ewramBase: number) {
    if (ewramBase + EWRAM_SIZE !== iwramBase) return false
    if (iwramBase + IWRAM_SIZE > heap.byteLength) return false

    const save1 = readHeapU32(heap, iwramBase + (SAVE_BLOCK_1_PTR - IWRAM_BASE))
    const save2 = readHeapU32(heap, iwramBase + (SAVE_BLOCK_2_PTR - IWRAM_BASE))
    const storage = readHeapU32(heap, iwramBase + (POKEMON_STORAGE_PTR - IWRAM_BASE))
    if (!isEwramAddress(save1) || !isEwramAddress(save2) || !isEwramAddress(storage)) return false

    const save1Heap = ewramBase + (save1 - EWRAM_BASE)
    const storageHeap = ewramBase + (storage - EWRAM_BASE)
    const partyCountHeap = ewramBase + (PARTY_COUNT - EWRAM_BASE)

    if (save1Heap + 0x34 >= iwramBase || storageHeap >= iwramBase || partyCountHeap >= iwramBase) return false

    const mapGroup = heap[save1Heap + 4]
    const mapNum = heap[save1Heap + 5]
    const currentBox = heap[storageHeap]
    const partyCount = heap[partyCountHeap]

    return mapGroup <= 33 && mapNum <= 127 && currentBox <= 13 && partyCount <= 6
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

    const key = (personality ^ otId) >>> 0
    const growthPhysicalIndex = SUBSTRUCT_SELECTOR[personality % 24][0]
    const encryptedGrowthWord = this.readU32(heap, address + 0x20 + growthPhysicalIndex * 12)
    const speciesId = ((encryptedGrowthWord ^ key) >>> 0) & 0xffff

    if (level > 100 || hp > maxHp || maxHp > 999) return null

    return {
      id: `emerald-${index}-${personality.toString(16).padStart(8, '0')}`,
      species: speciesId ? `#${speciesId}` : 'UNKNOWN',
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
  }
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
