import { useEffect, useRef } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import type { MultiplayerRomIdentity } from '../core/protocol'
import { White2ActorSystemProbe } from './White2ActorSystem'
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
const PRK31_ROM_RANGE_ONLY = true
const EXPECTED_STABLE_PLAYER_MODEL = 240
const WHITE2_NATIVE_MENU_STATE_EVENT = 'pokerun:white2-native-menu-state'

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

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= 0x02000000 && value < 0x02400000 && (value & 3) === 0
}

function hex(value: number) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

export function White2NativeYesNoInteractionProbe({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const stateRef = useRef<ProbeState | null>(null)
  const openingRef = useRef(false)
  const metadataCompleteRef = useRef(false)

  useEffect(() => {
    const supported = White2ActorSystemProbe.supportsRom(rom)
    console.info('[PokéRun interaction] FONT ROM RANGE READONLY PROBE EFFECT', {
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
      console.info('[PokéRun interaction] FONT ROM RANGE READONLY PROBE UNAVAILABLE', {
        reason: 'Scheduler-aware stack-argument native-call export is unavailable.',
      })
      return
    }

    const emitMenuState = (open: boolean) => {
      window.dispatchEvent(new CustomEvent(WHITE2_NATIVE_MENU_STATE_EVENT, { detail: { open } }))
    }

    console.info('[PokéRun interaction] FONT ROM RANGE READONLY PROBE MOUNTED', {
      bridgeStatus: runtimeBridge.status,
      rom: rom.gameId,
      createAddress: hex(BMP_WIN_CREATE_DYNAMIC),
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
      mode: 'font-rom-range-only',
      note: 'PRK31 tests ArcTool FSFile metadata only. No BmpWin allocation, bitmap/window drawing, StrBuf, glyph fetching, or guest FS calls. Requires a stable model-240 field actor before any native getter.',
    })

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
      const result = atomicRuntime.callArm9Thumb8Atomic(
        address >>> 0,
        r0 >>> 0,
        r1 >>> 0,
        r2 >>> 0,
        r3 >>> 0,
        a4 >>> 0,
        a5 >>> 0,
        a6 >>> 0,
        a7 >>> 0,
        NATIVE_STACK_RESERVE,
      ) >>> 0
      const status = atomicRuntime.arm9CallStatus() >>> 0
      const pc = atomicRuntime.arm9CallPc() >>> 0
      const lr = atomicRuntime.arm9CallLr() >>> 0
      const cpsr = atomicRuntime.arm9CallCpsr() >>> 0
      const instructions = atomicRuntime.arm9CallInstructions() >>> 0

      if (status !== 1) {
        throw new Error(
          `Atomic native call ${hex(address)} failed with status ${status} at ${hex(pc)}; `
          + `lr=${hex(lr)} cpsr=${hex(cpsr)} instructions=${instructions}.`,
        )
      }
      return { result, instructions }
    }

    async function runProbe() {
      if (openingRef.current || metadataCompleteRef.current || stateRef.current || runtimeBridge.status !== 'running') {
        if (stateRef.current || metadataCompleteRef.current) {
          console.info('[PokéRun interaction] FONT ROM RANGE READONLY PROBE HOLD', { window: stateRef.current ? hex(stateRef.current.window) : null, metadataComplete: metadataCompleteRef.current })
        }
        return
      }
      openingRef.current = true

      try {
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
        console.info('[PokéRun interaction] FONT ROM RANGE READONLY PROBE FAILED', {
          reason: reason instanceof Error ? reason.message : String(reason),
        })
        emitMenuState(false)
      } finally {
        openingRef.current = false
      }
    }

    const onInteract = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined
      console.info('[PokéRun interaction] INTERACT EVENT RECEIVED', {
        code: detail?.code ?? null,
        bridgeStatus: runtimeBridge.status,
        probeComplete: Boolean(stateRef.current),
        opening: openingRef.current,
      })
      void runProbe()
    }

    window.addEventListener(WHITE2_INTERACT_EVENT, onInteract)
    return () => {
      window.removeEventListener(WHITE2_INTERACT_EVENT, onInteract)
      emitMenuState(false)
      // Deliberately leave the one-shot diagnostic BmpWin allocated; a fresh emulator session owns it.
      stateRef.current = null
      metadataCompleteRef.current = false
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
