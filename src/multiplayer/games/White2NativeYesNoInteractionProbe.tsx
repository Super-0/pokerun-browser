import { useEffect, useRef } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../core/protocol'
import { White2ActorSystemProbe } from './White2ActorSystem'
import { auditWhite2AsciiFont, composeWhite2GlyphInTileRam, composeWhite2GlyphOverExistingTiles, decodeWhite2PackedFontGlyph, simulateWhite2AsciiLine, verifyWhite2FontGlyphFromRom } from './White2RomFontArchiveVerifier'
import { WHITE2_INTERACT_EVENT } from './White2PlayerInteractionRuntime'

const FLD_ACT_GET_FIELD_EFFECTS = 0x02194f18
const FIELD_EFFECTS_GET_FIELD = 0x021a3760
const FIELD_GET_MSGBG_SYS = 0x021804d0
const FIELD_GET_HEAP_ID = 0x02180500
const FIELD_GET_CONTROLLER_TYPE_ID = 0x0218056c

const GFL_BGSYS_ALLOC_CHAR = 0x02044590
const GFL_BGSYS_FREE_CHAR_MEMORY = 0x02044694
const GFL_BGSYS_LOAD_SCR_CORE = 0x02044fdc
const GFL_BGSYS_LOAD_CHAR = 0x020450ac
const GFL_BGSYS_GET_BG_MODE = 0x0204587c
const GFL_BGSYS_GET_BG_COLOR_PALETTE_MODE = 0x02045890
const GFL_BGSYS_GET_BG_BYTES_PER_TILE = 0x020458a4
const GFL_BITMAP_CREATE = 0x02046e54
const GFL_BITMAP_FREE = 0x02046f08
const GFL_BITMAP_FILL = 0x02047168
const BMP_WIN_CREATE_DYNAMIC = 0x020480ec
const BMP_WIN_FLUSH_MAP = 0x02048298
const BMP_WIN_DRAW_FRAME = 0x02024eac
const GFL_STRBUF_CREATE = 0x0204855c
const GFL_FONT_GET_CHAR_WIDTH = 0x02023208
const GFL_FONT_GET_CHAR_INDEX = 0x020230bc
const GFL_STRBUF_APPEND = 0x02048760
const GFL_STRBUF_FREE = 0x02048590

const FIELDMAP_CTRL_GRID = 0
const MSGBG_BG2 = 2
const MSGBG_PLTT_BG2 = 14
const MSGBG_PLTT_BG2_FRAME = 13
const MSGBG_CHAR_FRAME = 1
const WINFRAME_TRANSFER_NONE = 2
const MSGBG_COLOR_BG_FILL = 0xff
const WINDOW_WIDTH = 12
const WINDOW_HEIGHT = 5
const WINDOW_X = 18
const WINDOW_Y = 2
const TEXT_BG_WIDTH_TILES = 32
const CHAR_DMA_THRESHOLD = 48
const SCREEN_DMA_THRESHOLD = 28
const SCREEN_ROW_BYTES = WINDOW_WIDTH * 2
const FRAME_FULL_ROW_BYTES = (WINDOW_WIDTH + 2) * 2
const STRBUF_MAGIC = 0xb6f8d2ec
const STRBUF_TERMINATOR = 0xffff
const STRBUF_PROBE_CHAR = 0x0041 // 'A', the standard Unicode character code supported by the decompiled font map.
const AREAMAN_FAIL = 0xffffffff
const NATIVE_STACK_RESERVE = 0x800
const PRK31_ROM_RANGE_ONLY = false // Retained read-only diagnostic fallback.
const PRK33_FOUR_ARG_BG2_VISUAL = true // PRK34 routes all calls through Thumb4; Thumb8 relocation is forbidden.
const EXPECTED_STABLE_PLAYER_MODEL = 240
// PRK36: exact-ROM data captured from PRK29/31. Used for read-only font
// verification even when it is unsafe to inject ANY native guest call.
const WHITE2_KNOWN_FIELD_MSGBG = 0x02271cb0
// Nitro's DTCM stack worked in PRK34 at 0x02FE33C8. Restrict this
// research probe to the observed safe upper DTCM band with a full 0x800
// reserved below SP. SP=0x0214C470 belongs to the idle thread's BSS
// stack region, where heap-backed calls repeatedly enter ARM9 abort mode.
const PRK36_VALID_STACK_LO = 0x02fe2800
const PRK36_VALID_STACK_HI = 0x02fe4000
const PRK36_FRAME_POLLS = 240
// PRK43: White 2's BGSys pointer is a static US ARM9 BSS symbol.
// BGSysBG has 44 bytes, with eight records following an 8-byte header.
// The BG2 screenBase array follows those records + two charArea pointers.
const PRK43_BGSYS_GLOBAL_PTR = 0x0214194c
const PRK43_BGSYS_BG2_RECORD_OFFSET = 8 + 2 * 44
const PRK43_BGSYS_BG2_SCREEN_BASE_OFFSET = 8 + 8 * 44 + 2 * 4 + 8 * 4 + 2 * 4
const PRK43_BG2_CONTROL_REGISTER = 0x0400000c
const PRK43_MAIN_BG_VRAM_BASE = 0x06000000
// PRK46: BGSys.charAreas[MAIN] follows the eight 44-byte BG records;
// charBase[BG2] and charSize[BG2] follow both AreaMan pointers.
const PRK46_BGSYS_MAIN_AREA_PTR_OFFSET = 8 + 8 * 44
const PRK46_BGSYS_BG2_CHAR_BASE_OFFSET = 8 + 8 * 44 + 2 * 4 + 2 * 4
const PRK46_BGSYS_BG2_CHAR_SIZE_OFFSET = 8 + 8 * 44 + 2 * 4 + 8 * 4 + 8 * 4 + 2 * 4
const WHITE2_NATIVE_MENU_STATE_EVENT = 'pokerun:white2-native-menu-state'
// PRK54: ONE manually opened native window, bounded Up/Down Yes/No
// choice navigation, one guarded close. No native menu or multiplayer action.
const PRK53_MAX_VERIFIED_CLOSES = 1
const PRK54_MAX_NAVIGATIONS = 4

type AtomicRuntime = {
  callArm9Thumb8Atomic(
    functionAddress: number,
    r0: number,
    r1: number,
    r2: number,
    r3: number,
    r4stack: number,
    r5stack: number,
    r6stack: number,
    r7stack: number,
    stackReserve: number,
  ): number
  arm9CallStatus(): number
  arm9CallPc(): number
  arm9CallLr(): number
  arm9CallCpsr(): number
  arm9CallInstructions(): number
}

type ProbeState = { window: number }
type Prk50CloseContext = {
  playerActor: number
  baseline: Prk43Bg2MapSnapshot
  bg: number
  charPos: number
  bitmap: number
  pixels: number
  heapId: number
  fontLayout: { memberStart: number; memberLength: number; glyphsOffset: number }
}
type Prk51ClosedBaseline = {
  playerActor: number
  baseline: Prk43Bg2MapSnapshot
  areaMan: number
}
type Prk43Bg2MapSnapshot = {
  bgSys: number
  screenPtr: number
  screenSize: number
  screenOffset: number
  screenBase: number
  mode: number
  colorMode: number
  tileSize: number
  controlScreenBase: number
  ramMap: number[] | null
  vramMap: number[] | null
  capturedPositions: number
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= 0x02000000 && value < 0x02400000 && (value & 3) === 0
}

function hex(value: number) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

// Two independent 15px-high lines fit at Y=8 and Y=24 inside the verified
// 96x40 native GFLBitmap. The ROM composer already draws line 1 at Y=8
// (tile rows 1 and 2), so line 2 is shifted down by exactly TWO tile rows.
// Only owned 32-byte character tiles are combined, never BG2 screen-map cells.
function composePrk54YesNoMenu(
  rom: Uint8Array,
  layout: { memberStart: number; memberLength: number; glyphsOffset: number },
  choice: 'yes' | 'no',
) {
  const question = simulateWhite2AsciiLine(
    rom, layout.memberStart, layout.memberLength, layout.glyphsOffset,
    'Trade with me?',
  )
  const choicesText = choice === 'yes' ? '>Yes   No' : ' Yes  >No'
  const choices = simulateWhite2AsciiLine(
    rom, layout.memberStart, layout.memberLength, layout.glyphsOffset,
    choicesText,
  )
  const safeLine = (line: typeof question) =>
    line.penAdvancePx <= WINDOW_WIDTH * 8 - 16 &&
    line.clippedPixels === 0 && line.overlappingPixels === 0 &&
    line.tiles.length === WINDOW_WIDTH * WINDOW_HEIGHT * 32
  if (!safeLine(question) || !safeLine(choices) ||
      choices.dirtyTileIndices.length < 1) {
    throw new Error('PRK54 question/choices ROM raster does not fit the owned 96x40 bitmap.')
  }
  const combined = question.tiles.slice()
  for (const tile of choices.dirtyTileIndices) {
    // The second line starts 16px (2 rows) lower, at Y=24.
    const shiftedTile = tile + WINDOW_WIDTH * 2
    if (tile < WINDOW_WIDTH || tile >= WINDOW_WIDTH * 3 ||
        shiftedTile >= WINDOW_WIDTH * WINDOW_HEIGHT) {
      throw new Error('PRK54 second-line dirty tile index outside two-line layout.')
    }
    combined.set(
      choices.tiles.subarray(tile * 32, (tile + 1) * 32),
      shiftedTile * 32,
    )
  }
  let fnv = 0x811c9dc5
  for (const byte of combined) {
    fnv = Math.imul(fnv ^ byte, 0x01000193) >>> 0
  }
  return {
    tiles: combined,
    hash: hex(fnv),
    questionWidthPx: question.penAdvancePx,
    choicesWidthPx: choices.penAdvancePx,
    choice,
    choicesText,
  }
}

export function White2NativeYesNoInteractionProbe({ bridge, rom, romBytes }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity; romBytes?: Uint8Array }) {
  const stateRef = useRef<ProbeState | null>(null)
  const openingRef = useRef(false)
  const metadataCompleteRef = useRef(false)
  const prk50CloseContextRef = useRef<Prk50CloseContext | null>(null)
  const prk50CloseAttemptedRef = useRef(false)
  const prk53SwapAttemptedRef = useRef(false)
  const prk53TextSwappedRef = useRef(false)
  const prk54ChoiceRef = useRef<'yes' | 'no'>('yes')
  const prk54NavigationCountRef = useRef(0)
  const prk54FailedRef = useRef(false)
  // PRK51/52 machinery remains read-only reference; the one-lifetime cap
  // disables reopen. PRK54 adds only bounded key-driven bitmap changes.
  const prk51VerifiedClosesRef = useRef(0)
  const prk51ReopenAttemptedRef = useRef(false)
  const prk51ReopenVerifiedRef = useRef(false)
  const prk51ClosedBaselineRef = useRef<Prk51ClosedBaseline | null>(null)

  useEffect(() => {
    const supported = White2ActorSystemProbe.supportsRom(rom)
    console.info('[PokéRun interaction] BG2 SAFE-STACK FONT ROM PROBE EFFECT', {
      hasBridge: Boolean(bridge),
      supported,
      bridgeStatus: bridge?.status ?? null,
      gameId: rom.gameId,
      sha256: rom.sha256,
    })

    if (!bridge || !supported) return

    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    const atomicRuntime = (runtimeBridge as unknown as { emulator: AtomicRuntime | null }).emulator
    if (!atomicRuntime || typeof atomicRuntime.callArm9Thumb8Atomic !== 'function') {
      console.info('[PokéRun interaction] BG2 SAFE-STACK FONT ROM PROBE UNAVAILABLE', {
        reason: 'Scheduler-aware stack-argument native-call export is unavailable.',
      })
      return
    }
    // TypeScript does not preserve a nullable value's narrowing inside
    // nested functions; capture the validated bridge as a non-null const.
    // Eight-argument export is checked for compatibility only, never called.
    let disposed = false
    const validNativeStack = (sp: number) =>
      sp >= PRK36_VALID_STACK_LO && sp < PRK36_VALID_STACK_HI && (sp & 7) === 0

    async function waitForActiveNativeStack() {
      const firstSp = await runtimeBridge.getArm9Sp()
      if (validNativeStack(firstSp)) {
        console.info('[PokéRun interaction] PRK36 ACTIVE STACK READY', {
          sp: hex(firstSp), framePolls: 0, note: 'DTCM field stack is inside the PRK34 successful range.',
        })
        return true
      }
      const seen = new Set<string>([hex(firstSp)])
      for (let framePoll = 1; framePoll <= PRK36_FRAME_POLLS; framePoll += 1) {
        if (disposed || runtimeBridge.status !== 'running') return false
        await new Promise<void>(resolve => { requestAnimationFrame(() => resolve()) })
        if (disposed || runtimeBridge.status !== 'running') return false
        const sp = await runtimeBridge.getArm9Sp()
        seen.add(hex(sp))
        if (validNativeStack(sp)) {
          console.info('[PokéRun interaction] PRK36 ACTIVE STACK READY', {
            sp: hex(sp), firstSp: hex(firstSp), framePolls: framePoll,
            observedStacks: Array.from(seen).slice(0, 12),
            note: 'Native calls start only after a DTCM-stack context is observed.',
          })
          return true
        }
      }
      console.info('[PokéRun interaction] PRK36 UNSAFE STACK - NO NATIVE CALLS', {
        firstSp: hex(firstSp),
        observedStacks: Array.from(seen).slice(0, 12),
        polledFrames: PRK36_FRAME_POLLS,
        note: 'Skipped all injected field getters, heap allocation, and VRAM uploads. PRK35 ROM verification was attempted separately; X can retry later.',
      })
      return false
    }

    const emitMenuState = (open: boolean) => {
      window.dispatchEvent(new CustomEvent(WHITE2_NATIVE_MENU_STATE_EVENT, { detail: { open } }))
    }

    console.info('[PokéRun interaction] BG2 SAFE-STACK FONT ROM PROBE MOUNTED', {
      bridgeStatus: runtimeBridge.status,
      rom: rom.gameId,
      createAddress: hex(BMP_WIN_CREATE_DYNAMIC),
      bitmapCreateAddress: hex(GFL_BITMAP_CREATE),
      bitmapFreeAddress: hex(GFL_BITMAP_FREE),
      fillAddress: hex(GFL_BITMAP_FILL),
      flushMapAddress: hex(BMP_WIN_FLUSH_MAP),
      drawFrameAddress: hex(BMP_WIN_DRAW_FRAME),
      frameTransfer: WINFRAME_TRANSFER_NONE,
      frameChar: MSGBG_CHAR_FRAME,
      framePalette: MSGBG_PLTT_BG2_FRAME,
      loadCharAddress: hex(GFL_BGSYS_LOAD_CHAR),
      loadScrCoreAddress: hex(GFL_BGSYS_LOAD_SCR_CORE),
      charDmaThreshold: CHAR_DMA_THRESHOLD,
      screenDmaThreshold: SCREEN_DMA_THRESHOLD,
      screenBytesPerCall: SCREEN_ROW_BYTES,
      frameMaxBytesPerCall: FRAME_FULL_ROW_BYTES,
      expectedFrameUploadCalls: 2 + WINDOW_HEIGHT * 2,
      strBufCreateAddress: hex(GFL_STRBUF_CREATE),
      strBufAppendAddress: hex(GFL_STRBUF_APPEND),
      strBufFreeAddress: hex(GFL_STRBUF_FREE),
      getCharWidthAddress: hex(GFL_FONT_GET_CHAR_WIDTH),
      getCharIndexAddress: hex(GFL_FONT_GET_CHAR_INDEX),
      mode: 'prk54-native-rom-yes-no-keyboard-menu',
      stackPolicy: 'Only 0x02FE2800..0x02FE3FFF 8-byte-aligned DTCM, sampled before every guest call',
      nativeBridge: 'callArm9Thumb4 only; callArm9Thumb8Atomic forbidden',
      browserRomAvailable: Boolean(romBytes),
      researchNote: 'PRK54: X1 opens Hello P2. X2 swaps same held 96x40 GFLBitmap into ROM-rendered two-line Trade with me? / >Yes No menu. Up/Down keys shift only owned native BG2 character tiles (four changes maximum). X3 confirms selected result in diagnostics and calls unchanged guarded PRK47 teardown. No second allocation, native ListMenu, game trade, or Thumb8; any partial failure locks until restart.',
      nativeStackRuntimeStamp: '0x50524B3C',
      note: 'PRK34 bypasses callArm9Thumb8Atomic entirely because its relocated SP (0x0214C270) intersects OSi_ThreadInfo (0x0214C26C). All native field/BG calls use the proven separate callArm9Thumb4 scheduler-aware bridge. No BmpWin_CreateDynamic, streamed glyph I/O, or menu lifecycle.',
    })

    // PRK36: native calls may also begin from the unsafe ARM9 idle stack.
    // PRK34: the PRK32 relocated eight-argument bridge is unsafe here.
    // getArm9Sp() was 0x0214C470; subtracting 0x200 landed at
    // OSi_ThreadInfo+4 (0x0214C270), corrupting Nitro OS thread state.
    // Never invoke Thumb8, even when the four extra arguments are zero.
    async function atomicCall(
      address: number,
      r0 = 0,
      r1 = 0,
      r2 = 0,
      r3 = 0,
      a4 = 0,
      a5 = 0,
      a6 = 0,
      a7 = 0,
    ) {
      if (a4 !== 0 || a5 !== 0 || a6 !== 0 || a7 !== 0) {
        throw new Error('PRK34 refuses calls requiring arguments 5-8; Thumb8 relocation overlaps Nitro OS thread data.')
      }
      if (PRK33_FOUR_ARG_BG2_VISUAL) {
        const currentSp = await runtimeBridge.getArm9Sp()
        if (!validNativeStack(currentSp)) {
          throw new Error(`PRK36 refused unsafe native call ${hex(address)} with ARM9 SP=${hex(currentSp)}; expected active DTCM stack.`)
        }
      }
      const call = await runtimeBridge.callArm9Thumb4(
        address >>> 0,
        r0 >>> 0,
        r1 >>> 0,
        r2 >>> 0,
        r3 >>> 0,
        NATIVE_STACK_RESERVE,
      )
      if (call.status !== 1) {
        throw new Error(
          `PRK34 Thumb4 native call ${hex(address)} failed with status ${call.status} at ${hex(call.pc)}; `
          + `lr=${hex(call.lr)} cpsr=${hex(call.cpsr)} instructions=${call.instructions}.`,
        )
      }
      return { result: call.result >>> 0, instructions: call.instructions >>> 0 }
    }

    // PRK36: PRK35 now runs BEFORE any native field getter, allocator, or
    // window write, so an unsafe CPU idle stack cannot block font research.
    // This function is read-only and never touches the guest FS or VRAM.
    async function verifyBrowserHeldFontRom(msgBg: number) {
      // Capture the outer optional prop as a stable local before nested map callbacks.
      const verifiedRomBytes = romBytes
      if (!verifiedRomBytes) {
        console.info('[PokéRun interaction] PRK35 BROWSER ROM UNAVAILABLE', {
          reason: 'No browser-held NDS cartridge was supplied to this probe.',
          note: 'The visible PRK34 window remains the independent baseline.',
        })
        return
      }
      const font = await runtimeBridge.read32(msgBg + 0x08)
      if (!isMainRamPointer(font)) throw new Error('Invalid live FieldMsgBG font pointer.')
      const loadType = await runtimeBridge.read32(font + 0x00)
      const arcTool = await runtimeBridge.read32(font + 0x50)
      const narcMemberFileId = await runtimeBridge.read32(font + 0x54)
      const fontFileOffset = await runtimeBridge.read32(font + 0x80)
      const maps = await runtimeBridge.read32(font + 0x88)
      const glyphsOffset = await runtimeBridge.read32(font + 0x8c)
      const glyphCellSize = await runtimeBridge.read16(font + 0x76)
      if (loadType !== 0 || !isMainRamPointer(arcTool) || !isMainRamPointer(maps)) {
        throw new Error('Live font is not a valid streamed White 2 Font/ArcTool with in-RAM CMAP.')
      }
      const firstChar = await runtimeBridge.read16(maps + 0x00)
      const lastChar = await runtimeBridge.read16(maps + 0x02)
      const method = await runtimeBridge.read16(maps + 0x04)
      const firstIndex = await runtimeBridge.read16(maps + 0x0c)
      if (method !== 0 || firstChar > STRBUF_PROBE_CHAR || lastChar < STRBUF_PROBE_CHAR) {
        throw new Error('Live font CMAP does not directly cover U+0041.')
      }
      const glyphIndex = firstIndex + STRBUF_PROBE_CHAR - firstChar
      const fsPropertyPtr = await runtimeBridge.read32(arcTool + 0x04)
      const fsArchivePtr = await runtimeBridge.read32(arcTool + 0x08)
      const fsStatus = await runtimeBridge.read32(arcTool + 0x0c)
      const rootRomFileId = await runtimeBridge.read32(arcTool + 0x20)
      const fsFileStart = await runtimeBridge.read32(arcTool + 0x24)
      const fsFileEnd = await runtimeBridge.read32(arcTool + 0x28)
      if (
        fsPropertyPtr !== arcTool + 0x20 ||
        !isMainRamPointer(fsArchivePtr) ||
        (fsStatus & 0x10) === 0 ||
        glyphIndex < 0 || glyphIndex > 65535
      ) throw new Error('Live Nitro FSFile or glyph index metadata failed validation.')

      const result = verifyWhite2FontGlyphFromRom(verifiedRomBytes, {
        rootRomFileId,
        fsFileStart,
        fsFileEnd,
        narcMemberFileId,
        fontFileOffset,
        glyphsOffset,
        glyphIndex,
        glyphCellSize,
      })
      console.info('[PokéRun interaction] PRK35 ROM FAT NARC GLYPH VERIFIED', {
        rootRomFileId: result.rootRomFileId,
        romBytes: result.romBytes,
        fatOffset: hex(result.fatOffset),
        fatEntryStart: hex(result.fatEntryStart),
        fatEntryEnd: hex(result.fatEntryEnd),
        narcSize: result.narcSize,
        narcHeaderSize: result.narcHeaderSize,
        narcChunkCount: result.narcChunkCount,
        narcMemberCount: result.narcMemberCount,
        narcMemberFileId: result.narcMemberFileId,
        narcMemberOffset: result.narcMemberOffset,
        narcMemberLength: result.narcMemberLength,
        fontMemberMagic: result.fontMemberMagic,
        glyphIndex: result.glyphIndex,
        glyphCellSize: result.glyphCellSize,
        glyphArchiveOffset: result.glyphArchiveOffset,
        glyphAbsoluteRomOffset: hex(result.glyphAbsoluteRomOffset),
        glyphAbsoluteRomEnd: hex(result.glyphAbsoluteRomEnd),
        glyphPreview8: result.glyphPreview8,
        glyphFnv1a32: result.glyphFnv1a32,
        note: 'Independent browser-held NDS FAT/NARC validation of the live game font. No guest FS, CPU call, or memory write; only eight glyph preview bytes logged.',
      })

      // PRK37: fully offline, no native guest call and no VRAM/bitmap writes.
      // TextRenderer's native glyph function was unsafe because the font is
      // streamed; use verified ROM bytes and the pinned gf_font.c packing.
      try {
        const cellWidth = await runtimeBridge.read8(font + 0x74)
        const cellHeight = await runtimeBridge.read8(font + 0x75)
        const sourceBpp = await runtimeBridge.read8(font + 0x7a)
        const lineFeed = await runtimeBridge.read8(font + 0x59)
        if (cellWidth !== 12 || cellHeight !== 15 || sourceBpp !== 2 ||
            glyphCellSize !== 48 || result.glyphIndex !== 33 ||
            firstChar !== 32 || lastChar !== 126 || firstIndex !== 0) {
          throw new Error('PRK37 live glyph encoding differs from the verified direct ASCII 12x15/2bpp font layout.')
        }
        const memberStart = result.fatEntryStart + result.narcMemberOffset
        const memberEnd = memberStart + result.narcMemberLength
        const characters = ['A', 'B', '0', '?', ' '] as const
        const samples = characters.map(character => {
          const codepoint = character.charCodeAt(0)
          const characterIndex = firstIndex + codepoint - firstChar
          const absoluteOffset = result.glyphAbsoluteRomOffset +
            (characterIndex - result.glyphIndex) * glyphCellSize
          if (absoluteOffset < memberStart || absoluteOffset + glyphCellSize > memberEnd) {
            throw new Error('PRK37 glyph ' + character + ' points beyond its verified NARC member.')
          }
          const glyph = decodeWhite2PackedFontGlyph(
            verifiedRomBytes, absoluteOffset, glyphCellSize, cellWidth, cellHeight,
          )
          if (character === 'A' && (glyph.x !== 0 || glyph.width !== 6 || glyph.advance !== 6)) {
            throw new Error('PRK37 glyph A placement differs from the PRK27 native six-pixel width.')
          }
          return {
            character: character === ' ' ? 'SPACE' : character,
            codepoint,
            glyphIndex: characterIndex,
            absoluteRomOffset: hex(glyph.absoluteRomOffset),
            x: glyph.x,
            width: glyph.width,
            advance: glyph.advance,
            source2bppCounts: glyph.source2bppCounts,
            nonzeroColorPixels: glyph.nonzeroColorPixels,
            outputTileBytes: glyph.native4bppTileBytes,
            outputTileFnv1a32: glyph.native4bppTileFnv1a32,
            rows: glyph.asciiRows,
          }
        })
        console.info('[PokéRun interaction] PRK37 OFFLINE FONT GLYPHS DECODED', {
          glyphCount: samples.length,
          cellSize: glyphCellSize,
          cellWidth,
          cellHeight,
          sourceBpp,
          lineFeed,
          symbols: { '.': 'source pixel 0', '#': 'letter 1', '+': 'shadow 2', '_': 'background 3' },
          defaultPaletteMapping: [0, 1, 2, 0],
          samples,
          note: '12x15 2bpp MSB-first pixels decoded from the existing browser ROM into separate 16x16 4bpp DS tile fingerprints. No glyph was drawn or uploaded.',
        })
      } catch (reason) {
        console.info('[PokéRun interaction] PRK37 OFFLINE FONT DECODE REJECTED', {
          reason: reason instanceof Error ? reason.message : String(reason),
          note: 'The independent read-only PRK37 parser failed. PRK35 FAT/NARC verification still passed; native window code is unaffected.',
        })
      }
      // PRK41 strictly surveys local ROM font metrics before touching the
      // guest CPU. It does not draw or alter the successful PRK40 AB window.
      try {
        const memberStart = result.fatEntryStart + result.narcMemberOffset
        const audit = auditWhite2AsciiFont(
          verifiedRomBytes,
          memberStart,
          result.narcMemberLength,
          glyphsOffset,
          glyphCellSize,
        )
        console.info('[PokéRun interaction] PRK41 ASCII FONT METRICS VERIFIED', {
          glyphCount: audit.glyphCount,
          advanceDistribution: audit.advanceDistribution,
          advanceWidthDifferences: audit.advanceWidthDifferences,
          nonzeroOffsetGlyphs: audit.nonzeroOffsetGlyphs,
          blankGlyphs: audit.blankGlyphs,
          fontMetricsFnv1a32: audit.fontMetricsFnv1a32,
          sampleText: audit.sampleText,
          metrics: audit.metrics,
          nativeSpacingRule: 'GFL_TextRndDrawCharProc_IDX4 draws at penX + GlyphInfo.x and moves penX by GlyphInfo.advance.',
          note: 'All 95 printable ASCII metrics parsed directly from the verified local ROM; no guest call, CPU stack mutation, GFLBitmap write, or BG2 VRAM upload.',
        })
      } catch (reason) {
        console.info('[PokéRun interaction] PRK41 ASCII FONT METRICS REJECTED', {
          reason: reason instanceof Error ? reason.message : String(reason),
          note: 'ROM-only research audit rejected. PRK40 visual experiment is independent.',
        })
      }
      // PRK42: fully offline text raster/placement research. The existing
      // PRK39/40 two-glyph visual is an independent, known-good reference.
      // Compare ALL 60 simulated AB character tiles byte-for-byte to the
      // independently proven four-tile A+B composers. Neither RAM nor VRAM
      // is modified by this inspection.
      try {
        const memberStart = result.fatEntryStart + result.narcMemberOffset
        const texts = ['AB', 'A B', 'Wi il', 'I! i', 'Hello, P2!']
        const samples = texts.map(text =>
          simulateWhite2AsciiLine(
            verifiedRomBytes, memberStart, result.narcMemberLength,
            glyphsOffset, text,
          ),
        )
        for (const sample of samples) {
          if (sample.clippedPixels !== 0 || sample.overlappingPixels !== 0) {
            throw new Error(
              'PRK42 unexpected clipped/overlapping pixels for "' + sample.text +
              '": clipped=' + sample.clippedPixels +
              ' overlaps=' + sample.overlappingPixels,
            )
          }
        }
        if (samples[0].penAdvancePx !== 12 ||
            samples[1].penAdvancePx !== 16 ||
            samples[2].penAdvancePx !== 20) {
          throw new Error('PRK42 line advances disagree with PRK41 ASCII font audit.')
        }

        // This comparison is NOT the same code path as the PRK42 composer:
        // PRK39+40 composed A+B within a standalone 2x2 tile block.
        const referenceBlank = new Uint8Array(128)
        referenceBlank.fill(0xff)
        const referenceA = composeWhite2GlyphInTileRam(
          verifiedRomBytes, result.glyphAbsoluteRomOffset, 48, 12, 15,
          referenceBlank,
        )
        const referenceAB = composeWhite2GlyphOverExistingTiles(
          verifiedRomBytes,
          result.glyphAbsoluteRomOffset + 48,
          referenceA.nextTiles,
          referenceA.decodedAdvance,
        )
        const abTileIndices = [13, 14, 25, 26]
        const simulatedAB = samples[0].tiles
        let tilesChecked = 0
        for (let tileIndex = 0; tileIndex < 60; tileIndex += 1) {
          const localRefIndex = abTileIndices.indexOf(tileIndex)
          for (let byte = 0; byte < 32; byte += 1) {
            const expected = localRefIndex === -1 ? 0xff :
              referenceAB.nextTiles[localRefIndex * 32 + byte]
            if (simulatedAB[tileIndex * 32 + byte] !== expected) {
              throw new Error('PRK42 AB tile reference mismatch at tile ' + tileIndex +
                ', byte ' + byte)
            }
          }
          tilesChecked += 1
        }
        if (samples[0].dirtyTileIndices.join(',') !== '13,14,25,26' ||
            tilesChecked !== 60) {
          throw new Error('PRK42 AB tile footprint is inconsistent with PRK39/40.')
        }
        console.info('[PokéRun interaction] PRK42 OFFLINE VARIABLE-WIDTH TEXT COMPOSITION VERIFIED', {
          textCount: samples.length,
          knownGoodCrossCheck: 'AB equals PRK39+PRK40 reference across ALL 60 native BG2 tiles',
          referenceTilesChecked: tilesChecked,
          referenceBytesChecked: tilesChecked * 32,
          fontMemberStart: hex(memberStart),
          glyphCellBytes: 48,
          cellDimensions: { width: 12, height: 15 },
          windowDimensions: { widthTiles: 12, heightTiles: 5 },
          fontCopyRule: 'copy GlyphInfo.width columns at penX + GlyphInfo.x; advance pen by GlyphInfo.advance',
          samples: samples.map(sample => ({
            text: sample.text,
            penAdvancePx: sample.penAdvancePx,
            placements: sample.placements,
            inkPixels: sample.inkPixels,
            shadowPixels: sample.shadowPixels,
            clippedPixels: sample.clippedPixels,
            overlappingPixels: sample.overlappingPixels,
            dirtyTileIndices: sample.dirtyTileIndices,
            changedBytesByTile: sample.changedBytesByTile,
            outputFnv1a32: sample.outputFnv1a32,
            asciiPreview: sample.asciiPreview,
          })),
          note: 'All composition is browser-only Uint8Array data. No new native calls, guest filesystem reads, GFLBitmap writes, or BG2 graphics uploads.',
        })
      } catch (reason) {
        console.info('[PokéRun interaction] PRK42 OFFLINE VARIABLE-WIDTH TEXT COMPOSITION REJECTED', {
          reason: reason instanceof Error ? reason.message : String(reason),
          note: 'Read-only text composer failed independently; PRK40 native AB visual is unchanged.',
        })
      }
      return result
    }

    // PRK38: after the PRK34 window is already displayed, verify offline
    // 2bpp glyph A composition in the EXISTING GFLBitmap RAM backing store.
    // The 4-tile 16x16 region is inside the 12x5 tile buffer at (8,8) px.
    // We NEVER call GFL_BGSysLoadChar here: no glyph pixels enter BG2 VRAM.
    async function verifyGlyphBitmapRam(
      directPixels: number, verifiedRom: Uint8Array, glyphRomOffset: number,
      bytesPerTile: number,
    ) {
      if (bytesPerTile !== 32 || !isMainRamPointer(directPixels)) {
        throw new Error('PRK38 requires the verified 32-byte-tile native GFLBitmap.')
      }
      const tileIndices = [
        WINDOW_WIDTH + 1, WINDOW_WIDTH + 2,
        2 * WINDOW_WIDTH + 1, 2 * WINDOW_WIDTH + 2,
      ]
      const originals: Uint8Array[] = []
      for (const tile of tileIndices) {
        const bytes = await runtimeBridge.readBytes(directPixels + tile * bytesPerTile, bytesPerTile)
        if (bytes.length !== bytesPerTile || bytes.some(value => value !== 0xff)) {
          throw new Error('PRK38 expected four unmodified black-fill bitmap tiles.')
        }
        originals.push(bytes)
      }
      const originalBlock = new Uint8Array(4 * bytesPerTile)
      for (let i = 0; i < originals.length; i += 1) {
        originalBlock.set(originals[i], i * bytesPerTile)
      }
      const composed = composeWhite2GlyphInTileRam(
        verifiedRom, glyphRomOffset, 48, 12, 15, originalBlock,
      )
      // This exact-ROM A glyph has 24 ink + 26 shadow pixels in two
      // left-hand tiles. Independently derived from PRK37's ASCII rows.
      const changedPerTile = tileIndices.map((_, i) => {
        let changes = 0
        for (let j = 0; j < bytesPerTile; j += 1) {
          if (composed.nextTiles[i * bytesPerTile + j] !== originals[i][j]) changes += 1
        }
        return changes
      })
      if (changedPerTile.join(',') !== '15,0,11,0' ||
          composed.changedBytes !== 26 ||
          composed.inkPixels !== 24 || composed.shadowPixels !== 26) {
        throw new Error('PRK38 offline 4bpp tile layout differs from verified PRK37 A glyph shape.')
      }
      console.info('[PokéRun interaction] PRK38 GLYPH BITMAP RAM CALL', {
        changedPerTile,
        glyph: 'A',
        romOffset: hex(glyphRomOffset),
        bitmapPixelBase: hex(directPixels),
        tileIndices,
        tileAddresses: tileIndices.map(tile => hex(directPixels + tile * bytesPerTile)),
        changedBytes: composed.changedBytes,
        inkPixels: composed.inkPixels,
        shadowPixels: composed.shadowPixels,
        width: composed.decodedWidth,
        advance: composed.decodedAdvance,
        note: 'Temporarily modify only four tiles of the allocated bitmap; no VRAM upload or native guest calls.',
      })
      let wrote = false
      let verified = false
      let restored = false
      try {
        wrote = true
        for (let i = 0; i < tileIndices.length; i += 1) {
          const tile = composed.nextTiles.slice(i * bytesPerTile, (i + 1) * bytesPerTile)
          await runtimeBridge.writeBytes(directPixels + tileIndices[i] * bytesPerTile, tile)
        }
        let observedChangedBytes = 0
        for (let i = 0; i < tileIndices.length; i += 1) {
          const actual = await runtimeBridge.readBytes(
            directPixels + tileIndices[i] * bytesPerTile, bytesPerTile,
          )
          const wanted = composed.nextTiles.subarray(i * bytesPerTile, (i + 1) * bytesPerTile)
          if (actual.length !== bytesPerTile || actual.some((value, j) => value !== wanted[j])) {
            throw new Error('PRK38 bitmap RAM readback differs from composed A glyph (tile ' + tileIndices[i] + ').')
          }
          observedChangedBytes += actual.reduce(
            (acc, value, j) => acc + (value !== originals[i][j] ? 1 : 0), 0,
          )
        }
        if (observedChangedBytes !== composed.changedBytes) {
          throw new Error('PRK38 RAM diff count disagrees with offline composition.')
        }
        verified = true
        console.info('[PokéRun interaction] PRK38 GLYPH BITMAP RAM VERIFIED', {
          tiles: tileIndices.length,
          bytesChecked: 4 * bytesPerTile,
          changedBytes: observedChangedBytes,
          inkPixels: composed.inkPixels,
          shadowPixels: composed.shadowPixels,
          note: 'Decoded A is correctly composed in GFLBitmap RAM; BG2 VRAM was NOT modified.',
        })
      } finally {
        if (wrote) {
          for (let i = 0; i < tileIndices.length; i += 1) {
            await runtimeBridge.writeBytes(
              directPixels + tileIndices[i] * bytesPerTile, originals[i],
            )
          }
          for (let i = 0; i < tileIndices.length; i += 1) {
            const actual = await runtimeBridge.readBytes(
              directPixels + tileIndices[i] * bytesPerTile, bytesPerTile,
            )
            if (actual.length !== bytesPerTile || actual.some((value, j) => value !== originals[i][j])) {
              throw new Error('PRK38 failed to restore the original black bitmap RAM (tile ' + tileIndices[i] + ').')
            }
          }
          restored = true
        }
        console.info('[PokéRun interaction] PRK38 GLYPH BITMAP RAM RESTORE', {
          verified, restored,
          bytesRestored: restored ? 4 * bytesPerTile : 0,
          note: 'All touched backing-store tiles were restored before returning. The on-screen frame is unchanged.',
        })
      }
    }

    // PRK39: the first visible native-font pixel experiment. PRK38 already
    // proved that four 32-byte bitmap tiles can be composed and fully restored.
    // The A glyph only changes the LEFT tile of each row; transfer exactly
    // those two tiles (13 and 25) with the proven 32-byte CPU path.
    // Success leaves both the bitmap backing store AND BG2 VRAM matching,
    // so the letter remains visible for a screenshot. A fresh emulator run
    // owns the temporary window allocation; cleanup is a separate experiment.
    async function uploadGlyphAToBg2(
      directPixels: number, directCharPos: number, bg: number,
      verifiedRom: Uint8Array, glyphRomOffset: number, bytesPerTile: number,
    ) {
      if (bytesPerTile !== 32 || !isMainRamPointer(directPixels) ||
          directCharPos !== 964 || directCharPos + WINDOW_WIDTH * WINDOW_HEIGHT !== 1024 ||
          bg !== MSGBG_BG2) {
        throw new Error('PRK39 required BG2 bitmap and tile allocation invariants failed.')
      }
      const fourTiles = [WINDOW_WIDTH + 1, WINDOW_WIDTH + 2,
                         WINDOW_WIDTH * 2 + 1, WINDOW_WIDTH * 2 + 2]
      const originalBlock = new Uint8Array(4 * bytesPerTile)
      originalBlock.fill(0xff)
      // PRK38 succeeded before we enter this function, leaving all four
      // original bitmap tiles restored to 0xff and VRAM still clean.
      for (const tileIndex of fourTiles) {
        const observed = await runtimeBridge.readBytes(
          directPixels + tileIndex * bytesPerTile, bytesPerTile,
        )
        if (observed.length !== bytesPerTile || observed.some(value => value !== 0xff)) {
          throw new Error('PRK39 refused to draw on a bitmap tile not restored by PRK38.')
        }
      }
      const composed = composeWhite2GlyphInTileRam(
        verifiedRom, glyphRomOffset, 48, 12, 15, originalBlock,
      )
      const changedPerTile = fourTiles.map((_, i) => {
        let changed = 0
        for (let j = 0; j < bytesPerTile; j += 1) {
          if (composed.nextTiles[i * bytesPerTile + j] !== 0xff) changed += 1
        }
        return changed
      })
      if (changedPerTile.join(',') !== '15,0,11,0' ||
          composed.changedBytes !== 26 ||
          composed.inkPixels !== 24 || composed.shadowPixels !== 26) {
        throw new Error('PRK39 refused an unexpected glyph tile layout.')
      }
      const changedEntries = [
        { tileIndex: fourTiles[0], blockIndex: 0 },
        { tileIndex: fourTiles[2], blockIndex: 2 },
      ]
      if (runtimeBridge.status !== 'running' ||
          !validNativeStack(await runtimeBridge.getArm9Sp())) {
        throw new Error('PRK39 native transfer refused an unsafe ARM9 CPU context.')
      }
      console.info('[PokéRun interaction] PRK39 GLYPH A BG2 TILE UPLOAD CALL', {
        character: 'A',
        romOffset: hex(glyphRomOffset),
        bg,
        bitmapPixelBase: hex(directPixels),
        charPos: directCharPos,
        tileIndices: changedEntries.map(entry => entry.tileIndex),
        vramCharPositions: changedEntries.map(entry => directCharPos + entry.tileIndex),
        transferSizeEach: bytesPerTile,
        totalTransferBytes: bytesPerTile * changedEntries.length,
        changedBytes: composed.changedBytes,
        inkPixels: composed.inkPixels,
        shadowPixels: composed.shadowPixels,
        note: 'Write two already verified 32-byte bitmap tiles into RAM, then upload only those tiles into BG2 VRAM using the safe Thumb4 bridge.',
      })
      // Preparation writes only the two changed bitmap tiles, with no BG2
      // tilemap updates. If a CPU call fails, do not attempt unsafe injected
      // rollback; log the partial state and require a fresh guest session.
      let ramPrepared = 0
      let uploaded = 0
      let totalInstructions = 0
      try {
        for (const { tileIndex, blockIndex } of changedEntries) {
          const address = directPixels + tileIndex * bytesPerTile
          const desired = composed.nextTiles.slice(
            blockIndex * bytesPerTile, (blockIndex + 1) * bytesPerTile,
          )
          await runtimeBridge.writeBytes(address, desired)
          const readback = await runtimeBridge.readBytes(address, bytesPerTile)
          if (readback.length !== bytesPerTile ||
              readback.some((value, index) => value !== desired[index])) {
            throw new Error('PRK39 prepared bitmap RAM tile did not pass readback at index ' + tileIndex)
          }
          ramPrepared += 1
        }
        for (const { tileIndex } of changedEntries) {
          const call = await atomicCall(
            GFL_BGSYS_LOAD_CHAR, bg,
            directPixels + tileIndex * bytesPerTile,
            bytesPerTile,
            directCharPos + tileIndex,
          )
          uploaded += 1
          totalInstructions += call.instructions
          console.info('[PokéRun interaction] PRK39 BG2 SINGLE TILE UPLOADED', {
            tileIndex,
            charPosition: directCharPos + tileIndex,
            bytes: bytesPerTile,
            instructions: call.instructions,
          })
        }
        console.info('[PokéRun interaction] PRK39 GLYPH A BG2 TILE UPLOAD SUCCESS', {
          glyph: 'A',
          tileIndices: changedEntries.map(entry => entry.tileIndex),
          charPositions: changedEntries.map(entry => directCharPos + entry.tileIndex),
          tilesUploaded: uploaded,
          bytesTransferred: uploaded * bytesPerTile,
          changedBytes: composed.changedBytes,
          inkPixels: composed.inkPixels,
          shadowPixels: composed.shadowPixels,
          totalInstructions,
          textPixelPositionInWindow: { x: 8, y: 8 },
          textPixelPositionOnScreen: {
            x: WINDOW_X * 8 + 8,
            y: WINDOW_Y * 8 + 8,
          },
          note: 'The native glyph should now be visible inside the framed window. The GFLBitmap RAM and BG2 tile graphics are left consistent; screenshot verification is required.',
        })
      } catch (reason) {
        console.info('[PokéRun interaction] PRK39 GLYPH A BG2 TILE UPLOAD FAILED', {
          ramPrepared,
          tilesUploaded: uploaded,
          reason: reason instanceof Error ? reason.message : String(reason),
          note: 'Do not retry native graphics calls in this guest session after a partial failure. Restart the emulator first.',
        })
        throw reason
      }
    }

    // PRK40: after PRK39's real glyph A is visible, append B at A's 6px
    // font advance and cross the 8px BG2 tile boundary. Verify the existing
    // A backing-store bytes BEFORE any change. No guest FS, text stream,
    // >4-arg function, BG screen-map writes, or actor changes.
    async function uploadGlyphBToBg2(
      directPixels: number, directCharPos: number, bg: number,
      verifiedRom: Uint8Array, glyphARomOffset: number, bytesPerTile: number,
    ) {
      if (bytesPerTile !== 32 || !isMainRamPointer(directPixels) ||
          directCharPos !== 964 || directCharPos + WINDOW_WIDTH * WINDOW_HEIGHT !== 1024 ||
          bg !== MSGBG_BG2) {
        throw new Error('PRK40 bitmap geometry/character allocation guard rejected B draw.')
      }
      const tileIndices = [WINDOW_WIDTH + 1, WINDOW_WIDTH + 2,
                           WINDOW_WIDTH * 2 + 1, WINDOW_WIDTH * 2 + 2]
      const originalBlock = new Uint8Array(4 * bytesPerTile)
      for (let i = 0; i < tileIndices.length; i += 1) {
        const tile = await runtimeBridge.readBytes(
          directPixels + tileIndices[i] * bytesPerTile, bytesPerTile,
        )
        if (tile.length !== bytesPerTile) throw new Error('PRK40 could not read existing A tiles.')
        originalBlock.set(tile, i * bytesPerTile)
      }
      const black = new Uint8Array(4 * bytesPerTile)
      black.fill(0xff)
      const verifiedA = composeWhite2GlyphInTileRam(
        verifiedRom, glyphARomOffset, 48, 12, 15, black,
      )
      if (originalBlock.some((value, i) => value !== verifiedA.nextTiles[i]) ||
          verifiedA.changedBytes !== 26 || verifiedA.decodedAdvance !== 6) {
        throw new Error('PRK40 rejected unexpected existing A bitmap state; no B upload attempted.')
      }
      const glyphBRomOffset = glyphARomOffset + 48
      const composed = composeWhite2GlyphOverExistingTiles(
        verifiedRom, glyphBRomOffset, originalBlock, verifiedA.decodedAdvance,
      )
      if (composed.changedPerTile.join(',') !== '6,10,5,7' ||
          composed.changedBytes !== 28 ||
          composed.inkPixels !== 26 || composed.shadowPixels !== 28 ||
          composed.advance !== 6) {
        throw new Error('PRK40 B tile/advance values disagree with independent PRK37 B raster.')
      }
      if (runtimeBridge.status !== 'running' ||
          !validNativeStack(await runtimeBridge.getArm9Sp())) {
        throw new Error('PRK40 refused B upload from an unsafe ARM9 stack context.')
      }
      console.info('[PokéRun interaction] PRK40 GLYPH B CROSS-TILE PREFLIGHT', {
        previousGlyph: 'A',
        nextGlyph: 'B',
        glyphARomOffset: hex(glyphARomOffset),
        glyphBRomOffset: hex(glyphBRomOffset),
        previousAdvancePx: verifiedA.decodedAdvance,
        secondGlyphStartInWindowPx: { x: 8 + verifiedA.decodedAdvance, y: 8 },
        tileIndices,
        charPositions: tileIndices.map(i => directCharPos + i),
        changedPerTile: composed.changedPerTile,
        changedBytes: composed.changedBytes,
        inkPixels: composed.inkPixels,
        shadowPixels: composed.shadowPixels,
        totalUploadBytes: tileIndices.length * bytesPerTile,
        note: 'The A glyph in native GFLBitmap RAM matched the exact offline ROM composition. Only B will be added; all four crossed BG2 tiles will use 32-byte CPU transfers.',
      })
      let ramTilesPrepared = 0
      let tilesUploaded = 0
      let totalInstructions = 0
      try {
        // Prepare all four tiles first, so each BG2 VRAM upload reads the same
        // complete AB state. Each byte is read back before any native call.
        for (let i = 0; i < tileIndices.length; i += 1) {
          const tileIndex = tileIndices[i]
          const desired = composed.nextTiles.slice(i * bytesPerTile, (i + 1) * bytesPerTile)
          const source = directPixels + tileIndex * bytesPerTile
          await runtimeBridge.writeBytes(source, desired)
          const actual = await runtimeBridge.readBytes(source, bytesPerTile)
          if (actual.length !== bytesPerTile ||
              actual.some((value, byteIndex) => value !== desired[byteIndex])) {
            throw new Error('PRK40 B bitmap RAM readback mismatch at tile ' + tileIndex)
          }
          ramTilesPrepared += 1
        }
        for (const tileIndex of tileIndices) {
          const call = await atomicCall(
            GFL_BGSYS_LOAD_CHAR, bg,
            directPixels + tileIndex * bytesPerTile,
            bytesPerTile,
            directCharPos + tileIndex,
          )
          tilesUploaded += 1
          totalInstructions += call.instructions
          console.info('[PokéRun interaction] PRK40 BG2 CROSSED TILE UPLOADED', {
            tileIndex,
            charPosition: directCharPos + tileIndex,
            bytes: bytesPerTile,
            instructions: call.instructions,
          })
        }
        console.info('[PokéRun interaction] PRK40 VISIBLE AB TEXT SUCCESS', {
          text: 'AB',
          glyphAStartPx: { x: 8, y: 8 },
          glyphBStartPx: { x: 14, y: 8 },
          glyphAdvancesPx: [6, 6],
          tilesUploaded,
          charPositions: tileIndices.map(i => directCharPos + i),
          bytesTransferred: tilesUploaded * bytesPerTile,
          changedPerTile: composed.changedPerTile,
          changedBytes: composed.changedBytes,
          totalInstructions,
          note: 'AB is now in native bitmap RAM and BG2 VRAM. Verify glyph spacing and colors visually; screenshot required.',
        })
      } catch (reason) {
        console.info('[PokéRun interaction] PRK40 AB PARTIAL STATE / RESTART REQUIRED', {
          ramTilesPrepared,
          tilesUploaded,
          reason: reason instanceof Error ? reason.message : String(reason),
          note: 'Do not retry this guest after an incomplete cross-tile transfer. Preserve the logs and restart before another test.',
        })
        throw reason
      }
    }

    // PRK43: NO native guest calls, VRAM/guest RAM writes, or screen cleanup.
    // Capture the 14x7 BG2 tilemap area BEFORE the window is drawn, then
    // compare it to the live map AFTER PRK40. This distinguishes the game's
    // shadow map from the real BG2 VRAM entries and establishes what must be
    // restored before char reservation / bitmap can be freed in PRK44+.
    async function inspectBg2MapReadOnly(): Promise<Prk43Bg2MapSnapshot> {
      const bgSys = await runtimeBridge.read32(PRK43_BGSYS_GLOBAL_PTR)
      if (!isMainRamPointer(bgSys)) {
        throw new Error('PRK43 global sBGSys pointer invalid: ' + hex(bgSys))
      }
      const record = bgSys + PRK43_BGSYS_BG2_RECORD_OFFSET
      const screenPtr = await runtimeBridge.read32(record)
      const screenSize = await runtimeBridge.read32(record + 4)
      const screenOffset = await runtimeBridge.read32(record + 8)
      const mode = await runtimeBridge.read8(record + 20)
      const colorMode = await runtimeBridge.read8(record + 22)
      const tileSize = await runtimeBridge.read8(record + 23)
      const screenBase = await runtimeBridge.read32(
        bgSys + PRK43_BGSYS_BG2_SCREEN_BASE_OFFSET,
      )
      const bg2Control = await runtimeBridge.read16(PRK43_BG2_CONTROL_REGISTER)
      const controlScreenBase = ((bg2Control >>> 8) & 0x1f) * 0x800
      if (mode !== 0 || colorMode !== 0 || tileSize !== 32 ||
          screenBase > 0x10000 || screenBase % 0x800 !== 0) {
        throw new Error('PRK43 BGSys BG2 record or screen base failed layout validation.')
      }
      const positions = Array.from({ length: WINDOW_HEIGHT + 2 }, (_, row) =>
        Array.from({ length: WINDOW_WIDTH + 2 }, (_, col) =>
          (WINDOW_Y - 1 + row) * TEXT_BG_WIDTH_TILES + WINDOW_X - 1 + col,
        ),
      ).flat()
      if (positions.length !== 98) throw new Error('PRK43 expected 98 map entries.')
      let ramMap: number[] | null = null
      if (isMainRamPointer(screenPtr) && screenSize >= 2048 &&
          screenSize <= 0x10000 && positions.at(-1)! * 2 + 2 <= screenSize) {
        ramMap = []
        for (const position of positions) {
          ramMap.push(await runtimeBridge.read16(screenPtr + position * 2))
        }
      }
      // The decompiled GX_LoadBG2Scr maps BG2 screen tiles into main BG VRAM.
      // Do not interpret the VRAM snapshot unless hardware BG2CNT agrees with
      // the BGSys screen-base bookkeeping. On mismatches log "unavailable".
      let vramMap: number[] | null = null
      if (screenBase === controlScreenBase &&
          screenBase + (positions.at(-1)! + 1) * 2 <= 0x20000) {
        try {
          vramMap = []
          for (const position of positions) {
            vramMap.push(await runtimeBridge.read16(
              PRK43_MAIN_BG_VRAM_BASE + screenBase + position * 2,
            ))
          }
        } catch {
          vramMap = null
        }
      }
      return {
        bgSys, screenPtr, screenSize, screenOffset, screenBase,
        mode, colorMode, tileSize, controlScreenBase,
        ramMap, vramMap, capturedPositions: positions.length,
      }
    }

    function prk43ExpectedMapForWindow(charPos: number): number[] {
      const expected: number[] = []
      for (let y = WINDOW_Y - 1; y <= WINDOW_Y + WINDOW_HEIGHT; y += 1) {
        for (let x = WINDOW_X - 1; x <= WINDOW_X + WINDOW_WIDTH; x += 1) {
          const left = x === WINDOW_X - 1
          const right = x === WINDOW_X + WINDOW_WIDTH
          const top = y === WINDOW_Y - 1
          const bottom = y === WINDOW_Y + WINDOW_HEIGHT
          let character: number
          let palette: number
          if (top) {
            palette = MSGBG_PLTT_BG2_FRAME
            character = MSGBG_CHAR_FRAME + (left ? 0 : right ? 2 : 1)
          } else if (bottom) {
            palette = MSGBG_PLTT_BG2_FRAME
            character = MSGBG_CHAR_FRAME + (left ? 6 : right ? 8 : 7)
          } else if (left || right) {
            palette = MSGBG_PLTT_BG2_FRAME
            character = MSGBG_CHAR_FRAME + (left ? 3 : 5)
          } else {
            palette = MSGBG_PLTT_BG2
            character = charPos + (y - WINDOW_Y) * WINDOW_WIDTH + (x - WINDOW_X)
          }
          expected.push((palette << 12) | character)
        }
      }
      return expected
    }

    function prk43SnapshotHash(entries: number[] | null): string | null {
      if (!entries) return null
      let hash = 0x811c9dc5
      for (const value of entries) {
        hash ^= value & 255
        hash = Math.imul(hash, 0x01000193) >>> 0
        hash ^= (value >>> 8) & 255
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
      return hex(hash)
    }

    // PRK44: reversible screen-map restoration only. Two separate seven-row
    // GFL_BGSysLoadScrCore CPU transfer phases, each <=28 bytes per call.
    // Never free the 60 reserved BG2 char tiles or the owned GFLBitmap here.
    // The original 98 map entries are captured before the first overlay
    // transfer; the overlay 98 entries must match PRK43 byte-for-byte.
    async function tryPrk44ReversibleMapRoundTrip(
      baseline: Prk43Bg2MapSnapshot,
      overlay: Prk43Bg2MapSnapshot,
      playerActor: number,
      directPixels: number,
      bg: number,
      charPos: number,
    ): Promise<boolean> {
      const original = baseline.vramMap
      const shadow = baseline.ramMap
      const overlayEntries = overlay.vramMap
      const expected = prk43ExpectedMapForWindow(charPos)
      const stableMetadata = (
        overlay.bgSys === baseline.bgSys &&
        overlay.screenPtr === baseline.screenPtr &&
        overlay.screenSize === baseline.screenSize &&
        overlay.screenOffset === baseline.screenOffset &&
        overlay.screenBase === baseline.screenBase &&
        overlay.controlScreenBase === baseline.controlScreenBase &&
        overlay.screenBase === overlay.controlScreenBase &&
        overlay.mode === baseline.mode &&
        overlay.colorMode === baseline.colorMode &&
        overlay.tileSize === baseline.tileSize &&
        baseline.screenBase === baseline.controlScreenBase
      )
      const ready = (
        bg === MSGBG_BG2 &&
        charPos === 964 &&
        isMainRamPointer(directPixels) &&
        stableMetadata &&
        original !== null && original.length === 98 &&
        shadow !== null && shadow.length === 98 &&
        overlayEntries !== null && overlayEntries.length === 98 &&
        original.every((value, i) => value === shadow[i]) &&
        overlayEntries.every((value, i) => value === expected[i])
      )
      if (!ready || original === null || overlayEntries === null) {
        console.info('[PokéRun interaction] PRK44 RESTORATION PREFLIGHT SKIPPED', {
          stableMetadata,
          baselineVramAvailable: original !== null,
          baselineShadowAvailable: shadow !== null,
          overlayVramAvailable: overlayEntries !== null,
          originalEqualsShadow: original !== null && shadow !== null &&
            original.length === shadow.length &&
            original.every((value, i) => value === shadow[i]),
          overlayMatchesExpected: overlayEntries !== null &&
            overlayEntries.length === expected.length &&
            overlayEntries.every((value, i) => value === expected[i]),
          note: 'Fail-closed. No BG2 tilemap writes. Existing AB window remains.',
        })
        return false
      }
      async function sameField() {
        if (disposed || runtimeBridge.status !== 'running') return false
        const current = await probe.scanHeap()
        return current.playerActor?.address === playerActor &&
          current.playerActor.modelId === EXPECTED_STABLE_PLAYER_MODEL
      }
      if (!(await sameField())) {
        console.info('[PokéRun interaction] PRK44 RESTORATION PREFLIGHT SKIPPED', {
          reason: 'Player actor identity/model changed before restoration.',
        })
        return false
      }

      const scratchOriginal = await runtimeBridge.readBytes(directPixels, FRAME_FULL_ROW_BYTES)
      if (scratchOriginal.length !== FRAME_FULL_ROW_BYTES) {
        throw new Error('PRK44 could not save 28 bytes of bitmap scratch.')
      }
      let restoredRows = 0
      let reappliedRows = 0
      let restoreVerified = false
      let reapplyVerified = false
      let scratchRestored = false
      let unsafeNativeFailure = false
      let restoreError: string | null = null
      let reapplyError: string | null = null

      // Keep original and overlay pointers immutable. Each row consists of
      // 14 consecutive screen entries starting at x=17, y=1..7.
      async function uploadRows(entries: number[], phase: 'restore' | 'reapply') {
        for (let row = 0; row < WINDOW_HEIGHT + 2; row += 1) {
          if (!(await sameField())) {
            throw new Error('PRK44 aborted: field/player identity changed during ' + phase)
          }
          const beforeSp = await runtimeBridge.getArm9Sp()
          if (!validNativeStack(beforeSp) && !(await waitForActiveNativeStack())) {
            throw new Error('PRK44 no safe DTCM stack for ' + phase + ' row ' + row)
          }
          const data = new Uint8Array(FRAME_FULL_ROW_BYTES)
          for (let col = 0; col < WINDOW_WIDTH + 2; col += 1) {
            const word = entries[row * (WINDOW_WIDTH + 2) + col]
            data[col * 2] = word & 255
            data[col * 2 + 1] = word >>> 8
          }
          await runtimeBridge.writeBytes(directPixels, data)
          const readback = await runtimeBridge.readBytes(directPixels, FRAME_FULL_ROW_BYTES)
          if (readback.length !== FRAME_FULL_ROW_BYTES ||
              readback.some((value, i) => value !== data[i])) {
            throw new Error('PRK44 scratch readback failed for ' + phase + ' row ' + row)
          }
          try {
            await atomicCall(
              GFL_BGSYS_LOAD_SCR_CORE, bg, directPixels, FRAME_FULL_ROW_BYTES,
              (WINDOW_Y - 1 + row) * TEXT_BG_WIDTH_TILES + WINDOW_X - 1,
            )
          } catch (reason) {
            // Do not attempt additional ARM9 calls after a failed native
            // invocation; the guest may be in exception/scheduler state.
            unsafeNativeFailure = true
            throw reason
          }
          if (phase === 'restore') restoredRows += 1
          else reappliedRows += 1
        }
      }
      async function verifyVramMap(expectedEntries: number[]) {
        const now = await inspectBg2MapReadOnly()
        const sameOwner = now.bgSys === baseline.bgSys &&
          now.screenPtr === baseline.screenPtr &&
          now.screenBase === baseline.screenBase &&
          now.controlScreenBase === baseline.controlScreenBase
        const matches = now.vramMap !== null &&
          now.vramMap.length === expectedEntries.length &&
          now.vramMap.every((value, i) => value === expectedEntries[i])
        const shadowUnchanged = now.ramMap !== null &&
          shadow !== null && now.ramMap.length === shadow.length &&
          now.ramMap.every((value, i) => value === shadow[i])
        return { sameOwner, matches, shadowUnchanged, hash: prk43SnapshotHash(now.vramMap) }
      }

      console.info('[PokéRun interaction] PRK44 REVERSIBLE SCREEN MAP PREFLIGHT PASSED', {
        fieldActor: hex(playerActor),
        bg,
        charPos,
        baselineVramHash: prk43SnapshotHash(original),
        overlayVramHash: prk43SnapshotHash(overlayEntries),
        screenBase: hex(baseline.screenBase),
        entries: 98,
        rowsPerPhase: WINDOW_HEIGHT + 2,
        bytesPerCall: FRAME_FULL_ROW_BYTES,
        maxTransferBytes: SCREEN_DMA_THRESHOLD,
        note: 'Testing map restoration and reapplication only. All 60 char tiles and owned bitmap remain allocated; final AB window should look unchanged.',
      })
      try {
        try {
          await uploadRows(original, 'restore')
          const result = await verifyVramMap(original)
          if (!result.sameOwner || !result.matches || !result.shadowUnchanged) {
            throw new Error('PRK44 original map readback or shadow identity mismatch.')
          }
          restoreVerified = true
          console.info('[PokéRun interaction] PRK44 ORIGINAL MAP RESTORED AND VERIFIED', {
            rowsTransferred: restoredRows,
            bytesTransferred: restoredRows * FRAME_FULL_ROW_BYTES,
            entriesVerified: original.length,
            restoredVramHash: result.hash,
            shadowUnchanged: result.shadowUnchanged,
            note: 'Original background map restored to VRAM, but resources are not freed. Overlay reapplication begins immediately.',
          })
        } catch (reason) {
          restoreError = reason instanceof Error ? reason.message : String(reason)
        } finally {
          if ((restoredRows > 0 || restoreVerified) &&
              !unsafeNativeFailure && await sameField()) {
            try {
              await uploadRows(overlayEntries, 'reapply')
              const finalState = await verifyVramMap(overlayEntries)
              if (!finalState.sameOwner || !finalState.matches || !finalState.shadowUnchanged) {
                throw new Error('PRK44 overlay reapplication did not restore all 98 VRAM map entries.')
              }
              reapplyVerified = true
              console.info('[PokéRun interaction] PRK44 AB OVERLAY REAPPLIED AND VERIFIED', {
                rowsTransferred: reappliedRows,
                bytesTransferred: reappliedRows * FRAME_FULL_ROW_BYTES,
                entriesVerified: overlayEntries.length,
                overlayVramHash: finalState.hash,
                shadowUnchanged: finalState.shadowUnchanged,
                note: 'All original AB character tiles and their backing buffer remain allocated and unchanged. Final visual is the known-good AB window.',
              })
            } catch (reason) {
              reapplyError = reason instanceof Error ? reason.message : String(reason)
            }
          }
        }
      } finally {
        // Only RAM staging scratch is restored here. The helper never frees
        // or overwrites glyph character VRAM, the GFLBitmap, or native actors.
        await runtimeBridge.writeBytes(directPixels, scratchOriginal)
        const scratchAfter = await runtimeBridge.readBytes(directPixels, FRAME_FULL_ROW_BYTES)
        scratchRestored = scratchAfter.length === FRAME_FULL_ROW_BYTES &&
          scratchAfter.every((value, i) => value === scratchOriginal[i])
        console.info('[PokéRun interaction] PRK44 SCREEN MAP ROUND TRIP RESULT', {
          restoredRows,
          reappliedRows,
          restoreVerified,
          reapplyVerified,
          scratchRestored,
          unsafeNativeFailure,
          restoreError,
          reapplyError,
          nativeResourcesFreed: false,
          note: restoreVerified && reapplyVerified && scratchRestored
            ? 'Original BG2 map restored and AB overlay re-applied byte-for-byte; P2 health and screenshot remain external checks.'
            : 'Incomplete/unsafe map round trip. Do not retry in the same emulator session; preserve logs and restart.',
        })
      }
      return restoreVerified && reapplyVerified && scratchRestored &&
        !unsafeNativeFailure && restoreError === null && reapplyError === null
    }

    // PRK45: isolate the *real game's* two-allocation GFL_BitmapFree
    // ownership path, without touching the visible AB window allocations.
    // PRK44 must have successfully restored/reapplied all 98 BG2 entries
    // before PRK45 allocates a separate 1x1 temporary native bitmap.
    async function tryPrk45DisposableBitmapLifetime(
      playerActor: number, bg: number, charPos: number,
      liveBitmap: number, livePixels: number, heapId: number,
      expectedBgSys: number,
    ): Promise<boolean> {
      if (disposed || runtimeBridge.status !== 'running' ||
          bg !== MSGBG_BG2 || charPos !== 964 ||
          !isMainRamPointer(liveBitmap) ||
          !isMainRamPointer(livePixels) ||
          !Number.isInteger(heapId) || heapId !== 21) {
        console.info('[PokéRun interaction] PRK45 DISPOSABLE BITMAP SKIPPED', {
          reason: 'Field, heap, or baseline allocation guard did not validate.',
        })
        return false
      }
      const current = await probe.scanHeap()
      if (current.playerActor?.address !== playerActor ||
          current.playerActor.modelId !== EXPECTED_STABLE_PLAYER_MODEL) {
        console.info('[PokéRun interaction] PRK45 DISPOSABLE BITMAP SKIPPED', {
          reason: 'Native player actor identity or model changed.',
        })
        return false
      }
      const before = await inspectBg2MapReadOnly()
      const expectedOverlay = prk43ExpectedMapForWindow(charPos)
      const overlayMatches = before.bgSys === expectedBgSys &&
        before.vramMap !== null &&
        before.vramMap.length === expectedOverlay.length &&
        before.vramMap.every((value, i) => value === expectedOverlay[i])
      const beforePixels = await runtimeBridge.readBytes(
        livePixels, WINDOW_WIDTH * WINDOW_HEIGHT * 32,
      )
      const beforeStruct = await runtimeBridge.readBytes(liveBitmap, 12)
      if (!overlayMatches || beforePixels.length !== 1920 ||
          beforeStruct.length !== 12 ||
          (await runtimeBridge.read32(liveBitmap)) !== livePixels ||
          (await runtimeBridge.read16(liveBitmap + 4)) !== 96 ||
          (await runtimeBridge.read16(liveBitmap + 6)) !== 40 ||
          (await runtimeBridge.read16(liveBitmap + 8)) !== 32 ||
          (await runtimeBridge.read16(liveBitmap + 10)) !== 0) {
        console.info('[PokéRun interaction] PRK45 DISPOSABLE BITMAP SKIPPED', {
          reason: 'Existing AB window owner/VRAM preflight is not the verified PRK44 state.',
        })
        return false
      }
      if (!validNativeStack(await runtimeBridge.getArm9Sp()) &&
          !(await waitForActiveNativeStack())) {
        console.info('[PokéRun interaction] PRK45 DISPOSABLE BITMAP SKIPPED', {
          reason: 'No safe active DTCM stack for native allocation.',
        })
        return false
      }
      console.info('[PokéRun interaction] PRK45 DISPOSABLE BITMAP ALLOCATION PREFLIGHT', {
        heapId,
        nativeCreate: hex(GFL_BITMAP_CREATE),
        nativeFree: hex(GFL_BITMAP_FREE),
        liveBitmap: hex(liveBitmap),
        livePixels: hex(livePixels),
        livePixelBytes: beforePixels.length,
        currentOverlayHash: prk43SnapshotHash(before.vramMap),
        disposableDimensions: { widthTiles: 1, heightTiles: 1, tileSize: 32 },
        note: 'A separate bitmap will be allocated on heap 21, validated, and freed. No BG2 VRAM writes or char deallocation.',
      })
      let disposableBitmap = 0
      let disposablePixels = 0
      let freeReturned = false
      try {
        const allocated = await atomicCall(GFL_BITMAP_CREATE, 1, 1, 32, heapId)
        disposableBitmap = allocated.result
        if (!isMainRamPointer(disposableBitmap)) {
          throw new Error('PRK45 disposable bitmap pointer invalid: ' + hex(disposableBitmap))
        }
        disposablePixels = await runtimeBridge.read32(disposableBitmap)
        const disposableWidth = await runtimeBridge.read16(disposableBitmap + 4)
        const disposableHeight = await runtimeBridge.read16(disposableBitmap + 6)
        const disposableTileSize = await runtimeBridge.read16(disposableBitmap + 8)
        const disposableStorage = await runtimeBridge.read16(disposableBitmap + 10)
        const overlaps = (a: number, lengthA: number, b: number, lengthB: number) =>
          a < b + lengthB && b < a + lengthA
        const isolated = isMainRamPointer(disposablePixels) &&
          disposableWidth === 8 && disposableHeight === 8 &&
          disposableTileSize === 32 && disposableStorage === 0 &&
          !overlaps(disposableBitmap, 12, liveBitmap, 12) &&
          !overlaps(disposableBitmap, 12, livePixels, 1920) &&
          !overlaps(disposablePixels, 32, liveBitmap, 12) &&
          !overlaps(disposablePixels, 32, livePixels, 1920) &&
          !overlaps(disposableBitmap, 12, disposablePixels, 32)
        console.info('[PokéRun interaction] PRK45 DISPOSABLE BITMAP GEOMETRY', {
          disposableBitmap: hex(disposableBitmap),
          disposablePixels: hex(disposablePixels),
          width: disposableWidth,
          height: disposableHeight,
          tileSize: disposableTileSize,
          storage: disposableStorage,
          isolatedFromAB: isolated,
          createInstructions: allocated.instructions,
          note: 'Independent 1x1 owned bitmap must not overlap the live 12x5 AB bitmap or its 1920-byte pixel buffer.',
        })
        if (!isolated) {
          throw new Error('PRK45 will not free a disposable bitmap with unexpected geometry or overlap.')
        }
        const safeModel = await probe.scanHeap()
        if (safeModel.playerActor?.address !== playerActor ||
            safeModel.playerActor.modelId !== EXPECTED_STABLE_PLAYER_MODEL) {
          throw new Error('PRK45 actor identity changed before free; no native free attempted.')
        }
        if (!validNativeStack(await runtimeBridge.getArm9Sp()) &&
            !(await waitForActiveNativeStack())) {
          throw new Error('PRK45 free skipped because the active ARM9 DTCM stack was not available.')
        }
        // The decompiled GFL_BitmapFree first frees bitmap->pixels when
        // storage==0 (owned) and then the 12-byte bitmap header itself.
        // Its native C return type is VOID; call completion, not r0, matters.
        const freed = await atomicCall(GFL_BITMAP_FREE, disposableBitmap)
        freeReturned = true
        console.info('[PokéRun interaction] PRK45 NATIVE GFL BITMAP FREE RETURNED', {
          disposableBitmap: hex(disposableBitmap),
          disposablePixels: hex(disposablePixels),
          freeInstructions: freed.instructions,
          freeNativeStatus: 'completed',
          note: 'Native void free function returned via Thumb4. The separate AB bitmap/char allocation was NOT freed.',
        })

        const liveStructAfter = await runtimeBridge.readBytes(liveBitmap, 12)
        const livePixelsAfter = await runtimeBridge.readBytes(livePixels, 1920)
        const sameLiveStruct = liveStructAfter.length === beforeStruct.length &&
          liveStructAfter.every((value, i) => value === beforeStruct[i])
        const sameLivePixels = livePixelsAfter.length === beforePixels.length &&
          livePixelsAfter.every((value, i) => value === beforePixels[i])
        const bgAfter = await inspectBg2MapReadOnly()
        const sameBgMap = bgAfter.bgSys === before.bgSys &&
          bgAfter.vramMap !== null &&
          bgAfter.vramMap.length === expectedOverlay.length &&
          bgAfter.vramMap.every((value, i) => value === expectedOverlay[i])
        const beforeShadow = before.ramMap
        const afterShadow = bgAfter.ramMap
        const sameShadow = beforeShadow !== null && afterShadow !== null &&
          beforeShadow.length === afterShadow.length &&
          afterShadow.every((value, i) => value === beforeShadow[i])
        console.info('[PokéRun interaction] PRK45 DISPOSABLE FREE BASELINE VERIFIED', {
          freeReturned,
          sameLiveStruct,
          sameLivePixels,
          sameBgMap,
          sameShadow,
          liveBitmap: hex(liveBitmap),
          livePixels: hex(livePixels),
          liveCharPos: charPos,
          overlayVramHash: prk43SnapshotHash(bgAfter.vramMap),
          note: 'Separate owned bitmap freed; live AB bitmap and its VRAM map were not changed. This does not prove AreaMan tile deallocation or full window cleanup.',
        })
        if (!sameLiveStruct || !sameLivePixels || !sameBgMap || !sameShadow) {
          throw new Error('PRK45 post-free baseline diverged; preserve logs and restart the emulator.')
        }
        return true
      } catch (reason) {
        console.info('[PokéRun interaction] PRK45 DISPOSABLE FREE REJECTED', {
          disposableBitmap: disposableBitmap ? hex(disposableBitmap) : null,
          disposablePixels: disposablePixels ? hex(disposablePixels) : null,
          freeReturned,
          reason: reason instanceof Error ? reason.message : String(reason),
          note: 'Never retry native allocation/free in this guest after a failed PRK45 probe. The live AB window remains the independent baseline.',
        })
        return false
      }
    }

    // PRK46: prove AreaMan can reserve and release one *disposable*
    // 32-byte tile without freeing or modifying the 60 live AB tiles.
    // The native functions only change allocator reservation metadata:
    // no BG2 character graphics upload, BG2 screen-map write, or heap free.
    // Repeat the allocation ONCE to verify that the first free returned
    // exactly the same tail block, then release it again.
    async function tryPrk46DisposableBg2CharLifetime(
      playerActor: number, expectedBgSys: number,
      bg: number, charPos: number, liveBitmap: number, livePixels: number,
    ): Promise<boolean> {
      if (disposed || runtimeBridge.status !== 'running' ||
          bg !== MSGBG_BG2 || charPos !== 964 ||
          !isMainRamPointer(expectedBgSys) ||
          !isMainRamPointer(liveBitmap) || !isMainRamPointer(livePixels)) {
        console.info('[PokéRun interaction] PRK46 DISPOSABLE CHAR SKIPPED', {
          reason: 'The BG, field or live resource identities failed preflight.',
        })
        return false
      }
      const mainArea = await runtimeBridge.read32(
        expectedBgSys + PRK46_BGSYS_MAIN_AREA_PTR_OFFSET,
      )
      const charBaseBytes = await runtimeBridge.read32(
        expectedBgSys + PRK46_BGSYS_BG2_CHAR_BASE_OFFSET,
      )
      const charSizeBytes = await runtimeBridge.read32(
        expectedBgSys + PRK46_BGSYS_BG2_CHAR_SIZE_OFFSET,
      )
      const tilesTotal = charSizeBytes / 32
      if (!isMainRamPointer(mainArea) ||
          charBaseBytes % 32 !== 0 ||
          charBaseBytes > 0x10000 ||
          charSizeBytes !== 32768 ||
          tilesTotal !== 1024) {
        console.info('[PokéRun interaction] PRK46 DISPOSABLE CHAR SKIPPED', {
          mainArea: hex(mainArea),
          charBaseBytes: hex(charBaseBytes),
          charSizeBytes,
          tilesTotal,
          reason: 'AreaMan or BG2 character range differs from verified 1024-tile allocation.',
        })
        return false
      }
      const overlay = prk43ExpectedMapForWindow(charPos)
      const beforeMap = await inspectBg2MapReadOnly()
      const beforeStruct = await runtimeBridge.readBytes(liveBitmap, 12)
      const beforePixels = await runtimeBridge.readBytes(livePixels, 1920)
      const beforeShadow = beforeMap.ramMap
      const overlayOkay = beforeMap.bgSys === expectedBgSys &&
        beforeMap.vramMap !== null &&
        beforeMap.vramMap.length === overlay.length &&
        beforeMap.vramMap.every((value, i) => value === overlay[i])
      if (!overlayOkay || beforeShadow === null || beforeShadow.length !== 98 ||
          beforeStruct.length !== 12 || beforePixels.length !== 1920 ||
          (await runtimeBridge.read32(liveBitmap)) !== livePixels ||
          (await runtimeBridge.read16(liveBitmap + 4)) !== 96 ||
          (await runtimeBridge.read16(liveBitmap + 6)) !== 40 ||
          (await runtimeBridge.read16(liveBitmap + 8)) !== 32 ||
          (await runtimeBridge.read16(liveBitmap + 10)) !== 0) {
        console.info('[PokéRun interaction] PRK46 DISPOSABLE CHAR SKIPPED', {
          reason: 'Visible AB BG2 map or native bitmap baseline changed after PRK45.',
        })
        return false
      }
      async function sameFieldAndSafeStack(): Promise<boolean> {
        if (disposed || runtimeBridge.status !== 'running' ||
            (await runtimeBridge.read32(PRK43_BGSYS_GLOBAL_PTR)) !== expectedBgSys ||
            (await runtimeBridge.read32(expectedBgSys + PRK46_BGSYS_MAIN_AREA_PTR_OFFSET)) !== mainArea) {
          return false
        }
        const current = await probe.scanHeap()
        if (current.playerActor?.address !== playerActor ||
            current.playerActor.modelId !== EXPECTED_STABLE_PLAYER_MODEL) {
          return false
        }
        return validNativeStack(await runtimeBridge.getArm9Sp()) ||
          await waitForActiveNativeStack()
      }
      if (!(await sameFieldAndSafeStack())) {
        console.info('[PokéRun interaction] PRK46 DISPOSABLE CHAR SKIPPED', {
          reason: 'Field identity, AreaMan pointer, or ARM9 DTCM stack is no longer safe.',
        })
        return false
      }
      console.info('[PokéRun interaction] PRK46 DISPOSABLE BG2 CHAR PREFLIGHT', {
        bg, bgSys: hex(expectedBgSys),
        mainCharAreaMan: hex(mainArea),
        charBaseBytes, charSizeBytes, tilesTotal,
        liveCharPos: charPos,
        liveTileRange: [charPos, charPos + WINDOW_WIDTH * WINDOW_HEIGHT - 1],
        disposableSizeBytes: 32,
        allocateFromEnd: true,
        expectedTailPosition: charPos - 1,
        beforeMapHash: prk43SnapshotHash(beforeMap.vramMap),
        note: 'Reserve one unreferenced BG2 character block; free/reallocate/free using native AreaMan bookkeeping. Never upload any VRAM bytes.',
      })

      let firstPos = AREAMAN_FAIL
      let secondPos = AREAMAN_FAIL
      let firstFreeReturned = false
      let secondFreeReturned = false
      let firstAllocInstructions = 0
      let firstFreeInstructions = 0
      let secondAllocInstructions = 0
      let secondFreeInstructions = 0
      let failedNativeCall = false
      let unexpectedReservation = false
      try {
        let firstCall
        try {
          firstCall = await atomicCall(GFL_BGSYS_ALLOC_CHAR, bg, 32, 1)
        } catch (reason) {
          failedNativeCall = true
          throw reason
        }
        firstPos = firstCall.result
        firstAllocInstructions = firstCall.instructions
        const validIsolated = firstPos !== AREAMAN_FAIL &&
          firstPos === charPos - 1 &&
          firstPos + 1 <= charPos &&
          firstPos >= 0 &&
          firstPos < tilesTotal
        console.info('[PokéRun interaction] PRK46 FIRST DISPOSABLE TILE RESERVED', {
          position: firstPos === AREAMAN_FAIL ? 'AREAMAN_FAIL' : firstPos,
          expected: charPos - 1,
          isolatedFromLiveWindow: validIsolated,
          instructions: firstAllocInstructions,
        })
        if (!validIsolated) {
          unexpectedReservation = true
          throw new Error('PRK46 AreaMan did not allocate the expected single tile preceding the 60 live tiles; no free attempted.')
        }
        if (!(await sameFieldAndSafeStack())) {
          throw new Error('PRK46 field/stack changed after first disposable allocation; no native free attempted.')
        }
        try {
          const call = await atomicCall(GFL_BGSYS_FREE_CHAR_MEMORY, bg, firstPos, 32)
          firstFreeInstructions = call.instructions
          firstFreeReturned = true
        } catch (reason) {
          failedNativeCall = true
          throw reason
        }
        console.info('[PokéRun interaction] PRK46 FIRST DISPOSABLE TILE FREED', {
          position: firstPos,
          instructions: firstFreeInstructions,
          freeReturnType: 'void',
          note: 'White 2 AreaManDeAlloc returned; next allocation tests if the same block became available.',
        })
        if (!(await sameFieldAndSafeStack())) {
          throw new Error('PRK46 field/stack changed before reallocation; no further native call attempted.')
        }
        let secondCall
        try {
          secondCall = await atomicCall(GFL_BGSYS_ALLOC_CHAR, bg, 32, 1)
        } catch (reason) {
          failedNativeCall = true
          throw reason
        }
        secondPos = secondCall.result
        secondAllocInstructions = secondCall.instructions
        const reuseVerified = secondPos === firstPos
        console.info('[PokéRun interaction] PRK46 AREA MAN TILE REUSE', {
          firstPosition: firstPos,
          secondPosition: secondPos === AREAMAN_FAIL ? 'AREAMAN_FAIL' : secondPos,
          reusedSameTile: reuseVerified,
          firstFreeReturned,
          instructions: secondAllocInstructions,
        })
        if (!reuseVerified) {
          unexpectedReservation = true
          throw new Error('PRK46 allocated a different tail block after native free; no unsafe second free.')
        }
        if (!(await sameFieldAndSafeStack())) {
          throw new Error('PRK46 field/stack changed before final disposable tile free.')
        }
        try {
          const call = await atomicCall(GFL_BGSYS_FREE_CHAR_MEMORY, bg, secondPos, 32)
          secondFreeInstructions = call.instructions
          secondFreeReturned = true
        } catch (reason) {
          failedNativeCall = true
          throw reason
        }
        const afterMap = await inspectBg2MapReadOnly()
        const afterShadow = afterMap.ramMap
        const sameMap = afterMap.bgSys === beforeMap.bgSys &&
          afterMap.screenPtr === beforeMap.screenPtr &&
          afterMap.screenBase === beforeMap.screenBase &&
          afterMap.vramMap !== null &&
          afterMap.vramMap.length === overlay.length &&
          afterMap.vramMap.every((value, i) => value === overlay[i])
        const sameShadow = afterShadow !== null &&
          afterShadow.length === beforeShadow.length &&
          afterShadow.every((value, i) => value === beforeShadow[i])
        const afterStruct = await runtimeBridge.readBytes(liveBitmap, 12)
        const afterPixels = await runtimeBridge.readBytes(livePixels, 1920)
        const sameLiveStruct = afterStruct.length === beforeStruct.length &&
          afterStruct.every((value, i) => value === beforeStruct[i])
        const sameLivePixels = afterPixels.length === beforePixels.length &&
          afterPixels.every((value, i) => value === beforePixels[i])
        const sameAreaMan = (await runtimeBridge.read32(
          expectedBgSys + PRK46_BGSYS_MAIN_AREA_PTR_OFFSET,
        )) === mainArea
        if (!sameAreaMan || !sameMap || !sameShadow ||
            !sameLiveStruct || !sameLivePixels) {
          throw new Error('PRK46 post-free AB graphics or AreaMan identity changed.')
        }
        console.info('[PokéRun interaction] PRK46 DISPOSABLE BG2 CHAR LIFETIME VERIFIED', {
          firstPos, secondPos,
          firstFreeReturned, secondFreeReturned,
          reusedSameTile: reuseVerified,
          sameAreaMan,
          sameMap, sameShadow, sameLiveStruct, sameLivePixels,
          instructions: {
            firstAlloc: firstAllocInstructions,
            firstFree: firstFreeInstructions,
            secondAlloc: secondAllocInstructions,
            secondFree: secondFreeInstructions,
          },
          liveReservation: { bg, start: charPos, tileCount: 60, bytes: 1920 },
          disposableReservationsRemaining: 0,
          overlayVramHash: prk43SnapshotHash(afterMap.vramMap),
          note: 'Native AreaMan single-tile reserve/free/reuse/final-free completed without changing AB tiles or screen. Does not yet prove full-window teardown or repeated reopening.',
        })
        return true
      } catch (reason) {
        console.info('[PokéRun interaction] PRK46 DISPOSABLE CHAR REJECTED', {
          firstPos: firstPos === AREAMAN_FAIL ? null : firstPos,
          secondPos: secondPos === AREAMAN_FAIL ? null : secondPos,
          firstFreeReturned,
          secondFreeReturned,
          failedNativeCall,
          unexpectedReservation,
          reason: reason instanceof Error ? reason.message : String(reason),
          note: 'Stop this session after rejection. Never issue speculative native frees or repeat allocations after unexpected AreaMan state.',
        })
        return false
      }
    }

    // PRK47: first one-way close of the *real* native White 2 AB window.
    // PRK44 verified reversible BG2 map restoration, PRK45 native bitmap
    // destructor, and PRK46 one-tile AreaMan free/reuse independently.
    // Do not attempt to reopen in this experiment: the ref state is
    // intentionally locked after cleanup until a completely fresh session.
    async function tryPrk47OneWayNativeWindowClose(
      playerActor: number,
      baseline: Prk43Bg2MapSnapshot,
      bg: number,
      charPos: number,
      liveBitmap: number,
      livePixels: number,
      heapId: number,
    ): Promise<boolean> {
      const expectedOverlay = prk43ExpectedMapForWindow(charPos)
      const originalVram = baseline.vramMap
      const originalShadow = baseline.ramMap
      const screenNow = await inspectBg2MapReadOnly()
      const areaMan = await runtimeBridge.read32(
        baseline.bgSys + PRK46_BGSYS_MAIN_AREA_PTR_OFFSET,
      )
      const charBase = await runtimeBridge.read32(
        baseline.bgSys + PRK46_BGSYS_BG2_CHAR_BASE_OFFSET,
      )
      const charSize = await runtimeBridge.read32(
        baseline.bgSys + PRK46_BGSYS_BG2_CHAR_SIZE_OFFSET,
      )
      const bitmapHeader = await runtimeBridge.readBytes(liveBitmap, 12)
      const preflight =
        !disposed && runtimeBridge.status === 'running' &&
        !metadataCompleteRef.current &&
        stateRef.current?.window === liveBitmap &&
        bg === MSGBG_BG2 && charPos === 964 && heapId === 21 &&
        isMainRamPointer(baseline.bgSys) &&
        isMainRamPointer(areaMan) &&
        isMainRamPointer(liveBitmap) &&
        isMainRamPointer(livePixels) &&
        charBase === 65536 && charSize === 32768 &&
        originalVram !== null && originalVram.length === 98 &&
        originalShadow !== null && originalShadow.length === 98 &&
        originalVram.every((value, i) => value === originalShadow[i]) &&
        screenNow.bgSys === baseline.bgSys &&
        screenNow.screenPtr === baseline.screenPtr &&
        screenNow.screenSize === baseline.screenSize &&
        screenNow.screenBase === baseline.screenBase &&
        screenNow.controlScreenBase === baseline.controlScreenBase &&
        screenNow.screenBase === screenNow.controlScreenBase &&
        screenNow.ramMap !== null && screenNow.ramMap.length === 98 &&
        screenNow.ramMap.every((value, i) => value === originalShadow[i]) &&
        screenNow.vramMap !== null && screenNow.vramMap.length === 98 &&
        screenNow.vramMap.every((value, i) => value === expectedOverlay[i]) &&
        bitmapHeader.length === 12 &&
        (await runtimeBridge.read32(liveBitmap)) === livePixels &&
        (await runtimeBridge.read16(liveBitmap + 4)) === 96 &&
        (await runtimeBridge.read16(liveBitmap + 6)) === 40 &&
        (await runtimeBridge.read16(liveBitmap + 8)) === 32 &&
        (await runtimeBridge.read16(liveBitmap + 10)) === 0

      if (!preflight || originalVram === null || originalShadow === null) {
        console.info('[PokéRun interaction] PRK47 REAL WINDOW CLOSE PREFLIGHT SKIPPED', {
          stateWindow: stateRef.current ? hex(stateRef.current.window) : null,
          expectedBitmap: hex(liveBitmap),
          baselineVramAvailable: originalVram !== null,
          baselineShadowAvailable: originalShadow !== null,
          charBase, charSize, areaMan: hex(areaMan),
          note: 'No real-window resources freed or map entries modified; the known-good AB window is preserved.',
        })
        return false
      }

      async function sameFieldAndSafeStack(): Promise<boolean> {
        if (disposed || runtimeBridge.status !== 'running' ||
            (await runtimeBridge.read32(PRK43_BGSYS_GLOBAL_PTR)) !== baseline.bgSys ||
            (await runtimeBridge.read32(
              baseline.bgSys + PRK46_BGSYS_MAIN_AREA_PTR_OFFSET,
            )) !== areaMan ||
            (await runtimeBridge.read32(
              baseline.bgSys + PRK46_BGSYS_BG2_CHAR_BASE_OFFSET,
            )) !== charBase ||
            (await runtimeBridge.read32(
              baseline.bgSys + PRK46_BGSYS_BG2_CHAR_SIZE_OFFSET,
            )) !== charSize) {
          return false
        }
        const current = await probe.scanHeap()
        if (current.playerActor?.address !== playerActor ||
            current.playerActor.modelId !== EXPECTED_STABLE_PLAYER_MODEL) {
          return false
        }
        return validNativeStack(await runtimeBridge.getArm9Sp()) ||
          await waitForActiveNativeStack()
      }
      if (!(await sameFieldAndSafeStack())) {
        console.info('[PokéRun interaction] PRK47 REAL WINDOW CLOSE PREFLIGHT SKIPPED', {
          reason: 'Field actor, AreaMan ownership, or active ARM9 stack not ready.',
        })
        return false
      }

      console.info('[PokéRun interaction] PRK47 REAL WINDOW CLOSE PREFLIGHT PASSED', {
        playerActor: hex(playerActor), bg, charPos,
        charTileRange: [charPos, charPos + 59],
        ownedBitmap: hex(liveBitmap),
        ownedPixels: hex(livePixels),
        areaMan: hex(areaMan),
        originalMapHash: prk43SnapshotHash(originalVram),
        displayedMapHash: prk43SnapshotHash(screenNow.vramMap),
        entriesToRestore: originalVram.length,
        rowsToRestore: WINDOW_HEIGHT + 2,
        bytesPerCall: FRAME_FULL_ROW_BYTES,
        note: 'ONE-WAY CLOSE: restore 98 BG2 map entries, verify, then free the original 60-tile reservation and owned bitmap. The AB window should disappear. NO reopen is attempted.',
      })

      let restoredRows = 0
      let mapRestored = false
      let scratchRestored = false
      let charReleased = false
      let bitmapReleased = false
      let failedNativeCall = false
      let scratchOriginal: Uint8Array | null = null
      try {
        scratchOriginal = await runtimeBridge.readBytes(
          livePixels, FRAME_FULL_ROW_BYTES,
        )
        if (scratchOriginal.length !== FRAME_FULL_ROW_BYTES) {
          throw new Error('PRK47 could not preserve native bitmap transfer scratch.')
        }
        for (let row = 0; row < WINDOW_HEIGHT + 2; row += 1) {
          if (!(await sameFieldAndSafeStack())) {
            throw new Error('PRK47 field or native stack changed before screen-map row ' + row)
          }
          const data = new Uint8Array(FRAME_FULL_ROW_BYTES)
          for (let col = 0; col < WINDOW_WIDTH + 2; col += 1) {
            const value = originalVram[row * (WINDOW_WIDTH + 2) + col]
            data[2 * col] = value & 255
            data[2 * col + 1] = value >>> 8
          }
          await runtimeBridge.writeBytes(livePixels, data)
          const observedScratch = await runtimeBridge.readBytes(
            livePixels, FRAME_FULL_ROW_BYTES,
          )
          if (observedScratch.length !== FRAME_FULL_ROW_BYTES ||
              observedScratch.some((value, i) => value !== data[i])) {
            throw new Error('PRK47 row scratch readback failed at row ' + row)
          }
          try {
            await atomicCall(
              GFL_BGSYS_LOAD_SCR_CORE, bg,
              livePixels, FRAME_FULL_ROW_BYTES,
              (WINDOW_Y - 1 + row) * TEXT_BG_WIDTH_TILES + WINDOW_X - 1,
            )
          } catch (reason) {
            failedNativeCall = true
            throw reason
          }
          restoredRows += 1
        }

        const originalMapCheck = await inspectBg2MapReadOnly()
        const mapMatches = originalMapCheck.bgSys === baseline.bgSys &&
          originalMapCheck.screenPtr === baseline.screenPtr &&
          originalMapCheck.screenBase === baseline.screenBase &&
          originalMapCheck.controlScreenBase === baseline.controlScreenBase &&
          originalMapCheck.vramMap !== null &&
          originalMapCheck.vramMap.length === originalVram.length &&
          originalMapCheck.vramMap.every((value, i) => value === originalVram[i])
        const originalShadowMatches = originalMapCheck.ramMap !== null &&
          originalMapCheck.ramMap.length === originalShadow.length &&
          originalMapCheck.ramMap.every((value, i) => value === originalShadow[i])
        if (!mapMatches || !originalShadowMatches) {
          throw new Error('PRK47 native BG2 original map or RAM shadow failed verification.')
        }
        mapRestored = true
        console.info('[PokéRun interaction] PRK47 ORIGINAL BG2 MAP RESTORED VERIFIED', {
          restoredRows, bytesTransferred: restoredRows * FRAME_FULL_ROW_BYTES,
          entriesVerified: originalVram.length,
          originalVramHash: prk43SnapshotHash(originalMapCheck.vramMap),
          shadowUnchanged: originalShadowMatches,
          note: 'The native AB window is now hidden behind the exact original BG2 map. No resources freed yet.',
        })

        // The first 28 bytes were an expendable native transfer scratch,
        // but PRK47 must restore them BEFORE freeing its backing allocation.
        await runtimeBridge.writeBytes(livePixels, scratchOriginal)
        const restoredScratch = await runtimeBridge.readBytes(
          livePixels, FRAME_FULL_ROW_BYTES,
        )
        scratchRestored = restoredScratch.length === FRAME_FULL_ROW_BYTES &&
          restoredScratch.every((value, i) => value === scratchOriginal![i])
        if (!scratchRestored) {
          throw new Error('PRK47 bitmap staging scratch was not fully restored; no frees allowed.')
        }

        if (!(await sameFieldAndSafeStack())) {
          throw new Error('PRK47 field or native stack changed before real BG2 character free.')
        }
        // The guest is still running between asynchronous calls. Recheck
        // the full tilemap immediately before deallocating its 60 live tiles:
        // no game-side screen update may have reintroduced those references.
        const preFreeMap = await inspectBg2MapReadOnly()
        const preFreeMatches = preFreeMap.bgSys === baseline.bgSys &&
          preFreeMap.screenPtr === baseline.screenPtr &&
          preFreeMap.screenBase === baseline.screenBase &&
          preFreeMap.vramMap !== null &&
          preFreeMap.vramMap.length === originalVram.length &&
          preFreeMap.vramMap.every((value, i) => value === originalVram[i]) &&
          preFreeMap.ramMap !== null &&
          preFreeMap.ramMap.length === originalShadow.length &&
          preFreeMap.ramMap.every((value, i) => value === originalShadow[i])
        if (!preFreeMatches) {
          throw new Error('PRK47 BG2 map changed between restoration and real char deallocation.')
        }
        // The tilemap was verified to no longer reference 964..1023.
        // The real AreaMan reservation can now be released with the
        // same three-argument Thumb4 call proven by PRK46.
        let charFreeInstructions = 0
        try {
          const released = await atomicCall(GFL_BGSYS_FREE_CHAR_MEMORY, bg, charPos, 1920)
          charFreeInstructions = released.instructions
        } catch (reason) {
          failedNativeCall = true
          throw reason
        }
        charReleased = true
        // No new X press can re-enter this experiment after a partially
        // completed real-resource free, even if a later call fails.
        metadataCompleteRef.current = true
        console.info('[PokéRun interaction] PRK47 REAL BG2 CHAR RESERVATION FREED', {
          bg, startTile: charPos, tileCount: 60, releasedBytes: 1920,
          nativeFreeInstructions: charFreeInstructions,
          originalMapStillVerified: mapRestored,
          note: 'Native AreaMan release returned. No screen-map entries point to these character tiles.',
        })

        if (!(await sameFieldAndSafeStack())) {
          throw new Error('PRK47 field or native stack changed before owned GFLBitmap destructor.')
        }
        // GFL_BitmapFree releases the owned 1920-byte pixel allocation
        // followed by the separately allocated 12-byte bitmap structure.
        try {
          const freed = await atomicCall(GFL_BITMAP_FREE, liveBitmap)
          bitmapReleased = true
          stateRef.current = null // never retain a pointer to freed bitmap
          emitMenuState(false)
          console.info('[PokéRun interaction] PRK47 REAL OWNED BITMAP FREED', {
            originalBitmap: hex(liveBitmap),
            originalPixels: hex(livePixels),
            nativeFreeInstructions: freed.instructions,
            nativeReturnType: 'void',
            note: 'Both original window allocations are now released. Never dereference these addresses or reopen in this session.',
          })
        } catch (reason) {
          failedNativeCall = true
          stateRef.current = null // avoid stale ownership after a failed destructor
          throw reason
        }

        // After free we may read only still-owned BGSys/actor/map state.
        // Never read the now-freed bitmap or its backing pixel buffer.
        const finalMap = await inspectBg2MapReadOnly()
        const finalActor = await probe.scanHeap()
        const cleanMap = finalMap.bgSys === baseline.bgSys &&
          finalMap.screenPtr === baseline.screenPtr &&
          finalMap.vramMap !== null &&
          finalMap.vramMap.length === originalVram.length &&
          finalMap.vramMap.every((value, i) => value === originalVram[i])
        const cleanShadow = finalMap.ramMap !== null &&
          finalMap.ramMap.length === originalShadow.length &&
          finalMap.ramMap.every((value, i) => value === originalShadow[i])
        const stillSameAreaMan = (await runtimeBridge.read32(
          baseline.bgSys + PRK46_BGSYS_MAIN_AREA_PTR_OFFSET,
        )) === areaMan
        const playerHealthy = finalActor.playerActor?.address === playerActor &&
          finalActor.playerActor.modelId === EXPECTED_STABLE_PLAYER_MODEL
        if (!cleanMap || !cleanShadow || !stillSameAreaMan ||
            !playerHealthy || stateRef.current !== null ||
            !metadataCompleteRef.current) {
          throw new Error('PRK47 post-free screen, allocator, player, or ownership state changed.')
        }
        console.info('[PokéRun interaction] PRK47 ACTUAL WINDOW TEARDOWN VERIFIED', {
          restoredRows, restoredEntries: 98,
          originalMapHash: prk43SnapshotHash(finalMap.vramMap),
          shadowUnchanged: cleanShadow,
          playerHealthy, sameAreaMan: stillSameAreaMan,
          charReleased, bitmapReleased, scratchRestored,
          staleWindowPointerRetained: false,
          furtherInteractionLocked: metadataCompleteRef.current,
          note: 'First one-way real-window close passed. Background restored and both allocations released. P2 external health and screenshot still required. Reopening intentionally NOT attempted.',
        })
        return true
      } catch (reason) {
        // Never retry a partly completed teardown in the same guest. Once
        // native free has begun, refs stay locked to prevent use-after-free.
        if (restoredRows > 0 || charReleased || bitmapReleased) {
          metadataCompleteRef.current = true
        }
        console.info('[PokéRun interaction] PRK47 REAL WINDOW TEARDOWN REJECTED', {
          restoredRows, mapRestored, scratchRestored,
          charReleased, bitmapReleased, failedNativeCall,
          staleWindowPointerRetained: stateRef.current !== null,
          reason: reason instanceof Error ? reason.message : String(reason),
          note: 'Do NOT retry in this guest session. A partially restored map or freed resource cannot be blindly undone; restart and preserve the logs.',
        })
        return false
      } finally {
        // On an early failure before ownership is released, restore the RAM
        // scratch (but never attempt to write through a freed pointer).
        if (!charReleased && !bitmapReleased && scratchOriginal !== null) {
          try {
            await runtimeBridge.writeBytes(livePixels, scratchOriginal)
            const readback = await runtimeBridge.readBytes(
              livePixels, FRAME_FULL_ROW_BYTES,
            )
            scratchRestored = readback.length === FRAME_FULL_ROW_BYTES &&
              readback.every((value, i) => value === scratchOriginal![i])
            console.info('[PokéRun interaction] PRK47 BITMAP SCRATCH FINALIZED', {
              restored: scratchRestored,
              note: 'Only allocated bitmap RAM touched. No native ARM9 calls made in finalization.',
            })
          } catch (reason) {
            console.info('[PokéRun interaction] PRK47 BITMAP SCRATCH RESTORE FAILED', {
              reason: reason instanceof Error ? reason.message : String(reason),
              note: 'No further operations should be attempted in this session.',
            })
          }
        }
      }
    }

    async function runProbe() {
      if (openingRef.current || metadataCompleteRef.current || stateRef.current || runtimeBridge.status !== 'running') {
        if (stateRef.current || metadataCompleteRef.current) {
          console.info('[PokéRun interaction] BG2 SAFE-STACK FONT ROM PROBE HOLD', { window: stateRef.current ? hex(stateRef.current.window) : null, metadataComplete: metadataCompleteRef.current })
        }
        return
      }
      openingRef.current = true

      try {
        let prk38GlyphRomOffset: number | null = null
        let prk49FontLayout: { memberStart: number; memberLength: number; glyphsOffset: number } | null = null
        let prk43Before: Prk43Bg2MapSnapshot | null = null
        let prk40VisualComplete = false
        const scan = await probe.scanHeap()
        if (!scan.playerActor || !isMainRamPointer(scan.playerActor.address)) {
          throw new Error(`Player actor is invalid (${hex(scan.playerActor?.address ?? 0)}).`)
        }

        const playerActor = scan.playerActor.address
        const modelId = scan.playerActor.modelId
        if (modelId !== EXPECTED_STABLE_PLAYER_MODEL) {
          console.info('[PokéRun interaction] FIELD NOT READY - SKIP NATIVE CALLS', {
            actor: hex(playerActor),
            modelId,
            expectedModelId: EXPECTED_STABLE_PLAYER_MODEL,
            note: 'Player is still in transitional model state. Do not enter native field getters or allocate a window until fully initialized.',
          })
          return
        }
        // Read-only ROM validation never needs a native call, so keep it
        // independent of the graphics/heap execution context.
        if (PRK33_FOUR_ARG_BG2_VISUAL) {
          try {
            const verified = await verifyBrowserHeldFontRom(WHITE2_KNOWN_FIELD_MSGBG)
            prk38GlyphRomOffset = verified?.glyphAbsoluteRomOffset ?? null
            if (verified?.glyphIndex === 33 && verified.glyphCellSize === 48) {
              const memberStart = verified.fatEntryStart + verified.narcMemberOffset
              const glyphsOffset = verified.glyphAbsoluteRomOffset - memberStart -
                verified.glyphIndex * verified.glyphCellSize
              if (glyphsOffset >= 0 && glyphsOffset < verified.narcMemberLength) {
                prk49FontLayout = { memberStart, memberLength: verified.narcMemberLength, glyphsOffset }
              }
            }
          } catch (reason) {
            console.info('[PokéRun interaction] PRK35 ROM FAT NARC VERIFICATION REJECTED', {
              reason: reason instanceof Error ? reason.message : String(reason),
              note: 'Read-only verifier rejected the exact-ROM FieldMsgBG metadata. No native calls or emulator writes were made by verification.',
            })
          }
          if (!(await waitForActiveNativeStack())) return
        }
        const effects = (await atomicCall(FLD_ACT_GET_FIELD_EFFECTS, playerActor)).result
        if (!isMainRamPointer(effects)) throw new Error(`FldAct_GetFieldEffects returned ${hex(effects)}.`)

        const field = (await atomicCall(FIELD_EFFECTS_GET_FIELD, effects)).result
        if (!isMainRamPointer(field)) throw new Error(`FieldEffects_GetField returned ${hex(field)}.`)

        const controllerType = (await atomicCall(FIELD_GET_CONTROLLER_TYPE_ID, field)).result
        if (controllerType !== FIELDMAP_CTRL_GRID) {
          throw new Error(`Field controller ${controllerType} is not the normal grid controller.`)
        }

        const heapId = (await atomicCall(FIELD_GET_HEAP_ID, field)).result
        const msgBg = (await atomicCall(FIELD_GET_MSGBG_SYS, field)).result
        if (!isMainRamPointer(msgBg)) throw new Error(`Field_GetMsgBGSys returned ${hex(msgBg)}.`)

        const bg = await runtimeBridge.read16(msgBg + 0x02)
        const bg2 = await runtimeBridge.read16(msgBg + 0x04)
        const paletteBefore = await runtimeBridge.read16(msgBg + 0x06)
        if (bg2 !== MSGBG_BG2) throw new Error(`FieldMsgBG bg2 is ${bg2}; expected ${MSGBG_BG2}.`)

        if (PRK31_ROM_RANGE_ONLY) {
          // Font and ArcTool metadata are already in guest RAM. Native field getters
          // above are run only after the player reaches stable model 240.
          // No BmpWin_CreateDynamic (its stack-passed height/palette were intermittent),
          // no GFL_StrBuf, no streamed glyph lookup, and no FS_ReadFile here.
          const font = await runtimeBridge.read32(msgBg + 0x08)
          if (!isMainRamPointer(font)) throw new Error(`Live FieldMsgBG font invalid: ${hex(font)}.`)
          const loadType = await runtimeBridge.read32(font + 0x00)
          const arcTool = await runtimeBridge.read32(font + 0x50)
          const narcMemberFileId = await runtimeBridge.read32(font + 0x54)
          const fontInfoGlyphOffset = await runtimeBridge.read32(font + 0x60)
          const glyphCellWidth = await runtimeBridge.read8(font + 0x74)
          const glyphCellHeight = await runtimeBridge.read8(font + 0x75)
          const glyphCellSize = await runtimeBridge.read16(font + 0x76)
          const glyphBpp = await runtimeBridge.read8(font + 0x7a)
          const fontFileOffset = await runtimeBridge.read32(font + 0x80)
          const maps = await runtimeBridge.read32(font + 0x88)
          const glyphsOffset = await runtimeBridge.read32(font + 0x8c)
          if (!isMainRamPointer(arcTool) || !isMainRamPointer(maps)) {
            throw new Error(`Invalid ArcTool/CMAP pointers ${hex(arcTool)} / ${hex(maps)}.`)
          }
          const mapFirst = await runtimeBridge.read16(maps + 0x00)
          const mapLast = await runtimeBridge.read16(maps + 0x02)
          const mapMethod = await runtimeBridge.read16(maps + 0x04)
          const mapFirstIndex = await runtimeBridge.read16(maps + 0x0c)
          if (
            bg2 !== 2 || loadType !== 0 || mapMethod !== 0 ||
            !(mapFirst <= STRBUF_PROBE_CHAR && STRBUF_PROBE_CHAR <= mapLast) ||
            fontInfoGlyphOffset + 8 !== glyphsOffset ||
            glyphCellSize < 4 || glyphCellSize > 512 ||
            glyphCellWidth !== 12 || glyphCellHeight !== 15 || glyphBpp !== 2
          ) throw new Error('Live font CMAP/metadata does not match tested White 2 field layout.')
          const glyphIndex = mapFirstIndex + STRBUF_PROBE_CHAR - mapFirst
          const glyphWithinArchive = fontFileOffset + glyphsOffset + glyphIndex * glyphCellSize

          // ArcTool embeds FSFile at offset zero. FSFile.body.file fields:
          // +0x20 fileId, +0x24 top, +0x28 bottom, +0x2c position.
          const propertyPtr = await runtimeBridge.read32(arcTool + 0x04)
          const archivePtr = await runtimeBridge.read32(arcTool + 0x08)
          const status = await runtimeBridge.read32(arcTool + 0x0c)
          const errorCode = await runtimeBridge.read32(arcTool + 0x14)
          const romFileId = await runtimeBridge.read32(arcTool + 0x20)
          const romStart = await runtimeBridge.read32(arcTool + 0x24)
          const romEnd = await runtimeBridge.read32(arcTool + 0x28)
          const romPosition = await runtimeBridge.read32(arcTool + 0x2c)
          const candidateAbsoluteRomOffset = romStart + glyphWithinArchive
          const candidateEnd = candidateAbsoluteRomOffset + glyphCellSize
          const fsFileValid = (
            propertyPtr === arcTool + 0x20 &&
            isMainRamPointer(archivePtr) &&
            (status & 0x10) !== 0 &&
            romStart > 0 && romEnd > romStart &&
            romEnd <= 0x20000000 &&
            romPosition >= romStart && romPosition <= romEnd &&
            candidateEnd <= romEnd &&
            glyphIndex === 33 && glyphWithinArchive === 1760
          )
          console.info('[PokéRun interaction] NATIVE FONT FSFILE RANGE', {
            field: hex(field),
            bg2,
            font: hex(font),
            arcTool: hex(arcTool),
            fsFileProperty: hex(propertyPtr),
            expectedProperty: hex(arcTool + 0x20),
            fsArchive: hex(archivePtr),
            fsStat: hex(status),
            fsError: errorCode,
            rootRomFileId: romFileId,
            romFileStart: hex(romStart),
            romFileEnd: hex(romEnd),
            romFileBytes: romEnd - romStart,
            currentPosition: hex(romPosition),
            narcMemberFileId,
            mapFirst, mapLast, mapMethod,
            glyphIndex,
            glyphCellSize,
            glyphWithinArchive,
            fsFileValid,
            note: 'Read-only FSFile and Font fields; no native window or guest filesystem read.',
          })
          if (!fsFileValid) {
            throw new Error('FSFile bounds/property do not validate. Absolute ROM offset remains unconfirmed.')
          }
          console.info('[PokéRun interaction] NATIVE FONT ROM OFFSET SUCCESS', {
            rootRomFileId: romFileId,
            archiveFileStart: hex(romStart),
            archiveFileEnd: hex(romEnd),
            narcMemberFileId,
            glyphIndex,
            glyphCellBytes: glyphCellSize,
            glyphWithinNarcOffset: glyphWithinArchive,
            candidateAbsoluteRomOffset: hex(candidateAbsoluteRomOffset),
            candidateAbsoluteRomEnd: hex(candidateEnd),
            note: 'Candidate cartridge ROM byte range derived without BmpWin creation. Verify against browser-held NDS FAT in a separate test before using.',
          })
          metadataCompleteRef.current = true
          emitMenuState(false)
          return
        }

        const colorMode = (await atomicCall(GFL_BGSYS_GET_BG_COLOR_PALETTE_MODE, bg2)).result
        const bytesPerTile = (await atomicCall(GFL_BGSYS_GET_BG_BYTES_PER_TILE, bg2)).result
        const bgMode = (await atomicCall(GFL_BGSYS_GET_BG_MODE, bg2)).result
        const tileCount = WINDOW_WIDTH * WINDOW_HEIGHT
        const requestedBytes = tileCount * bytesPerTile
        if (bytesPerTile !== 32 || bytesPerTile > CHAR_DMA_THRESHOLD) {
          throw new Error(`BG2 tile size is ${bytesPerTile} bytes; expected a 32-byte tile below the ${CHAR_DMA_THRESHOLD}-byte character DMA threshold.`)
        }
        if (bgMode !== 0 || SCREEN_ROW_BYTES > SCREEN_DMA_THRESHOLD) {
          throw new Error(`BG2 screen-row control requires text mode and <=${SCREEN_DMA_THRESHOLD} bytes; mode=${bgMode} rowBytes=${SCREEN_ROW_BYTES}.`)
        }

        console.info('[PokéRun interaction] BG SCREEN CHUNKED CPU FIELD PATH READY', {
          actor: hex(playerActor),
          effects: hex(effects),
          field: hex(field),
          heapId,
          msgBg: hex(msgBg),
          bg,
          bg2,
          paletteBefore,
          bgMode,
          colorMode,
          bytesPerTile,
          tileCount,
          requestedBytes,
          screenRowBytes: SCREEN_ROW_BYTES,
        })

        // PRK33: prove native BG2 visual output without any >4-arg guest calls.
        // BmpWin_CreateDynamic remains below as research/reference only.
        if (PRK33_FOUR_ARG_BG2_VISUAL) {
          const originalArm9Sp = await runtimeBridge.getArm9Sp()
          console.info('[PokéRun interaction] PRK36 GUARDED BG2 DISPLAY PREFLIGHT', {
            observedArm9Sp: hex(originalArm9Sp),
            dtcmGuardPassed: validNativeStack(originalArm9Sp),
            bridge: 'callArm9Thumb4',
            bg: bg2,
            heapId,
            expectedCharPos: 964,
            tiles: tileCount,
            bytes: requestedBytes,
            bitmapCreate: hex(GFL_BITMAP_CREATE),
            note: 'Native bitmap and BG2 char/screen CPU transfers only; no BmpWin_CreateDynamic.',
          })
          // Snapshot original tilemap before replacing any BG2 character
          // entries. If this read-only check fails, preserve PRK34/40.
          try {
            prk43Before = await inspectBg2MapReadOnly()
            console.info('[PokéRun interaction] PRK43 BG2 OWNERSHIP AND MAP BEFORE', {
              bgSys: hex(prk43Before.bgSys),
              shadowPointer: hex(prk43Before.screenPtr),
              shadowSize: prk43Before.screenSize,
              shadowOffset: prk43Before.screenOffset,
              screenBaseBytes: prk43Before.screenBase,
              bg2ControlBaseBytes: prk43Before.controlScreenBase,
              bgMode: prk43Before.mode,
              colorMode: prk43Before.colorMode,
              tileSize: prk43Before.tileSize,
              mapEntries: prk43Before.capturedPositions,
              shadowAvailable: prk43Before.ramMap !== null,
              vramReadAvailable: prk43Before.vramMap !== null,
              shadowHash: prk43SnapshotHash(prk43Before.ramMap),
              vramHash: prk43SnapshotHash(prk43Before.vramMap),
              note: 'Read-only 14x7 BG2 screen-area baseline before ANY PRK34/40 tilemap upload. No cleanup or memory mutation.',
            })
          } catch (reason) {
            console.info('[PokéRun interaction] PRK43 BG2 OWNERSHIP PREFLIGHT UNAVAILABLE', {
              reason: reason instanceof Error ? reason.message : String(reason),
              note: 'Native PRK34/40 visuals remain unchanged.',
            })
          }
          const charAlloc = await atomicCall(GFL_BGSYS_ALLOC_CHAR, bg2, requestedBytes, 1)
          const directCharPos = charAlloc.result
          if (directCharPos === AREAMAN_FAIL) {
            throw new Error('PRK34 BG2 character allocation failed.')
          }
          if (directCharPos !== 964 || directCharPos + tileCount !== 1024) {
            console.info('[PokéRun interaction] PRK34 BG2 ALLOCATION GUARD', {
              charPos: directCharPos, expectedCharPos: 964, tileCount,
              note: 'Abort before bitmap or VRAM writes; free the unexpected allocation.',
            })
            await atomicCall(GFL_BGSYS_FREE_CHAR_MEMORY, bg2, directCharPos, requestedBytes)
            return
          }
          console.info('[PokéRun interaction] PRK34 BITMAP CREATE CALL', {
            address: hex(GFL_BITMAP_CREATE),
            args: [WINDOW_WIDTH, WINDOW_HEIGHT, bytesPerTile, heapId],
            originalArm9Sp: hex(await runtimeBridge.getArm9Sp()),
            note: 'Four register arguments; native allocates GFLBitmap and pixel buffer internally.',
          })
          const bitmapAlloc = await atomicCall(GFL_BITMAP_CREATE, WINDOW_WIDTH, WINDOW_HEIGHT, bytesPerTile, heapId)
          const directBitmap = bitmapAlloc.result
          if (!isMainRamPointer(directBitmap)) {
            throw new Error('GFL_BitmapCreate returned invalid bitmap ' + hex(directBitmap))
          }
          const directPixels = await runtimeBridge.read32(directBitmap + 0x00)
          const directWidth = await runtimeBridge.read16(directBitmap + 0x04)
          const directHeight = await runtimeBridge.read16(directBitmap + 0x06)
          const directTileSize = await runtimeBridge.read16(directBitmap + 0x08)
          const directStorage = await runtimeBridge.read16(directBitmap + 0x0a)
          const bitmapValid = (
            isMainRamPointer(directPixels) &&
            directWidth === WINDOW_WIDTH * 8 &&
            directHeight === WINDOW_HEIGHT * 8 &&
            directTileSize === bytesPerTile &&
            directStorage === 0
          )
          console.info('[PokéRun interaction] PRK34 FOUR ARG BITMAP GEOMETRY', {
            bitmap: hex(directBitmap), pixels: hex(directPixels),
            widthPx: directWidth, heightPx: directHeight,
            tileSize: directTileSize, storage: directStorage,
            charPos: directCharPos, bitmapValid, createInstructions: bitmapAlloc.instructions,
          })
          if (!bitmapValid) {
            throw new Error('Four-argument GFL_BitmapCreate produced unexpected geometry; refusing BG2 uploads.')
          }
          const fillCall = await atomicCall(GFL_BITMAP_FILL, directBitmap, MSGBG_COLOR_BG_FILL)
          const firstTile = await runtimeBridge.readBytes(directPixels, bytesPerTile)
          if (firstTile.length !== bytesPerTile || firstTile.some(value => value !== 0xff)) {
            throw new Error('Bitmap fill did not set the first tile to expected 0xff; refusing BG2 uploads.')
          }
          let characterUploadInstructions = 0
          for (let tile = 0; tile < tileCount; tile += 1) {
            const result = await atomicCall(
              GFL_BGSYS_LOAD_CHAR, bg2, directPixels + tile * bytesPerTile, bytesPerTile, directCharPos + tile,
            )
            characterUploadInstructions += result.instructions
          }
          console.info('[PokéRun interaction] PRK34 BG2 CHAR CPU UPLOAD SUCCESS', {
            charPos: directCharPos, tiles: tileCount, bytes: requestedBytes,
            instructions: characterUploadInstructions, fillInstructions: fillCall.instructions,
          })
          const screenScratch = await runtimeBridge.readBytes(directPixels, FRAME_FULL_ROW_BYTES)
          if (screenScratch.length !== FRAME_FULL_ROW_BYTES) {
            throw new Error('Could not save 28 bytes of bitmap scratch for BG2 screen transfers.')
          }
          let screenCalls = 0
          let borderCalls = 0
          let screenUploadInstructions = 0
          async function uploadMapRow(x: number, y: number, tiles: number[], palette: number, border: boolean) {
            const bytes = tiles.length * 2
            if (bytes < 2 || bytes > SCREEN_DMA_THRESHOLD ||
                x < 0 || y < 0 || x + tiles.length > TEXT_BG_WIDTH_TILES || y >= TEXT_BG_WIDTH_TILES) {
              throw new Error('Unsafe PRK34 map segment x=' + x + ' y=' + y + ' tiles=' + tiles.length)
            }
            const entries = new Uint8Array(bytes)
            for (let i = 0; i < tiles.length; i += 1) {
              const value = ((palette << 12) | tiles[i]) & 0xffff
              entries[i * 2] = value & 0xff
              entries[i * 2 + 1] = value >>> 8
            }
            await runtimeBridge.writeBytes(directPixels, entries)
            const call = await atomicCall(
              GFL_BGSYS_LOAD_SCR_CORE, bg2, directPixels, bytes, y * TEXT_BG_WIDTH_TILES + x,
            )
            screenUploadInstructions += call.instructions
            if (border) borderCalls += 1
            else screenCalls += 1
          }
          try {
            for (let row = 0; row < WINDOW_HEIGHT; row += 1) {
              const tiles = Array.from({ length: WINDOW_WIDTH }, (_, col) => directCharPos + row * WINDOW_WIDTH + col)
              await uploadMapRow(WINDOW_X, WINDOW_Y + row, tiles, MSGBG_PLTT_BG2, false)
            }
            const frameBase = MSGBG_CHAR_FRAME
            await uploadMapRow(
              WINDOW_X - 1, WINDOW_Y - 1,
              [frameBase, ...Array<number>(WINDOW_WIDTH).fill(frameBase + 1), frameBase + 2],
              MSGBG_PLTT_BG2_FRAME, true,
            )
            for (let row = 0; row < WINDOW_HEIGHT; row += 1) {
              await uploadMapRow(WINDOW_X - 1, WINDOW_Y + row, [frameBase + 3], MSGBG_PLTT_BG2_FRAME, true)
              await uploadMapRow(WINDOW_X + WINDOW_WIDTH, WINDOW_Y + row, [frameBase + 5], MSGBG_PLTT_BG2_FRAME, true)
            }
            await uploadMapRow(
              WINDOW_X - 1, WINDOW_Y + WINDOW_HEIGHT,
              [frameBase + 6, ...Array<number>(WINDOW_WIDTH).fill(frameBase + 7), frameBase + 8],
              MSGBG_PLTT_BG2_FRAME, true,
            )
          } finally {
            await runtimeBridge.writeBytes(directPixels, screenScratch)
          }
          if (screenCalls !== WINDOW_HEIGHT || borderCalls !== 2 + WINDOW_HEIGHT * 2) {
            throw new Error('PRK34 upload count mismatch: interior=' + screenCalls + ' border=' + borderCalls)
          }
          stateRef.current = { window: directBitmap }
          emitMenuState(false)
          console.info('[PokéRun interaction] PRK34 NATIVE BG2 FRAMED WINDOW SUCCESS', {
            bg: bg2, bitmap: hex(directBitmap), charPos: directCharPos,
            x: WINDOW_X, y: WINDOW_Y,
            widthTiles: WINDOW_WIDTH, heightTiles: WINDOW_HEIGHT,
            blackCharTiles: tileCount, interiorScreenCalls: screenCalls, borderScreenCalls: borderCalls,
            screenUploadInstructions,
            note: 'Native White 2 BG2 window tiles and border upload calls returned; visual confirmation requires screenshot. No BmpWin object, text printer, or menu lifecycle was created.',
          })
          // PRK38 is deliberately NOT a new renderer or interaction menu.
          // It reads and temporarily modifies four GFLBitmap RAM tiles after
          // PRK34 has already uploaded the clean black window to BG2 VRAM.
          if (romBytes && prk38GlyphRomOffset !== null) {
            let prk38Passed = false
            try {
              await verifyGlyphBitmapRam(
                directPixels, romBytes, prk38GlyphRomOffset, bytesPerTile,
              )
              prk38Passed = true
            } catch (reason) {
              console.info('[PokéRun interaction] PRK38 GLYPH BITMAP RAM REJECTED', {
                reason: reason instanceof Error ? reason.message : String(reason),
                note: 'PRK34 BG2 visual remains the baseline. PRK38 does not call any guest native routine or BG2 character upload.',
              })
            }
            if (prk38Passed) {
              let prk39Passed = false
              try {
                await uploadGlyphAToBg2(
                  directPixels, directCharPos, bg2, romBytes,
                  prk38GlyphRomOffset, bytesPerTile,
                )
                prk39Passed = true
              } catch (reason) {
                console.info('[PokéRun interaction] PRK39 VISUAL GLYPH REJECTED', {
                  reason: reason instanceof Error ? reason.message : String(reason),
                  note: 'PRK39 stopped; the user should restart the guest before rerunning if a native tile upload failed.',
                })
              }
              if (prk39Passed) {
                try {
                  await uploadGlyphBToBg2(
                    directPixels, directCharPos, bg2, romBytes,
                    prk38GlyphRomOffset, bytesPerTile,
                  )
                  prk40VisualComplete = true
                } catch (reason) {
                  console.info('[PokéRun interaction] PRK40 AB CROSS-TILE REJECTED', {
                    reason: reason instanceof Error ? reason.message : String(reason),
                    note: 'PRK39 A visual remains the known-good baseline. Do not retry failed native uploads without restarting.',
                  })
                }
              }
            }
          } else {
            console.info('[PokéRun interaction] PRK38 GLYPH BITMAP RAM SKIPPED', {
              hasBrowserRom: Boolean(romBytes),
              hasVerifiedGlyphOffset: prk38GlyphRomOffset !== null,
            })
          }
          // Read-only PRK43 post-state. Never tear down the onscreen AB
          // window in this experiment. In particular GFL_BitmapFree alone
          // would leave the BG2 map pointing at freed character tiles.
          if (prk43Before) {
            try {
              // Capture the narrowed snapshot arrays as stable local constants.
              // TypeScript does not retain nullable outer-variable narrowing in
              // callbacks passed to every/reduce.
              const beforeRamMap = prk43Before.ramMap
              const beforeVramMap = prk43Before.vramMap
              const after = await inspectBg2MapReadOnly()
              const sameBgSys = after.bgSys === prk43Before.bgSys
              const sameShadow = after.screenPtr === prk43Before.screenPtr
              const shadowUnchanged = beforeRamMap !== null &&
                after.ramMap !== null &&
                after.ramMap.every((value, i) => value === beforeRamMap[i])
              const expected = prk43ExpectedMapForWindow(directCharPos)
              const vramMatching = after.vramMap !== null
                ? after.vramMap.reduce((n, value, i) => n + (value === expected[i] ? 1 : 0), 0)
                : null
              const vramChanged = beforeVramMap !== null && after.vramMap !== null
                ? after.vramMap.reduce((n, value, i) =>
                    n + (value !== beforeVramMap[i] ? 1 : 0), 0)
                : null
              const observedPixels = await runtimeBridge.read32(directBitmap)
              const observedWidth = await runtimeBridge.read16(directBitmap + 4)
              const observedHeight = await runtimeBridge.read16(directBitmap + 6)
              const observedTileSize = await runtimeBridge.read16(directBitmap + 8)
              const observedStorage = await runtimeBridge.read16(directBitmap + 10)
              const ownedBitmapValid = observedPixels === directPixels &&
                observedWidth === WINDOW_WIDTH * 8 &&
                observedHeight === WINDOW_HEIGHT * 8 &&
                observedTileSize === 32 && observedStorage === 0
              console.info('[PokéRun interaction] PRK43 BG2 OWNERSHIP AND MAP AFTER', {
                sameBgSys,
                sameScreenShadowPointer: sameShadow,
                shadowUnchanged,
                shadowAvailable: after.ramMap !== null,
                originalShadowHash: prk43SnapshotHash(prk43Before.ramMap),
                afterShadowHash: prk43SnapshotHash(after.ramMap),
                originalVramHash: prk43SnapshotHash(prk43Before.vramMap),
                afterVramHash: prk43SnapshotHash(after.vramMap),
                expectedOverlayEntries: expected.length,
                vramOverlayEntriesMatching: vramMatching,
                vramEntriesChanged: vramChanged,
                bitmap: hex(directBitmap),
                pixelBuffer: hex(observedPixels),
                ownedBitmapValid,
                charAllocation: { bg: bg2, position: directCharPos, tileCount, bytes: requestedBytes },
                cleanupPlan: 'Restore original 14x7 BG2 screen-map entries before separately invoking GFL_BGSysFreeCharMemory(2,964,1920) and GFL_BitmapFree(bitmap) while same field and DTCM context remain valid.',
                note: 'READ ONLY: does not restore, free, clear or otherwise modify the visible AB window. Vram map comparison is advisory until validated against the screenshot.',
              })
              // PRK44 runs only when both original 98-entry maps agree,
              // the full AB overlay matches, and the actor/BG2 identity
              // is still the same. This is NOT resource deallocation.
              if (prk40VisualComplete) {
                const roundTripVerified = await tryPrk44ReversibleMapRoundTrip(
                  prk43Before, after, playerActor, directPixels, bg2, directCharPos,
                )
                if (roundTripVerified && ownedBitmapValid) {
                  const bitmapLifetimeVerified = await tryPrk45DisposableBitmapLifetime(
                    playerActor, bg2, directCharPos, directBitmap, directPixels,
                    heapId, prk43Before.bgSys,
                  )
                  if (bitmapLifetimeVerified) {
                    const charLifetimeVerified = await tryPrk46DisposableBg2CharLifetime(
                      playerActor, prk43Before.bgSys, bg2,
                      directCharPos, directBitmap, directPixels,
                    )
                    if (charLifetimeVerified) {
                      // PRK48: isolate visual persistence from PRK47's immediate
                      // one-way teardown. Keep the already-verified native AB
                      // BG2 map/char tiles and owned bitmap live until a fresh
                      // emulator reset. No further guest calls or interaction
                      // attempts are permitted in this research session.
                      const prk48HoldForVisualTest = true
                      if (prk48HoldForVisualTest) {
                        const heldMap = await inspectBg2MapReadOnly()
                        const expectedHeldMap = prk43ExpectedMapForWindow(directCharPos)
                        const matchingEntries = heldMap.vramMap
                          ? heldMap.vramMap.reduce(
                              (n, value, i) => n + (value === expectedHeldMap[i] ? 1 : 0), 0,
                            )
                          : 0
                        console.info('[PokéRun interaction] PRK48 AB OVERLAY VISUAL HOLD READY', {
                          bitmap: hex(directBitmap),
                          bg: bg2,
                          charPos: directCharPos,
                          expectedEntries: expectedHeldMap.length,
                          matchingEntries,
                          heldVramHash: prk43SnapshotHash(heldMap.vramMap),
                          expectedVramHash: prk43SnapshotHash(expectedHeldMap),
                          nativeResourcesFreed: false,
                          furtherXBlocked: Boolean(stateRef.current),
                          note: 'BG2 overlay will remain mapped for visual inspection; PRK47 deliberately NOT called. Do not change maps or press X again. Reset the emulator after the screenshot to release the test allocation.',
                        })
                        // PRK49: PRK42 has already proven a complete variable-width
                        // line from the same ROM. Only the live AB pixels are now
                        // replaced; all BG2 screen-map entries remain untouched.
                        // Every upload is exactly one 32-byte CPU-path char tile.
                        if (romBytes && prk49FontLayout &&
                            matchingEntries === expectedHeldMap.length &&
                            heldMap.vramMap !== null) {
                          let tilesPrepared = 0
                          let tilesUploaded = 0
                          let totalInstructions = 0
                          try {
                            const { memberStart, memberLength, glyphsOffset } = prk49FontLayout
                            const existing = simulateWhite2AsciiLine(
                              romBytes, memberStart, memberLength, glyphsOffset, 'AB',
                            )
                            const desired = simulateWhite2AsciiLine(
                              romBytes, memberStart, memberLength, glyphsOffset, 'Hello, P2!',
                            )
                            if (existing.outputFnv1a32 !== '0xc1731ff6' ||
                                desired.outputFnv1a32 !== '0xc359a40c' ||
                                desired.penAdvancePx > WINDOW_WIDTH * 8 - 16 ||
                                desired.clippedPixels !== 0 ||
                                desired.overlappingPixels !== 0 ||
                                existing.tiles.length !== 1920 || desired.tiles.length !== 1920 ||
                                stateRef.current?.window !== directBitmap ||
                                runtimeBridge.status !== 'running') {
                              throw new Error('PRK49 offline text, bitmap ownership, or bounds preflight failed.')
                            }
                            const actualBefore = await runtimeBridge.readBytes(directPixels, 1920)
                            const sameAbPixels = actualBefore.length === existing.tiles.length &&
                              actualBefore.every((value, i) => value === existing.tiles[i])
                            const liveActor = await probe.scanHeap()
                            if (!sameAbPixels ||
                                liveActor.playerActor?.address !== playerActor ||
                                liveActor.playerActor?.modelId !== EXPECTED_STABLE_PLAYER_MODEL ||
                                !validNativeStack(await runtimeBridge.getArm9Sp())) {
                              throw new Error('PRK49 live AB bitmap, field actor, or safe native stack changed.')
                            }
                            const tileIndices = Array.from(
                              new Set([...existing.dirtyTileIndices, ...desired.dirtyTileIndices]),
                            ).sort((a, b) => a - b)
                            if (tileIndices.length < 4 || tileIndices.length > 20 ||
                                tileIndices.some(i => i < 0 || i >= 60)) {
                              throw new Error('PRK49 unexpected dirty character tile footprint.')
                            }
                            console.info('[PokéRun interaction] PRK49 LONG TEXT PREFLIGHT PASSED', {
                              from: 'AB', to: 'Hello, P2!', bitmap: hex(directBitmap),
                              tileIndices, bytesToUpload: tileIndices.length * 32,
                              textWidthPx: desired.penAdvancePx,
                              offlineHash: desired.outputFnv1a32,
                              note: 'All 60 live bitmap tiles matched PRK42 AB exactly. No map writes, native text printer, or >4-arg calls.',
                            })
                            // Fully stage and read back the new line in owned
                            // bitmap RAM before any guest VRAM transfer.
                            for (const tileIndex of tileIndices) {
                              const address = directPixels + tileIndex * 32
                              const tile = desired.tiles.slice(tileIndex * 32, (tileIndex + 1) * 32)
                              await runtimeBridge.writeBytes(address, tile)
                              const check = await runtimeBridge.readBytes(address, 32)
                              if (check.length !== 32 ||
                                  check.some((value, i) => value !== tile[i])) {
                                throw new Error('PRK49 RAM readback disagreed at tile ' + tileIndex)
                              }
                              tilesPrepared += 1
                            }
                            const staged = await runtimeBridge.readBytes(directPixels, 1920)
                            if (staged.length !== desired.tiles.length ||
                                staged.some((value, i) => value !== desired.tiles[i])) {
                              throw new Error('PRK49 full bitmap staging differs from verified ROM composition.')
                            }
                            for (const tileIndex of tileIndices) {
                              const call = await atomicCall(
                                GFL_BGSYS_LOAD_CHAR, bg2,
                                directPixels + tileIndex * 32, 32, directCharPos + tileIndex,
                              )
                              tilesUploaded += 1
                              totalInstructions += call.instructions
                            }
                            const finalMap = await inspectBg2MapReadOnly()
                            const mapStillHeld = finalMap.vramMap !== null &&
                              finalMap.vramMap.length === expectedHeldMap.length &&
                              finalMap.vramMap.every((value, i) => value === expectedHeldMap[i])
                            if (!mapStillHeld) {
                              throw new Error('PRK49 BG2 overlay map changed after text upload.')
                            }
                            console.info('[PokéRun interaction] PRK49 HELLO P2 VISIBLE HOLD READY', {
                              text: 'Hello, P2!',
                              textWidthPx: desired.penAdvancePx,
                              textPixelPositionOnScreen: { x: WINDOW_X * 8 + 8, y: WINDOW_Y * 8 + 8 },
                              tileIndices,
                              tilesPrepared, tilesUploaded,
                              bytesTransferred: tilesUploaded * 32,
                              totalInstructions,
                              heldMapEntries: expectedHeldMap.length,
                              heldMapVerified: mapStillHeld,
                              bitmapPixelsHash: desired.outputFnv1a32,
                              furtherXBlocked: Boolean(stateRef.current),
                              nativeResourcesFreed: false,
                              note: 'Long text is in owned native bitmap RAM and BG2 character VRAM, with the 98-entry window map still held. Visually inspect; reset emulator after test. PRK47 was not called.',
                            })
                            // PRK50: do not close in this call stack. Preserve
                            // known-good text on screen until a distinct X
                            // interaction arrives from the user.
                            prk50CloseContextRef.current = {
                              playerActor,
                              baseline: prk43Before,
                              bg: bg2,
                              charPos: directCharPos,
                              bitmap: directBitmap,
                              pixels: directPixels,
                              heapId,
                              fontLayout: prk49FontLayout,
                            }
                            prk53SwapAttemptedRef.current = false
                            prk53TextSwappedRef.current = false
                            prk54ChoiceRef.current = 'yes'
                            prk54NavigationCountRef.current = 0
                            prk54FailedRef.current = false
                            console.info('[PokéRun interaction] PRK54 YES NO PROMPT ARMED', {
                              visibleText: 'Hello, P2!',
                              windowBitmap: hex(directBitmap),
                              charPos: directCharPos,
                              baselineMapHash: prk43SnapshotHash(prk43Before.vramMap),
                              heldMapHash: prk43SnapshotHash(finalMap.vramMap),
                              firstInteractionComplete: true,
                              reopensAllowed: false,
                              note: 'First X opens Hello P2. Second X replaces native window with two-line Yes/No. Up/Down moves native highlighted choice, third X confirms and closes via PRK47.',
                            })
                          } catch (reason) {
                            console.info('[PokéRun interaction] PRK49 LONG TEXT UPLOAD REJECTED', {
                              tilesPrepared, tilesUploaded, totalInstructions,
                              reason: reason instanceof Error ? reason.message : String(reason),
                              note: 'No speculative rollback or retry. After partial tile changes, restart the emulator before any new test. PRK48 map ownership stays allocated.',
                            })
                          }
                        } else {
                          console.info('[PokéRun interaction] PRK49 LONG TEXT SKIPPED', {
                            hasRom: Boolean(romBytes),
                            verifiedFontLayout: Boolean(prk49FontLayout),
                            matchingEntries,
                            expectedEntries: expectedHeldMap.length,
                            note: 'Preserve the PRK48 AB visual rather than guessing font or map ownership.',
                          })
                        }
                      } else {
                        await tryPrk47OneWayNativeWindowClose(
                          playerActor, prk43Before, bg2,
                          directCharPos, directBitmap, directPixels, heapId,
                        )
                      }
                    } else {
                      console.info('[PokéRun interaction] PRK47 REAL WINDOW CLOSE SKIPPED', {
                        reason: 'PRK46 AreaMan disposable allocation/free/reuse tests were not all verified.',
                        note: 'The original AB window remains allocated and visible. No real-window resources were released.',
                      })
                    }
                  } else {
                    console.info('[PokéRun interaction] PRK46 DISPOSABLE CHAR SKIPPED', {
                      reason: 'PRK45 native bitmap destructor test did not fully pass.',
                    })
                  }
                } else {
                  console.info('[PokéRun interaction] PRK45 DISPOSABLE BITMAP SKIPPED', {
                    roundTripVerified,
                    ownedBitmapValid,
                    reason: 'PRK44 restoration/reapplication or live bitmap ownership was not fully verified.',
                  })
                }
              } else {
                console.info('[PokéRun interaction] PRK44 RESTORATION PREFLIGHT SKIPPED', {
                  reason: 'Known-good PRK40 AB visual did not finish successfully.',
                  note: 'No PRK44 BG2 tilemap writes. The earlier rendering failure remains the primary diagnostic.',
                })
              }
            } catch (reason) {
              console.info('[PokéRun interaction] PRK43 BG2 OWNERSHIP AFTER UNAVAILABLE', {
                reason: reason instanceof Error ? reason.message : String(reason),
                note: 'Ownership or teardown stage rejected. If PRK47 began changing the real window, restart before retrying; inspect its phase logs.',
              })
            }
          }
          return
        }

        const allocCall = await atomicCall(GFL_BGSYS_ALLOC_CHAR, bg2, requestedBytes, 1)
        const preflightPos = allocCall.result
        if (preflightPos === AREAMAN_FAIL) {
          console.info('[PokéRun interaction] BG CHAR ALLOC PREFLIGHT FAILED', {
            bg: bg2,
            requestedBytes,
            result: hex(preflightPos),
            instructions: allocCall.instructions,
          })
          emitMenuState(false)
          return
        }
        await atomicCall(GFL_BGSYS_FREE_CHAR_MEMORY, bg2, preflightPos, requestedBytes)

        console.info('[PokéRun interaction] BMPWIN CREATE DYNAMIC CALL', {
          address: hex(BMP_WIN_CREATE_DYNAMIC),
          preflightCharPos: preflightPos,
        })
        console.info('[PokéRun interaction] PRK32 WINDOW CREATE STACK ABI CHECK', {
          address: hex(BMP_WIN_CREATE_DYNAMIC),
          registerArgs: [bg2, WINDOW_X, WINDOW_Y, WINDOW_WIDTH],
          injectedStackArgs: [WINDOW_HEIGHT, MSGBG_PLTT_BG2, 1, 0],
          note: 'Extra arguments now enter a backed-up isolated SP area via the PRK32 melonDS native bridge.',
        })
        const createCall = await atomicCall(
          BMP_WIN_CREATE_DYNAMIC,
          bg2,
          WINDOW_X,
          WINDOW_Y,
          WINDOW_WIDTH,
          WINDOW_HEIGHT,
          MSGBG_PLTT_BG2,
          1,
          0,
        )
        const nativeWindow = createCall.result
        if (!isMainRamPointer(nativeWindow)) {
          throw new Error(`BmpWin_CreateDynamic returned ${hex(nativeWindow)} after successful allocator preflight.`)
        }

        const magicAndMode = await runtimeBridge.read16(nativeWindow + 0x00)
        const nativeBg = await runtimeBridge.read8(nativeWindow + 0x02)
        const charPos = await runtimeBridge.read16(nativeWindow + 0x0a)
        const bitmap = await runtimeBridge.read32(nativeWindow + 0x0c)
        const magic = magicAndMode & 0x7fff
        if (magic !== 0x7fb2 || !isMainRamPointer(bitmap)) {
          throw new Error(`Invalid BmpWin ${hex(nativeWindow)} (magic=${hex(magic)} bitmap=${hex(bitmap)}).`)
        }

        // PRK22: inspect the BmpWin geometry before allowing any bitmap or VRAM writes.
        // CreateDynamic takes height, palette, and fromEnd on the injected ARM9 stack.
        const actualX = await runtimeBridge.read8(nativeWindow + 0x03)
        const actualY = await runtimeBridge.read8(nativeWindow + 0x04)
        const actualSizeX = await runtimeBridge.read8(nativeWindow + 0x05)
        const actualSizeY = await runtimeBridge.read8(nativeWindow + 0x06)
        const actualWidth = await runtimeBridge.read8(nativeWindow + 0x07)
        const actualHeight = await runtimeBridge.read8(nativeWindow + 0x08)
        const actualPalette = await runtimeBridge.read8(nativeWindow + 0x09)
        const bitmapWidthPx = await runtimeBridge.read16(bitmap + 0x04)
        const bitmapHeightPx = await runtimeBridge.read16(bitmap + 0x06)
        const bitmapTileSize = await runtimeBridge.read16(bitmap + 0x08)
        const bitmapStorage = await runtimeBridge.read16(bitmap + 0x0a)
        const actualTiles = actualSizeX * actualSizeY
        const geometryMatches = (
          nativeBg === bg2 &&
          actualX === WINDOW_X && actualY === WINDOW_Y &&
          actualSizeX === WINDOW_WIDTH && actualSizeY === WINDOW_HEIGHT &&
          actualWidth === WINDOW_WIDTH && actualHeight === WINDOW_HEIGHT &&
          actualPalette === MSGBG_PLTT_BG2 &&
          bitmapWidthPx === WINDOW_WIDTH * 8 &&
          bitmapHeightPx === WINDOW_HEIGHT * 8 &&
          bitmapTileSize === bytesPerTile &&
          bitmapStorage === 0
        )
        const charPosMatchesPreflight = charPos === preflightPos
        console.info('[PokéRun interaction] BMPWIN GEOMETRY READOUT', {
          expected: {
            bg: bg2, x: WINDOW_X, y: WINDOW_Y,
            sizeX: WINDOW_WIDTH, sizeY: WINDOW_HEIGHT,
            width: WINDOW_WIDTH, height: WINDOW_HEIGHT,
            palette: MSGBG_PLTT_BG2,
            bitmapWidthPx: WINDOW_WIDTH * 8,
            bitmapHeightPx: WINDOW_HEIGHT * 8,
            bitmapTileSize: bytesPerTile,
            charPos: preflightPos,
            tiles: WINDOW_WIDTH * WINDOW_HEIGHT,
          },
          actual: {
            bg: nativeBg, x: actualX, y: actualY,
            sizeX: actualSizeX, sizeY: actualSizeY,
            width: actualWidth, height: actualHeight,
            palette: actualPalette,
            bitmapWidthPx, bitmapHeightPx, bitmapTileSize, bitmapStorage,
            charPos, tiles: actualTiles, allocatedBytesIf4bpp: actualTiles * 32,
          },
          geometryMatches,
          charPosMatchesPreflight,
          createInstructions: createCall.instructions,
          note: 'If dimensions or allocation position are unexpected, this probe stops before fill/map/VRAM writes.',
        })
        if (!geometryMatches || !charPosMatchesPreflight) {
          // Do not advertise an invalid native window as a successfully drawn menu.
          // Leave allocations untouched; a fresh emulator session is required before retesting unsafe stack-arg creation.
          emitMenuState(false)
          console.info('[PokéRun interaction] BMPWIN GEOMETRY GUARD ABORTED', {
            geometryMatches, charPosMatchesPreflight,
            window: hex(nativeWindow), charPos, preflightCharPos: preflightPos,
            note: 'No bitmap fill, map flush, character upload, screen upload, or frame draw performed.',
          })
          return
        }

        console.info('[PokéRun interaction] PRK32 WINDOW GEOMETRY VERIFIED', {
          window: hex(nativeWindow),
          charPos,
          expectedCharPos: preflightPos,
          x: actualX,
          y: actualY,
          width: actualWidth,
          height: actualHeight,
          palette: actualPalette,
          createInstructions: createCall.instructions,
          note: 'The native BmpWin passed strict geometry and allocation checks before graphics were uploaded.',
        })

        const pixelData = await runtimeBridge.read32(bitmap + 0x00)
        if (!isMainRamPointer(pixelData)) throw new Error(`GFLBitmap pixel data is invalid (${hex(pixelData)}).`)
        const firstWordBefore = await runtimeBridge.read32(pixelData)

        const fillCall = await atomicCall(GFL_BITMAP_FILL, bitmap, MSGBG_COLOR_BG_FILL)
        const firstWordAfter = await runtimeBridge.read32(pixelData)
        if (firstWordAfter !== 0xffffffff) {
          throw new Error(`GFL_BitmapFill left first pixel word ${hex(firstWordAfter)}; expected 0xFFFFFFFF.`)
        }

        console.info('[PokéRun interaction] BITMAP FILL SUCCESS', {
          window: hex(nativeWindow),
          bitmap: hex(bitmap),
          pixelData: hex(pixelData),
          firstWordBefore: hex(firstWordBefore),
          firstWordAfter: hex(firstWordAfter),
          instructions: fillCall.instructions,
        })

        console.info('[PokéRun interaction] BMPWIN FLUSH MAP CALL', {
          address: hex(BMP_WIN_FLUSH_MAP),
          window: hex(nativeWindow),
          bg: nativeBg,
          charPos,
          note: 'This writes tile indices into the BG2 RAM screen buffer only.',
        })
        const flushMapCall = await atomicCall(BMP_WIN_FLUSH_MAP, nativeWindow)
        console.info('[PokéRun interaction] BMPWIN FLUSH MAP SUCCESS', {
          window: hex(nativeWindow),
          charPos,
          instructions: flushMapCall.instructions,
        })

        console.info('[PokéRun interaction] BG CHAR CHUNKED CPU CALL', {
          address: hex(GFL_BGSYS_LOAD_CHAR),
          bg: nativeBg,
          pixelData: hex(pixelData),
          bytesPerCall: bytesPerTile,
          calls: tileCount,
          totalBytes: requestedBytes,
          firstCharPos: charPos,
          lastCharPos: charPos + tileCount - 1,
          dmaThreshold: CHAR_DMA_THRESHOLD,
          note: 'Uploads all sixty tiles one at a time. Each 32-byte GFL_BGSysLoadChar call remains on the MIi_CpuCopy32 path.',
        })

        let totalCharUploadInstructions = 0
        let firstCharUploadInstructions = 0
        let lastCharUploadInstructions = 0
        for (let tile = 0; tile < tileCount; tile += 1) {
          const source = (pixelData + tile * bytesPerTile) >>> 0
          const destCharPos = charPos + tile
          const uploadCall = await atomicCall(GFL_BGSYS_LOAD_CHAR, nativeBg, source, bytesPerTile, destCharPos)
          totalCharUploadInstructions += uploadCall.instructions
          if (tile === 0) firstCharUploadInstructions = uploadCall.instructions
          if (tile === tileCount - 1) lastCharUploadInstructions = uploadCall.instructions
        }

        console.info('[PokéRun interaction] BG CHAR CHUNKED CPU SUCCESS', {
          window: hex(nativeWindow),
          charPos,
          uploadedTiles: tileCount,
          uploadedBytes: requestedBytes,
          firstUploadInstructions: firstCharUploadInstructions,
          lastUploadInstructions: lastCharUploadInstructions,
          totalUploadInstructions: totalCharUploadInstructions,
          note: 'Complete character bitmap is now in BG2 VRAM. Next phase uploads only the five window tilemap rows via the <=28-byte CPU screen path.',
        })

        console.info('[PokéRun interaction] BG SCREEN CHUNKED CPU CALL', {
          address: hex(GFL_BGSYS_LOAD_SCR_CORE),
          bg: nativeBg,
          rows: WINDOW_HEIGHT,
          entriesPerRow: WINDOW_WIDTH,
          bytesPerCall: SCREEN_ROW_BYTES,
          totalBytes: SCREEN_ROW_BYTES * WINDOW_HEIGHT,
          firstEntryOffset: WINDOW_Y * TEXT_BG_WIDTH_TILES + WINDOW_X,
          lastEntryOffset: (WINDOW_Y + WINDOW_HEIGHT - 1) * TEXT_BG_WIDTH_TILES + WINDOW_X,
          dmaThreshold: SCREEN_DMA_THRESHOLD,
          note: 'Synthesizes the same 12x5 text-BG map entries as BmpWin_FlushMap and uploads one 24-byte row at a time through GFL_BGSysLoadScrCore. No frame drawing follows.',
        })

        const scratchBefore = await runtimeBridge.readBytes(pixelData, SCREEN_ROW_BYTES)
        let totalScreenUploadInstructions = 0
        let firstScreenUploadInstructions = 0
        let lastScreenUploadInstructions = 0
        try {
          for (let row = 0; row < WINDOW_HEIGHT; row += 1) {
            const rowData = new Uint8Array(SCREEN_ROW_BYTES)
            for (let col = 0; col < WINDOW_WIDTH; col += 1) {
              const tile = charPos + row * WINDOW_WIDTH + col
              const entry = ((MSGBG_PLTT_BG2 << 12) | tile) & 0xffff
              rowData[col * 2] = entry & 0xff
              rowData[col * 2 + 1] = entry >>> 8
            }
            await runtimeBridge.writeBytes(pixelData, rowData)
            const screenEntryOffset = (WINDOW_Y + row) * TEXT_BG_WIDTH_TILES + WINDOW_X
            const uploadCall = await atomicCall(
              GFL_BGSYS_LOAD_SCR_CORE,
              nativeBg,
              pixelData,
              SCREEN_ROW_BYTES,
              screenEntryOffset,
            )
            totalScreenUploadInstructions += uploadCall.instructions
            if (row === 0) firstScreenUploadInstructions = uploadCall.instructions
            if (row === WINDOW_HEIGHT - 1) lastScreenUploadInstructions = uploadCall.instructions
          }
        } finally {
          await runtimeBridge.writeBytes(pixelData, scratchBefore)
        }

        stateRef.current = { window: nativeWindow }
        emitMenuState(false)
        console.info('[PokéRun interaction] BG SCREEN CHUNKED CPU SUCCESS', {
          window: hex(nativeWindow),
          bitmap: hex(bitmap),
          pixelData: hex(pixelData),
          charPos,
          preflightCharPos: preflightPos,
          characterBytes: requestedBytes,
          screenRows: WINDOW_HEIGHT,
          screenBytesPerCall: SCREEN_ROW_BYTES,
          totalScreenBytes: SCREEN_ROW_BYTES * WINDOW_HEIGHT,
          firstScreenUploadInstructions,
          lastScreenUploadInstructions,
          totalScreenUploadInstructions,
          createInstructions: createCall.instructions,
          fillInstructions: fillCall.instructions,
          flushMapInstructions: flushMapCall.instructions,
          totalCharUploadInstructions,
          note: 'Complete BG2 character bitmap and the 12x5 window tilemap region are now in VRAM without invoking either DMA threshold. BmpWin_DrawFrame has not run.',
        })

        console.info('[PokéRun interaction] BMPWIN FRAME RAM CALL', {
          address: hex(BMP_WIN_DRAW_FRAME),
          window: hex(nativeWindow),
          transfer: WINFRAME_TRANSFER_NONE,
          frameChar: MSGBG_CHAR_FRAME,
          framePalette: MSGBG_PLTT_BG2_FRAME,
          windowX: WINDOW_X,
          windowY: WINDOW_Y,
          windowWidth: WINDOW_WIDTH,
          windowHeight: WINDOW_HEIGHT,
          frameRectX: WINDOW_X - 1,
          frameRectY: WINDOW_Y - 1,
          frameRectWidth: WINDOW_WIDTH + 2,
          frameRectHeight: WINDOW_HEIGHT + 2,
          expectedFrameEntries: 2 * (WINDOW_WIDTH + 2) + 2 * WINDOW_HEIGHT,
          note: 'Tests only RAM-side frame drawing with transfer NONE (2); no GFL_BGSysLoadScr or queued screen transfer follows.',
        })
        const frameCall = await atomicCall(
          BMP_WIN_DRAW_FRAME,
          nativeWindow,
          WINFRAME_TRANSFER_NONE,
          MSGBG_CHAR_FRAME,
          MSGBG_PLTT_BG2_FRAME,
        )
        console.info('[PokéRun interaction] BMPWIN FRAME RAM SUCCESS', {
          window: hex(nativeWindow),
          charPos,
          frameChar: MSGBG_CHAR_FRAME,
          framePalette: MSGBG_PLTT_BG2_FRAME,
          transfer: WINFRAME_TRANSFER_NONE,
          instructions: frameCall.instructions,
          note: 'BmpWin_DrawFrame returned after writing only BG2 RAM frame entries. No frame VRAM transfer has been requested; the border may not yet be visible.',
        })

        // Upload only the border: 2 horizontal 14-tile rows and 10 single-tile side entries.
        // GXi_DmaCopy16 remains on its CPU path for all 28-byte and 2-byte calls.
        const borderSegments: Array<{ name: string; x: number; y: number; tiles: number[] }> = [
          {
            name: 'top',
            x: WINDOW_X - 1,
            y: WINDOW_Y - 1,
            tiles: [MSGBG_CHAR_FRAME, ...Array<number>(WINDOW_WIDTH).fill(MSGBG_CHAR_FRAME + 1), MSGBG_CHAR_FRAME + 2],
          },
          ...Array.from({ length: WINDOW_HEIGHT }, (_, row) => ([
            { name: `left-${row}`, x: WINDOW_X - 1, y: WINDOW_Y + row, tiles: [MSGBG_CHAR_FRAME + 3] },
            { name: `right-${row}`, x: WINDOW_X + WINDOW_WIDTH, y: WINDOW_Y + row, tiles: [MSGBG_CHAR_FRAME + 5] },
          ])).flat(),
          {
            name: 'bottom',
            x: WINDOW_X - 1,
            y: WINDOW_Y + WINDOW_HEIGHT,
            tiles: [MSGBG_CHAR_FRAME + 6, ...Array<number>(WINDOW_WIDTH).fill(MSGBG_CHAR_FRAME + 7), MSGBG_CHAR_FRAME + 8],
          },
        ]
        const frameEntryCount = borderSegments.reduce((sum, segment) => sum + segment.tiles.length, 0)
        const maxFrameBytesPerCall = Math.max(...borderSegments.map(segment => segment.tiles.length * 2))
        if (
          borderSegments.length !== 2 + WINDOW_HEIGHT * 2 ||
          frameEntryCount !== 2 * (WINDOW_WIDTH + 2) + 2 * WINDOW_HEIGHT ||
          maxFrameBytesPerCall !== FRAME_FULL_ROW_BYTES ||
          maxFrameBytesPerCall > SCREEN_DMA_THRESHOLD ||
          borderSegments.some(segment => segment.x < 0 || segment.y < 0 ||
            segment.x + segment.tiles.length > TEXT_BG_WIDTH_TILES || segment.y >= TEXT_BG_WIDTH_TILES)
        ) throw new Error('Frame segment geometry or screen CPU threshold is invalid.')

        console.info('[PokéRun interaction] BMPWIN FRAME CHUNKED CPU CALL', {
          address: hex(GFL_BGSYS_LOAD_SCR_CORE),
          bg: nativeBg,
          calls: borderSegments.length,
          entries: frameEntryCount,
          totalBytes: frameEntryCount * 2,
          maxBytesPerCall: maxFrameBytesPerCall,
          frameChar: MSGBG_CHAR_FRAME,
          framePalette: MSGBG_PLTT_BG2_FRAME,
          dmaThreshold: SCREEN_DMA_THRESHOLD,
          note: 'CPU-only upload of exact native frame entries: two 28-byte top/bottom rows and ten 2-byte side tiles, with no full-screen transfer.',
        })
        const frameScratchBefore = await runtimeBridge.readBytes(pixelData, FRAME_FULL_ROW_BYTES)
        let totalFrameUploadInstructions = 0
        let firstFrameUploadInstructions = 0
        let lastFrameUploadInstructions = 0
        try {
          for (let i = 0; i < borderSegments.length; i += 1) {
            const segment = borderSegments[i]
            const bytes = new Uint8Array(segment.tiles.length * 2)
            for (let j = 0; j < segment.tiles.length; j += 1) {
              const entry = ((MSGBG_PLTT_BG2_FRAME << 12) | segment.tiles[j]) & 0xffff
              bytes[j * 2] = entry & 0xff
              bytes[j * 2 + 1] = entry >>> 8
            }
            await runtimeBridge.writeBytes(pixelData, bytes)
            const offset = segment.y * TEXT_BG_WIDTH_TILES + segment.x
            const call = await atomicCall(GFL_BGSYS_LOAD_SCR_CORE, nativeBg, pixelData, bytes.length, offset)
            totalFrameUploadInstructions += call.instructions
            if (i === 0) firstFrameUploadInstructions = call.instructions
            if (i === borderSegments.length - 1) lastFrameUploadInstructions = call.instructions
          }
        } finally {
          await runtimeBridge.writeBytes(pixelData, frameScratchBefore)
        }
        console.info('[PokéRun interaction] BMPWIN FRAME CHUNKED CPU SUCCESS', {
          window: hex(nativeWindow),
          charPos,
          calls: borderSegments.length,
          entries: frameEntryCount,
          uploadedBytes: frameEntryCount * 2,
          maxBytesPerCall: maxFrameBytesPerCall,
          firstFrameUploadInstructions,
          lastFrameUploadInstructions,
          totalFrameUploadInstructions,
          note: 'The 14x7 border region, including eight frame segment types, has been uploaded to BG2 VRAM without DMA. No text/menu functionality follows.',
        })

        // PRK25: before calling any text renderer, prove the live font pointer is plausible
        // and the game's StrBuf allocation + append + lifetime match the decompiled layout.
        const fieldFont = await runtimeBridge.read32(msgBg + 0x08)
        if (!isMainRamPointer(fieldFont)) {
          throw new Error(`FieldMsgBG font is invalid (${hex(fieldFont)}).`)
        }
        const fontLoadType = await runtimeBridge.read32(fieldFont + 0x00)
        const fontGetGlyph = await runtimeBridge.read32(fieldFont + 0x04)
        console.info('[PokéRun interaction] NATIVE TEXT FONT PREFLIGHT', {
          msgBg: hex(msgBg),
          font: hex(fieldFont),
          loadType: fontLoadType,
          getGlyphAddress: hex(fontGetGlyph),
          note: 'Only reads FieldMsgBG.font at +0x08 and its first two words. No font routine called.',
        })

        console.info('[PokéRun interaction] NATIVE STRBUF PREFLIGHT CALL', {
          createAddress: hex(GFL_STRBUF_CREATE),
          appendAddress: hex(GFL_STRBUF_APPEND),
          freeAddress: hex(GFL_STRBUF_FREE),
          heapId,
          size: 8,
          char: STRBUF_PROBE_CHAR,
          note: 'Allocates a small StrBuf, validates its header, appends the single codepoint U+0041, validates contents, then frees it.',
        })
        const strCreateCall = await atomicCall(GFL_STRBUF_CREATE, 8, heapId)
        const probeStrBuf = strCreateCall.result
        if (!isMainRamPointer(probeStrBuf)) {
          throw new Error(`GFL_StrBufCreate returned ${hex(probeStrBuf)}.`)
        }
        let strAppendInstructions = 0
        let strFreeInstructions = 0
        let strValidationSucceeded = false
        try {
          const magicBefore = await runtimeBridge.read32(probeStrBuf + 0x04)
          const sizeBefore = await runtimeBridge.read16(probeStrBuf + 0x00)
          const lengthBefore = await runtimeBridge.read16(probeStrBuf + 0x02)
          const terminatorBefore = await runtimeBridge.read16(probeStrBuf + 0x08)
          if (magicBefore !== STRBUF_MAGIC || sizeBefore !== 8 || lengthBefore !== 0 || terminatorBefore !== STRBUF_TERMINATOR) {
            throw new Error(`Unexpected native StrBuf header (magic=${hex(magicBefore)} size=${sizeBefore} length=${lengthBefore} terminator=${hex(terminatorBefore)}).`)
          }
          const appendCall = await atomicCall(GFL_STRBUF_APPEND, probeStrBuf, STRBUF_PROBE_CHAR)
          strAppendInstructions = appendCall.instructions
          const magicAfter = await runtimeBridge.read32(probeStrBuf + 0x04)
          const lengthAfter = await runtimeBridge.read16(probeStrBuf + 0x02)
          const characterAfter = await runtimeBridge.read16(probeStrBuf + 0x08)
          const terminatorAfter = await runtimeBridge.read16(probeStrBuf + 0x0a)
          if (magicAfter !== STRBUF_MAGIC || lengthAfter !== 1 || characterAfter !== STRBUF_PROBE_CHAR || terminatorAfter !== STRBUF_TERMINATOR) {
            throw new Error(`Native StrBuf append did not match expected layout (magic=${hex(magicAfter)} length=${lengthAfter} char=${hex(characterAfter)} terminator=${hex(terminatorAfter)}).`)
          }
          strValidationSucceeded = true
          console.info('[PokéRun interaction] NATIVE STRBUF CONTENTS VERIFIED', {
            strBuf: hex(probeStrBuf),
            size: sizeBefore,
            length: lengthAfter,
            magic: hex(magicAfter),
            char: hex(characterAfter),
            terminator: hex(terminatorAfter),
            createInstructions: strCreateCall.instructions,
            appendInstructions: strAppendInstructions,
          })

          // PRK27: isolate the font's cached map/width lookup from streamed glyph I/O.
          // GFL_FontGetCharWidth only reads Font.maps and Font.widths in RAM.
          // Do not call the glyph renderer or GFL_FontGetGlyphStreamed here.
          console.info('[PokéRun interaction] NATIVE FONT WIDTH CALL', {
            address: hex(GFL_FONT_GET_CHAR_WIDTH),
            font: hex(fieldFont),
            fontLoadType,
            getGlyphAddress: hex(fontGetGlyph),
            char: STRBUF_PROBE_CHAR,
            note: 'Read-only font character-width query. No streamed glyph ROM read, bitmap rasterization, or VRAM upload.',
          })
          const widthCall = await atomicCall(GFL_FONT_GET_CHAR_WIDTH, fieldFont, STRBUF_PROBE_CHAR)
          const charWidth = widthCall.result
          console.info('[PokéRun interaction] NATIVE FONT WIDTH RESULT', {
            font: hex(fieldFont),
            char: STRBUF_PROBE_CHAR,
            width: charWidth,
            instructions: widthCall.instructions,
            note: 'Font map and width-table lookup returned. This does not test streamed glyph retrieval or bitmap drawing.',
          })
          if (charWidth === 0 || charWidth > 32) {
            throw new Error(`Unexpected character width ${charWidth} for U+0041 on the live font.`)
          }
          console.info('[PokéRun interaction] NATIVE FONT WIDTH SUCCESS', {
            font: hex(fieldFont),
            width: charWidth,
            instructions: widthCall.instructions,
            note: 'Cached font data path works without a streamed FS/CARD read. Next investigation must isolate glyph retrieval before attempting full text rendering.',
          })

          // PRK29: the streamed font uses FS_ReadFile and can switch real Nitro threads.
          // Never invoke GFL_FontGetGlyph or GFL_TextRendererDrawToBitmap from this
          // atomic-call context. Read stable font metadata and in-RAM CMAP only.
          // Offsets follow the decompiled White 2 US Font/FontInfo/FontGlyphInfo layout.
          const fontCopyBitmap = await runtimeBridge.read32(fieldFont + 0x08)
          const cachedGlyphs = await runtimeBridge.read32(fieldFont + 0x0c)
          const archiveHandle = await runtimeBridge.read32(fieldFont + 0x50)
          const fontFileId = await runtimeBridge.read32(fieldFont + 0x54)
          const fontType = await runtimeBridge.read8(fieldFont + 0x58)
          const lineFeed = await runtimeBridge.read8(fieldFont + 0x59)
          const fontInfoGlyphOffset = await runtimeBridge.read32(fieldFont + 0x60)
          const fontInfoWidthOffset = await runtimeBridge.read32(fieldFont + 0x64)
          const fontInfoMapOffset = await runtimeBridge.read32(fieldFont + 0x68)
          const getWidthPointer = await runtimeBridge.read32(fieldFont + 0x6c)
          const unknownGlyphIndex = await runtimeBridge.read16(fieldFont + 0x70)
          const fixedWidth = await runtimeBridge.read8(fieldFont + 0x72)
          const glyphCellWidth = await runtimeBridge.read8(fieldFont + 0x74)
          const glyphCellHeight = await runtimeBridge.read8(fieldFont + 0x75)
          const glyphCellSize = await runtimeBridge.read16(fieldFont + 0x76)
          const glyphBpp = await runtimeBridge.read8(fieldFont + 0x7a)
          const tilesWide = await runtimeBridge.read8(fieldFont + 0x7e)
          const tilesHigh = await runtimeBridge.read8(fieldFont + 0x7f)
          const fontFileOffset = await runtimeBridge.read32(fieldFont + 0x80)
          const fontWidths = await runtimeBridge.read32(fieldFont + 0x84)
          const fontMaps = await runtimeBridge.read32(fieldFont + 0x88)
          const fontGlyphsOffset = await runtimeBridge.read32(fieldFont + 0x8c)
          const fontCell = await runtimeBridge.read32(fieldFont + 0x90)
          const fontMetadataValid = (
            fontLoadType === 0 && cachedGlyphs === 0 &&
            isMainRamPointer(archiveHandle) &&
            isMainRamPointer(fontWidths) &&
            isMainRamPointer(fontMaps) &&
            isMainRamPointer(fontCell) &&
            glyphCellSize >= 4 && glyphCellSize <= 512 &&
            glyphCellWidth > 0 && glyphCellWidth <= 16 &&
            glyphCellHeight > 0 && glyphCellHeight <= 16 &&
            tilesWide >= 1 && tilesWide <= 2 &&
            tilesHigh >= 1 && tilesHigh <= 2 &&
            fontInfoGlyphOffset > 0 &&
            fontGlyphsOffset === fontInfoGlyphOffset + 8
          )
          console.info('[PokéRun interaction] NATIVE FONT ARCHIVE METADATA', {
            font: hex(fieldFont),
            loadType: fontLoadType,
            getGlyphPointer: hex(fontGetGlyph),
            copyBitmapPointer: hex(fontCopyBitmap),
            cachedGlyphs: hex(cachedGlyphs),
            archiveHandle: hex(archiveHandle),
            fileId: fontFileId,
            fontType,
            lineFeed,
            getWidthPointer: hex(getWidthPointer),
            unknownGlyphIndex,
            fixedWidth,
            fontInfoGlyphOffset,
            fontInfoWidthOffset,
            fontInfoMapOffset,
            fontFileOffset,
            fontGlyphsOffset,
            widthsPointer: hex(fontWidths),
            mapsPointer: hex(fontMaps),
            glyphCellPointer: hex(fontCell),
            glyphCellWidth,
            glyphCellHeight,
            glyphCellSize,
            glyphBpp,
            tilesWide,
            tilesHigh,
            fontMetadataValid,
            note: 'Read-only White 2 Font metadata. Offsets refer to an already-open font archive file; do not confuse with absolute ROM offsets.',
          })
          if (!fontMetadataValid) {
            throw new Error('Streamed font layout differs from expected White 2 Font layout; refusing unsafe archive-offset assumptions.')
          }

          // Only CMAP header reads; actual index is computed by the game's pure
          // in-memory map lookup, which GFL_FontGetCharWidth already exercised.
          const mapFirstChar = await runtimeBridge.read16(fontMaps + 0x00)
          const mapLastChar = await runtimeBridge.read16(fontMaps + 0x02)
          const mapMethod = await runtimeBridge.read16(fontMaps + 0x04)
          const mapNextFileOffset = await runtimeBridge.read32(fontMaps + 0x08)
          const mapFirstData = await runtimeBridge.read16(fontMaps + 0x0c)
          console.info('[PokéRun interaction] NATIVE FONT CMAP HEADER', {
            mapPointer: hex(fontMaps),
            firstChar: mapFirstChar,
            lastChar: mapLastChar,
            method: mapMethod,
            nextMapFileOffset: mapNextFileOffset,
            firstData: mapFirstData,
            charRequested: STRBUF_PROBE_CHAR,
            note: 'Reads just the first FontMap header. No filesystem operations.',
          })

          console.info('[PokéRun interaction] NATIVE FONT CHAR INDEX CALL', {
            address: hex(GFL_FONT_GET_CHAR_INDEX),
            font: hex(fieldFont),
            char: STRBUF_PROBE_CHAR,
            note: 'GFL_FontGetCharIndex reads font->maps in RAM; never retrieves glyph image bytes.',
          })
          const glyphIndexCall = await atomicCall(GFL_FONT_GET_CHAR_INDEX, fieldFont, STRBUF_PROBE_CHAR)
          const glyphIndex = glyphIndexCall.result
          const glyphWithinFontOffset = fontGlyphsOffset + glyphIndex * glyphCellSize
          const glyphArchiveOffset = fontFileOffset + glyphWithinFontOffset
          if (
            glyphIndex > 65535 ||
            !Number.isSafeInteger(glyphArchiveOffset) ||
            glyphArchiveOffset < fontFileOffset ||
            glyphArchiveOffset > 0x0fffffff
          ) {
            throw new Error(`Unexpected glyph index or archive offset (index=${glyphIndex} fileOffset=${glyphArchiveOffset}).`)
          }
          console.info('[PokéRun interaction] NATIVE FONT ARCHIVE OFFSET SUCCESS', {
            font: hex(fieldFont),
            char: STRBUF_PROBE_CHAR,
            width: charWidth,
            glyphIndex,
            glyphCellSize,
            glyphWithinFontOffset,
            glyphArchiveOffset,
            archiveHandle: hex(archiveHandle),
            fileId: fontFileId,
            instructions: glyphIndexCall.instructions,
            note: 'Native CMAP index + glyph cell position computed without reading any glyph bytes. This is an offset in the open NARC archive file, not an absolute ROM offset.',
          })

          // PRK30: ArcTool starts with FSFile. See Nitro fs.h:
          // +0x00 next; +0x04 prop; +0x08 arc; +0x0c stat; +0x10 argument;
          // +0x14 error; +0x18/+0x1c OSThreadQueue; +0x20 FSFileProperty.
          // FSFileRange begins at +0x20: fileId, top, bottom, position (4 x u32).
          // Access is read-only, and no guest filesystem function is invoked.
          const fsPropPointer = await runtimeBridge.read32(archiveHandle + 0x04)
          const fsArchivePointer = await runtimeBridge.read32(archiveHandle + 0x08)
          const fsFileStat = await runtimeBridge.read32(archiveHandle + 0x0c)
          const fsFileError = await runtimeBridge.read32(archiveHandle + 0x14)
          const fsRomFileId = await runtimeBridge.read32(archiveHandle + 0x20)
          const fsFileTop = await runtimeBridge.read32(archiveHandle + 0x24)
          const fsFileBottom = await runtimeBridge.read32(archiveHandle + 0x28)
          const fsFilePosition = await runtimeBridge.read32(archiveHandle + 0x2c)
          const archiveFileBytes = fsFileBottom - fsFileTop
          const glyphAbsoluteRomOffset = fsFileTop + glyphArchiveOffset
          const fileRangeValid = (
            fsPropPointer === (archiveHandle + 0x20) &&
            isMainRamPointer(fsArchivePointer) &&
            (fsFileStat & 0x10) !== 0 &&
            fsFileTop > 0 &&
            fsFileBottom > fsFileTop &&
            fsFileBottom <= 0x20000000 &&
            archiveFileBytes >= fontFileOffset + fontInfoMapOffset &&
            glyphArchiveOffset >= 0 &&
            glyphArchiveOffset + glyphCellSize <= archiveFileBytes &&
            fsFilePosition >= fsFileTop &&
            fsFilePosition <= fsFileBottom &&
            glyphAbsoluteRomOffset + glyphCellSize <= fsFileBottom
          )
          console.info('[PokéRun interaction] NATIVE FONT FSFILE RANGE', {
            arcTool: hex(archiveHandle),
            fsFileProperty: hex(fsPropPointer),
            expectedProperty: hex(archiveHandle + 0x20),
            fsArchive: hex(fsArchivePointer),
            fsStat: hex(fsFileStat),
            fsError: fsFileError,
            rootRomFileId: fsRomFileId,
            romFileStart: hex(fsFileTop),
            romFileEnd: hex(fsFileBottom),
            romFileBytes: archiveFileBytes,
            currentPosition: hex(fsFilePosition),
            fileRangeValid,
            note: 'Nitro FSFile metadata is read from emulator RAM. Top/bottom are candidate absolute offsets in ROM cartridge storage; no ROM bytes are fetched.',
          })
          if (!fileRangeValid) {
            throw new Error('Live font FSFile metadata did not validate; do not treat the calculated glyph address as an absolute ROM address.')
          }
          console.info('[PokéRun interaction] NATIVE FONT ROM OFFSET SUCCESS', {
            font: hex(fieldFont),
            archiveHandle: hex(archiveHandle),
            rootRomFileId: fsRomFileId,
            archiveFileStart: hex(fsFileTop),
            archiveFileBytes,
            narcMemberFileId: fontFileId,
            glyphIndex,
            glyphCellBytes: glyphCellSize,
            glyphWithinFontOffset,
            glyphWithinNarcOffset: glyphArchiveOffset,
            candidateAbsoluteRomOffset: hex(glyphAbsoluteRomOffset),
            candidateAbsoluteRomEnd: hex(glyphAbsoluteRomOffset + glyphCellSize),
            note: 'Computed location from live Nitro FSFile range + validated NARC/font offset. Must still cross-check the DS ROM FAT and glyph bytes before accepting as a proven absolute ROM offset.',
          })
        } finally {
          const freeCall = await atomicCall(GFL_STRBUF_FREE, probeStrBuf)
          strFreeInstructions = freeCall.instructions
        }
        console.info('[PokéRun interaction] NATIVE STRBUF PREFLIGHT SUCCESS', {
          window: hex(nativeWindow),
          font: hex(fieldFont),
          strBuf: hex(probeStrBuf),
          strValidationSucceeded,
          createInstructions: strCreateCall.instructions,
          appendInstructions: strAppendInstructions,
          freeInstructions: strFreeInstructions,
          note: 'Native StrBuf and font lookup completed; read-only ArcTool FSFile bounds inspected. No ROM bytes fetched, native FS reads, or new VRAM uploads.',
        })


      } catch (reason) {
        console.info('[PokéRun interaction] BG2 SAFE-STACK FONT ROM PROBE FAILED', {
          reason: reason instanceof Error ? reason.message : String(reason),
        })
        emitMenuState(false)
      } finally {
        openingRef.current = false
      }
    }

    async function tryPrk50SecondXClose() {
      if (openingRef.current || prk50CloseAttemptedRef.current ||
          !prk53TextSwappedRef.current ||
          !prk50CloseContextRef.current || runtimeBridge.status !== 'running' ||
          prk51VerifiedClosesRef.current >= PRK53_MAX_VERIFIED_CLOSES) {
        console.info('[PokéRun interaction] PRK50 SECOND X CLOSE HELD', {
          opening: openingRef.current,
          closeAttempted: prk50CloseAttemptedRef.current,
          contextAvailable: Boolean(prk50CloseContextRef.current),
          bridgeStatus: runtimeBridge.status,
        })
        return
      }
      const owned = prk50CloseContextRef.current
      const lifetime = prk51VerifiedClosesRef.current + 1
      const isReopenedLifetime = prk51ReopenVerifiedRef.current
      // A single one-way attempt per guest session, including preflight
      // rejection: never retry after a partial native graphics operation.
      prk50CloseAttemptedRef.current = true
      prk50CloseContextRef.current = null
      openingRef.current = true
      console.info(lifetime > 2
        ? '[PokéRun interaction] PRK52 LIFETIME CLOSE REQUESTED'
        : isReopenedLifetime
          ? '[PokéRun interaction] PRK51 SECOND LIFETIME CLOSE REQUESTED'
          : '[PokéRun interaction] PRK53 THIRD X CLOSE REQUESTED', {
        lifetime,
        maximumLifetimes: PRK53_MAX_VERIFIED_CLOSES,
        bitmap: hex(owned.bitmap),
        bg: owned.bg,
        charPos: owned.charPos,
        baselineMapHash: prk43SnapshotHash(owned.baseline.vramMap),
        note: 'User-triggered close after visual hold. No reopen or speculative retry; PRK47 validates field, VRAM map, allocator, bitmap ownership, and safe DTCM stack again.',
      })
      try {
        const closed = await tryPrk47OneWayNativeWindowClose(
          owned.playerActor, owned.baseline, owned.bg,
          owned.charPos, owned.bitmap, owned.pixels, owned.heapId,
        )
        if (closed) {
          prk51VerifiedClosesRef.current += 1
          const completed = prk51VerifiedClosesRef.current
          // Keep no stale bitmap or pixel pointers. The only possible
          // reusable data is the immutable BG2 baseline and same AreaMan.
          // This read occurs only AFTER PRK47 confirms both frees.
          if (completed < PRK53_MAX_VERIFIED_CLOSES) {
            const areaMan = await runtimeBridge.read32(
              owned.baseline.bgSys + PRK46_BGSYS_MAIN_AREA_PTR_OFFSET,
            )
            prk51ClosedBaselineRef.current = {
              playerActor: owned.playerActor,
              baseline: owned.baseline,
              areaMan,
            }
            // The last reopen (if any) has finished its successful close,
            // so X may initiate ONE new guarded reopen. Failed reopen
            // attempts never reach this point and never reset this flag.
            prk51ReopenAttemptedRef.current = false
          } else {
            prk51ClosedBaselineRef.current = null
          }
          console.info(completed > 2
            ? '[PokéRun interaction] PRK52 LIFETIME CLOSE VERIFIED'
            : isReopenedLifetime
              ? '[PokéRun interaction] PRK51 SECOND LIFETIME CLOSE VERIFIED'
              : '[PokéRun interaction] PRK53 THIRD X CLOSE VERIFIED', {
            resourcesReleased: true,
            mapRestored: true,
            verifiedCloses: completed,
            maximumLifetimes: PRK53_MAX_VERIFIED_CLOSES,
            nextReopenAvailable: completed < PRK53_MAX_VERIFIED_CLOSES &&
              prk51ClosedBaselineRef.current !== null,
            furtherInteractionLocked: metadataCompleteRef.current,
            note: completed === PRK53_MAX_VERIFIED_CLOSES
              ? 'PRK54 Yes/No window freed after selection; all further X blocked until restart.'
              : 'Native resources freed and original BG2 map restored. Next X may initiate exactly one guarded reopen, with a fresh field and AreaMan preflight.',
          })
          if (completed === PRK53_MAX_VERIFIED_CLOSES) {
            console.info('[PokéRun interaction] PRK54 YES NO SELECTION AND CLOSE VERIFIED', {
              initialText: 'Hello, P2!',
              question: 'Trade with me?',
              selectedChoice: prk54ChoiceRef.current,
              navigationCount: prk54NavigationCountRef.current,
              nativeChoiceRendered: prk53TextSwappedRef.current,
              verifiedOpens: completed,
              verifiedCloses: completed,
              allMapsRestored: true,
              charAndBitmapReleased: true,
              furtherXBlocked: true,
              gameTradeInitiated: false,
              note: 'One actual ROM-font Yes/No menu, keyboard selection and verified PRK47 native cleanup. No networking/game action in this isolation test.',
            })
          }
        } else {
          console.info('[PokéRun interaction] PRK50 SECOND X CLOSE REJECTED', {
            resourcesReleased: 'see PRK47 phase logs',
            reopenAllowed: false,
            note: 'A PRK47 guard rejected cleanup. Do not retry in this guest; preserve the logs and restart before testing again.',
          })
        }
      } catch (reason) {
        console.info('[PokéRun interaction] PRK50 SECOND X CLOSE FAILED', {
          reason: reason instanceof Error ? reason.message : String(reason),
          note: 'No retry in this emulated session. If cleanup was partial, restart before another test.',
        })
      } finally {
        openingRef.current = false
      }
    }

    async function tryPrk51SingleReopen() {
      if (openingRef.current || prk51ReopenAttemptedRef.current ||
          prk51VerifiedClosesRef.current < 1 ||
          prk51VerifiedClosesRef.current >= PRK53_MAX_VERIFIED_CLOSES ||
          !prk51ClosedBaselineRef.current ||
          !prk50CloseAttemptedRef.current ||
          prk50CloseContextRef.current !== null ||
          stateRef.current !== null ||
          !metadataCompleteRef.current ||
          runtimeBridge.status !== 'running') {
        console.info('[PokéRun interaction] PRK51 REOPEN HELD', {
          opening: openingRef.current,
          reopenAttempted: prk51ReopenAttemptedRef.current,
          verifiedCloses: prk51VerifiedClosesRef.current,
          closeAttempted: prk50CloseAttemptedRef.current,
          nativeWindowPresent: stateRef.current !== null,
          note: 'No reopen unless the previous lifetime fully freed, the 5-cycle cap is not reached, and the original field is still valid.',
        })
        return
      }
      // Even a failed preflight burns this one attempt. Never repeat a
      // partial or uncertain operation against live guest allocations.
      prk51ReopenAttemptedRef.current = true
      openingRef.current = true
      const closed = prk51ClosedBaselineRef.current
      const { baseline, playerActor, areaMan } = closed
      try {
        const observed = await inspectBg2MapReadOnly()
        const currentActor = await probe.scanHeap()
        const currentAreaMan = await runtimeBridge.read32(
          baseline.bgSys + PRK46_BGSYS_MAIN_AREA_PTR_OFFSET,
        )
        const charBase = await runtimeBridge.read32(
          baseline.bgSys + PRK46_BGSYS_BG2_CHAR_BASE_OFFSET,
        )
        const charSize = await runtimeBridge.read32(
          baseline.bgSys + PRK46_BGSYS_BG2_CHAR_SIZE_OFFSET,
        )
        const sameBaseline = !disposed &&
          runtimeBridge.status === 'running' &&
          observed.bgSys === baseline.bgSys &&
          observed.screenPtr === baseline.screenPtr &&
          observed.screenSize === baseline.screenSize &&
          observed.screenOffset === baseline.screenOffset &&
          observed.screenBase === baseline.screenBase &&
          observed.controlScreenBase === baseline.controlScreenBase &&
          observed.mode === baseline.mode &&
          observed.colorMode === baseline.colorMode &&
          observed.tileSize === baseline.tileSize &&
          currentAreaMan === areaMan &&
          charBase === 65536 && charSize === 32768 &&
          baseline.vramMap !== null && baseline.vramMap.length === 98 &&
          baseline.ramMap !== null && baseline.ramMap.length === 98 &&
          observed.vramMap !== null && observed.vramMap.length === 98 &&
          observed.ramMap !== null && observed.ramMap.length === 98 &&
          observed.vramMap.every((value, i) => value === baseline.vramMap![i]) &&
          observed.ramMap.every((value, i) => value === baseline.ramMap![i]) &&
          currentActor.playerActor?.address === playerActor &&
          currentActor.playerActor.modelId === EXPECTED_STABLE_PLAYER_MODEL &&
          stateRef.current === null && prk50CloseContextRef.current === null &&
          metadataCompleteRef.current && prk50CloseAttemptedRef.current
        if (!sameBaseline || !(await waitForActiveNativeStack())) {
          console.info('[PokéRun interaction] PRK51 REOPEN PREFLIGHT REJECTED', {
            sameBaseline, currentAreaMan: hex(currentAreaMan),
            expectedAreaMan: hex(areaMan),
            currentActor: hex(currentActor.playerActor?.address ?? 0),
            expectedActor: hex(playerActor),
            currentMapHash: prk43SnapshotHash(observed.vramMap),
            expectedMapHash: prk43SnapshotHash(baseline.vramMap),
            note: 'No native allocation was attempted. One-shot reopen stays locked; restart emulator to try again.',
          })
          return
        }
        console.info(prk51VerifiedClosesRef.current === 1
          ? '[PokéRun interaction] PRK51 REOPEN PREFLIGHT PASSED'
          : '[PokéRun interaction] PRK52 REOPEN PREFLIGHT PASSED', {
          nextLifetime: prk51VerifiedClosesRef.current + 1,
          maximumLifetimes: PRK53_MAX_VERIFIED_CLOSES,
          originalMapHash: prk43SnapshotHash(observed.vramMap),
          actor: hex(playerActor),
          bgSys: hex(baseline.bgSys),
          areaMan: hex(areaMan),
          verifiedCloses: prk51VerifiedClosesRef.current,
          note: 'Previous lifetime freed, original 98-entry map unchanged, same field and AreaMan; exactly one new PRK34-49 creation pass is permitted.',
        })
        // Drop the locked one-way PRK47 state ONLY after the independently
        // verified original-field baseline. The normal runProbe guards and
        // allocation verification execute from scratch.
        metadataCompleteRef.current = false
        prk50CloseAttemptedRef.current = false
        prk51ClosedBaselineRef.current = null
        openingRef.current = false
        await runProbe()
        const newWindow = prk50CloseContextRef.current
        const reopened = newWindow !== null &&
          stateRef.current?.window === newWindow.bitmap &&
          newWindow.playerActor === playerActor &&
          newWindow.baseline.bgSys === baseline.bgSys
        if (!reopened) {
          // Creation may have partially allocated even if it did not finish.
          // Never retry or invoke guessed teardown in this session.
          metadataCompleteRef.current = true
          prk50CloseAttemptedRef.current = true
          console.info('[PokéRun interaction] PRK51 REOPEN INCOMPLETE - LOCKED', {
            stateWindow: stateRef.current ? hex(stateRef.current.window) : null,
            closeContextArmed: Boolean(newWindow),
            note: 'No second attempt or speculative native cleanup. Restart emulator and preserve diagnostics.',
          })
          return
        }
        prk51ReopenVerifiedRef.current = true
        console.info(prk51VerifiedClosesRef.current === 1
          ? '[PokéRun interaction] PRK51 SECOND WINDOW VISIBLE HOLD READY'
          : '[PokéRun interaction] PRK52 WINDOW REOPENED AND HELD', {
          lifetime: prk51VerifiedClosesRef.current + 1,
          maximumLifetimes: PRK53_MAX_VERIFIED_CLOSES,
          bitmap: hex(newWindow.bitmap),
          charPos: newWindow.charPos,
          text: 'Hello, P2!',
          closeArmed: true,
          note: 'New native resources verified and held; next distinct X closes using PRK47. Pointer reuse by the native allocator is permitted.',
        })
      } catch (reason) {
        metadataCompleteRef.current = true
        prk50CloseAttemptedRef.current = true
        console.info('[PokéRun interaction] PRK51 REOPEN FAILED - LOCKED', {
          reason: reason instanceof Error ? reason.message : String(reason),
          note: 'No retry or speculative native calls in this guest; restart emulator.',
        })
      } finally {
        openingRef.current = false
      }
    }

    async function tryPrk54UpdateNativeMenu(
      nextChoice: 'yes' | 'no', firstDisplay: boolean,
    ) {
      const owned = prk50CloseContextRef.current
      const browserRom = romBytes
      if (openingRef.current || prk54FailedRef.current ||
          prk50CloseAttemptedRef.current || prk51VerifiedClosesRef.current !== 0 ||
          !owned || !browserRom || runtimeBridge.status !== 'running' ||
          (firstDisplay && prk53SwapAttemptedRef.current) ||
          (!firstDisplay && (!prk53TextSwappedRef.current ||
            prk54NavigationCountRef.current >= PRK54_MAX_NAVIGATIONS ||
            prk54ChoiceRef.current === nextChoice))) {
        console.info('[PokéRun interaction] PRK54 MENU UPDATE HELD', {
          firstDisplay, nextChoice, currentChoice: prk54ChoiceRef.current,
          activeNativeWindow: Boolean(owned), opening: openingRef.current,
          failed: prk54FailedRef.current,
          menuActive: prk53TextSwappedRef.current,
          navigations: prk54NavigationCountRef.current,
          bridgeStatus: runtimeBridge.status,
        })
        return
      }
      // Once any update starts, do not retry after an ambiguous failure.
      if (firstDisplay) {
        prk53SwapAttemptedRef.current = true
      } else {
        prk54NavigationCountRef.current += 1
      }
      openingRef.current = true
      let tilesPrepared = 0
      let tilesUploaded = 0
      let instructions = 0
      try {
        const { memberStart, memberLength, glyphsOffset } = owned.fontLayout
        const hello = simulateWhite2AsciiLine(
          browserRom, memberStart, memberLength, glyphsOffset, 'Hello, P2!',
        )
        const original = firstDisplay ? {
          tiles: hello.tiles, hash: hello.outputFnv1a32,
        } : composePrk54YesNoMenu(
          browserRom, owned.fontLayout, prk54ChoiceRef.current,
        )
        const target = composePrk54YesNoMenu(
          browserRom, owned.fontLayout, nextChoice,
        )
        const sourceKnown = hello.outputFnv1a32 === '0xc359a40c'
        const byteGeometry = original.tiles.length === 1920 &&
          target.tiles.length === 1920
        const stillOpenAndOwned = !metadataCompleteRef.current &&
          stateRef.current?.window === owned.bitmap &&
          isMainRamPointer(owned.bitmap) && isMainRamPointer(owned.pixels)
        if (!sourceKnown || !byteGeometry || !stillOpenAndOwned) {
          console.info('[PokéRun interaction] PRK54 MENU PREWRITE VALIDATION DETAILS', {
            sourceKnown, expectedHelloHash: '0xc359a40c',
            actualHelloHash: hello.outputFnv1a32,
            byteGeometry, sourceBytes: original.tiles.length,
            targetBytes: target.tiles.length,
            stillOpenAndOwned, metadataComplete: metadataCompleteRef.current,
            bitmap: hex(owned.bitmap), pixelBuffer: hex(owned.pixels),
            nativeWindow: stateRef.current ? hex(stateRef.current.window) : null,
          })
          throw new Error('PRK54 ROM font, bitmap ownership or open-lifetime validation failed.')
        }
        const observed = await inspectBg2MapReadOnly()
        const expectedMap = prk43ExpectedMapForWindow(owned.charPos)
        const actor = await probe.scanHeap()
        const ownedMapUnchanged = observed.bgSys === owned.baseline.bgSys &&
          observed.screenPtr === owned.baseline.screenPtr &&
          observed.vramMap !== null &&
          observed.vramMap.length === expectedMap.length &&
          observed.vramMap.every((tile, i) => tile === expectedMap[i]) &&
          observed.ramMap !== null && owned.baseline.ramMap !== null &&
          observed.ramMap.length === owned.baseline.ramMap.length &&
          observed.ramMap.every((tile, i) => tile === owned.baseline.ramMap![i])
        if (!ownedMapUnchanged ||
            actor.playerActor?.address !== owned.playerActor ||
            actor.playerActor?.modelId !== EXPECTED_STABLE_PLAYER_MODEL ||
            !(await waitForActiveNativeStack()) ||
            runtimeBridge.status !== 'running' || disposed) {
          throw new Error('PRK54 field actor, BG2 map/shadow or safe DTCM stack changed.')
        }
        const current = await runtimeBridge.readBytes(owned.pixels, 1920)
        if (current.length !== 1920 ||
            current.some((byte, i) => byte !== original.tiles[i])) {
          throw new Error('PRK54 held native GFLBitmap is not identical to expected previous menu.')
        }
        const dirtyTiles: number[] = []
        for (let tile = 0; tile < 60; tile++) {
          for (let byte = 0; byte < 32; byte++) {
            const offset = tile * 32 + byte
            if (original.tiles[offset] !== target.tiles[offset]) {
              dirtyTiles.push(tile)
              break
            }
          }
        }
        if (dirtyTiles.length === 0 || dirtyTiles.length > 48 ||
            dirtyTiles.some(tile => tile < 0 || tile >= 60)) {
          throw new Error('PRK54 dirty tile footprint invalid.')
        }
        console.info(firstDisplay
          ? '[PokéRun interaction] PRK54 TWO-LINE YES NO PREFLIGHT PASSED'
          : '[PokéRun interaction] PRK54 SELECTION MOVE PREFLIGHT PASSED', {
          from: firstDisplay ? 'Hello, P2!' : prk54ChoiceRef.current,
          to: nextChoice,
          targetChoicesLine: target.choicesText,
          questionWidthPx: target.questionWidthPx,
          choicesWidthPx: target.choicesWidthPx,
          sameBitmap: hex(owned.bitmap),
          charPos: owned.charPos,
          sourceHash: original.hash,
          targetHash: target.hash,
          dirtyTiles,
          bytesToUpload: dirtyTiles.length * 32,
          backgroundMapUnchanged: ownedMapUnchanged,
          note: 'No new allocations; no native menu calls; existing ROM-font bitmap and map verified before first write.',
        })
        for (const tile of dirtyTiles) {
          const addr = owned.pixels + tile * 32
          const desired = target.tiles.slice(tile * 32, (tile + 1) * 32)
          await runtimeBridge.writeBytes(addr, desired)
          const roundtrip = await runtimeBridge.readBytes(addr, 32)
          if (roundtrip.length !== 32 ||
              roundtrip.some((byte, i) => byte !== desired[i])) {
            throw new Error('PRK54 32-byte owned RAM tile readback failed: ' + tile)
          }
          tilesPrepared += 1
        }
        const staged = await runtimeBridge.readBytes(owned.pixels, 1920)
        if (staged.length !== 1920 ||
            staged.some((byte, i) => byte !== target.tiles[i])) {
          throw new Error('PRK54 full 1920-byte RAM bitmap readback failed.')
        }
        for (const tile of dirtyTiles) {
          const call = await atomicCall(
            GFL_BGSYS_LOAD_CHAR, owned.bg,
            owned.pixels + tile * 32, 32, owned.charPos + tile,
          )
          tilesUploaded += 1
          instructions += call.instructions
        }
        const resultMap = await inspectBg2MapReadOnly()
        const sameOverlay = resultMap.bgSys === owned.baseline.bgSys &&
          resultMap.vramMap !== null &&
          resultMap.vramMap.length === expectedMap.length &&
          resultMap.vramMap.every((value, i) => value === expectedMap[i])
        if (!sameOverlay || disposed || runtimeBridge.status !== 'running' ||
            stateRef.current?.window !== owned.bitmap) {
          throw new Error('PRK54 BG2 overlay ownership changed after tile upload.')
        }
        prk54ChoiceRef.current = nextChoice
        if (firstDisplay) prk53TextSwappedRef.current = true
        console.info(firstDisplay
          ? '[PokéRun interaction] PRK54 YES NO WINDOW RENDERED AND HELD'
          : '[PokéRun interaction] PRK54 YES NO SELECTION MOVED', {
          visibleQuestion: 'Trade with me?',
          visibleChoices: target.choicesText,
          selectedChoice: prk54ChoiceRef.current,
          sameBitmap: hex(owned.bitmap),
          samePixelBuffer: hex(owned.pixels),
          noNewAllocations: true,
          tilesPrepared, tilesUploaded,
          bytesTransferred: tilesUploaded * 32,
          nativeInstructions: instructions,
          bitmapHash: target.hash,
          heldBg2MapVerified: sameOverlay,
          navigationCount: prk54NavigationCountRef.current,
          remainingNavigationBudget: PRK54_MAX_NAVIGATIONS -
            prk54NavigationCountRef.current,
          closeOnNextX: true,
          note: 'Physical native BG2 font tiles changed in-place, not a browser overlay. ArrowUp selects Yes, ArrowDown selects No, X confirms and closes.',
        })
      } catch (reason) {
        prk54FailedRef.current = true
        console.info('[PokéRun interaction] PRK54 MENU UPDATE REJECTED - LOCKED', {
          firstDisplay, nextChoice,
          reason: reason instanceof Error ? reason.message : String(reason),
          tilesPrepared, tilesUploaded, instructions,
          note: 'No retry, speculative rollback, or teardown after a failed/partial native update. Restart emulator before another test.',
        })
      } finally {
        openingRef.current = false
      }
    }

    const onMenuNavigationKeydown = (event: KeyboardEvent) => {
      const nextChoice = event.code === 'ArrowUp' || event.code === 'KeyW'
        ? 'yes' : event.code === 'ArrowDown' || event.code === 'KeyS'
          ? 'no' : null
      if (!nextChoice || !prk50CloseContextRef.current ||
          !prk53TextSwappedRef.current ||
          prk50CloseAttemptedRef.current) return
      const element = event.target
      if (element instanceof HTMLElement &&
          element.closest('input, textarea, [contenteditable="true"]')) return
      // Capture before the embedded game sees D-pad directions: navigation
      // must not walk P1 away from the interaction target.
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.repeat || openingRef.current || prk54FailedRef.current ||
          nextChoice === prk54ChoiceRef.current ||
          prk54NavigationCountRef.current >= PRK54_MAX_NAVIGATIONS) return
      void tryPrk54UpdateNativeMenu(nextChoice, false)
    }

    const onInteract = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined
      console.info('[PokéRun interaction] INTERACT EVENT RECEIVED', {
        code: detail?.code ?? null,
        bridgeStatus: runtimeBridge.status,
        probeComplete: Boolean(stateRef.current),
        opening: openingRef.current,
        closeArmed: Boolean(prk50CloseContextRef.current),
        closeAttempted: prk50CloseAttemptedRef.current,
        prk53SwapAttempted: prk53SwapAttemptedRef.current,
        prk53TextSwapped: prk53TextSwappedRef.current,
        prk54SelectedChoice: prk54ChoiceRef.current,
        prk54NavigationCount: prk54NavigationCountRef.current,
        prk54Failed: prk54FailedRef.current,
        prk51VerifiedCloses: prk51VerifiedClosesRef.current,
        prk53MaximumCloses: PRK53_MAX_VERIFIED_CLOSES,
        prk51ReopenAttempted: prk51ReopenAttemptedRef.current,
        prk51ReopenVerified: prk51ReopenVerifiedRef.current,
      })
      if (openingRef.current || prk54FailedRef.current ||
          prk51VerifiedClosesRef.current >= PRK53_MAX_VERIFIED_CLOSES) return
      if (prk50CloseContextRef.current) {
        if (!prk53SwapAttemptedRef.current) {
          void tryPrk54UpdateNativeMenu('yes', true)
        } else if (prk53TextSwappedRef.current) {
          console.info('[PokéRun interaction] PRK54 YES NO CHOICE CONFIRM REQUESTED', {
            choice: prk54ChoiceRef.current,
            navigationCount: prk54NavigationCountRef.current,
            note: 'Keyboard selection recorded. No actual trade begins. PRK47 teardown is still separately validated before reporting success.',
          })
          void tryPrk50SecondXClose()
        } // An attempted but rejected update stays locked until restart.
      } else if (prk50CloseAttemptedRef.current &&
                 prk51VerifiedClosesRef.current >= 1 &&
                 prk51VerifiedClosesRef.current < PRK53_MAX_VERIFIED_CLOSES &&
                 !prk51ReopenAttemptedRef.current) {
        void tryPrk51SingleReopen()
      } else if (!prk50CloseAttemptedRef.current) {
        void runProbe()
      }
    }

    window.addEventListener(WHITE2_INTERACT_EVENT, onInteract)
    window.addEventListener('keydown', onMenuNavigationKeydown, true)
    return () => {
      disposed = true
      window.removeEventListener(WHITE2_INTERACT_EVENT, onInteract)
      window.removeEventListener('keydown', onMenuNavigationKeydown, true)
      emitMenuState(false)
      // React unmount must never call native guest frees, even if an
      // interaction has a pending context. Restart the guest instead.
      prk50CloseContextRef.current = null
      prk50CloseAttemptedRef.current = false
      prk53SwapAttemptedRef.current = false
      prk53TextSwappedRef.current = false
      prk54ChoiceRef.current = 'yes'
      prk54NavigationCountRef.current = 0
      prk54FailedRef.current = false
      prk51VerifiedClosesRef.current = 0
      prk51ReopenAttemptedRef.current = false
      prk51ReopenVerifiedRef.current = false
      prk51ClosedBaselineRef.current = null
      stateRef.current = null
      metadataCompleteRef.current = false
    }
  }, [bridge, rom.gameId, rom.sha256, romBytes])

  return null
}
