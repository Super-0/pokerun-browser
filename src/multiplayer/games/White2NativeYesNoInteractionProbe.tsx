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
const GFL_BGSYS_LOAD_SCR = 0x02044fbc
const GFL_BGSYS_LOAD_CHAR = 0x020450ac
const GFL_BGSYS_GET_BG_MODE = 0x0204587c
const GFL_BGSYS_GET_BG_COLOR_PALETTE_MODE = 0x02045890
const GFL_BGSYS_GET_BG_BYTES_PER_TILE = 0x020458a4
const GFL_BITMAP_FILL = 0x02047168
const BMP_WIN_CREATE_DYNAMIC = 0x020480ec
const BMP_WIN_FLUSH_MAP = 0x02048298

const FIELDMAP_CTRL_GRID = 0
const MSGBG_BG2 = 2
const MSGBG_PLTT_BG2 = 14
const MSGBG_COLOR_BG_FILL = 0xff
const WINDOW_WIDTH = 12
const WINDOW_HEIGHT = 5
const WINDOW_X = 18
const WINDOW_Y = 2
const CHAR_DMA_THRESHOLD = 48
const SCREEN_DMA_THRESHOLD = 28
const AREAMAN_FAIL = 0xffffffff
const NATIVE_STACK_RESERVE = 0x800
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

  useEffect(() => {
    const supported = White2ActorSystemProbe.supportsRom(rom)
    console.info('[PokéRun interaction] BG SCREEN DMA PROBE EFFECT', {
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
      console.info('[PokéRun interaction] BG SCREEN DMA PROBE UNAVAILABLE', {
        reason: 'Scheduler-aware stack-argument native-call export is unavailable.',
      })
      return
    }

    const emitMenuState = (open: boolean) => {
      window.dispatchEvent(new CustomEvent(WHITE2_NATIVE_MENU_STATE_EVENT, { detail: { open } }))
    }

    console.info('[PokéRun interaction] BG SCREEN DMA PROBE MOUNTED', {
      bridgeStatus: runtimeBridge.status,
      rom: rom.gameId,
      createAddress: hex(BMP_WIN_CREATE_DYNAMIC),
      fillAddress: hex(GFL_BITMAP_FILL),
      flushMapAddress: hex(BMP_WIN_FLUSH_MAP),
      loadCharAddress: hex(GFL_BGSYS_LOAD_CHAR),
      loadScrAddress: hex(GFL_BGSYS_LOAD_SCR),
      charDmaThreshold: CHAR_DMA_THRESHOLD,
      screenDmaThreshold: SCREEN_DMA_THRESHOLD,
      note: 'PRK20 repeats the proven full 60x32-byte CPU character upload, then isolates GFL_BGSysLoadScr(BG2). GX_LoadBG2Scr uses GXi_DmaCopy16, whose DMA threshold is >28 bytes. No frame draw follows.',
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
      if (openingRef.current || stateRef.current || runtimeBridge.status !== 'running') {
        if (stateRef.current) {
          console.info('[PokéRun interaction] BG SCREEN DMA PROBE HOLD', { window: hex(stateRef.current.window) })
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

        const colorMode = (await atomicCall(GFL_BGSYS_GET_BG_COLOR_PALETTE_MODE, bg2)).result
        const bytesPerTile = (await atomicCall(GFL_BGSYS_GET_BG_BYTES_PER_TILE, bg2)).result
        const bgMode = (await atomicCall(GFL_BGSYS_GET_BG_MODE, bg2)).result
        const tileCount = WINDOW_WIDTH * WINDOW_HEIGHT
        const requestedBytes = tileCount * bytesPerTile
        if (bytesPerTile !== 32 || bytesPerTile > CHAR_DMA_THRESHOLD) {
          throw new Error(`BG2 tile size is ${bytesPerTile} bytes; expected a 32-byte tile below the ${CHAR_DMA_THRESHOLD}-byte character DMA threshold.`)
        }

        console.info('[PokéRun interaction] BG SCREEN DMA FIELD PATH READY', {
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

        let totalUploadInstructions = 0
        let firstUploadInstructions = 0
        let lastUploadInstructions = 0
        for (let tile = 0; tile < tileCount; tile += 1) {
          const source = (pixelData + tile * bytesPerTile) >>> 0
          const destCharPos = charPos + tile
          const uploadCall = await atomicCall(GFL_BGSYS_LOAD_CHAR, nativeBg, source, bytesPerTile, destCharPos)
          totalUploadInstructions += uploadCall.instructions
          if (tile === 0) firstUploadInstructions = uploadCall.instructions
          if (tile === tileCount - 1) lastUploadInstructions = uploadCall.instructions
        }

        console.info('[PokéRun interaction] BG CHAR CHUNKED CPU SUCCESS', {
          window: hex(nativeWindow),
          charPos,
          uploadedTiles: tileCount,
          uploadedBytes: requestedBytes,
          firstUploadInstructions,
          lastUploadInstructions,
          totalUploadInstructions,
          note: 'Complete character bitmap is now in BG2 VRAM. Next call isolates the RAM screen-buffer upload.',
        })

        console.info('[PokéRun interaction] BG SCREEN DMA CALL', {
          address: hex(GFL_BGSYS_LOAD_SCR),
          bg: nativeBg,
          dmaThreshold: SCREEN_DMA_THRESHOLD,
          note: 'GFL_BGSysLoadScr uploads BG2 screen RAM through GX_LoadBG2Scr -> GXi_DmaCopy16. Any normal BG screen buffer is above the >28-byte DMA threshold. No frame drawing follows.',
        })
        const screenUploadCall = await atomicCall(GFL_BGSYS_LOAD_SCR, nativeBg)

        stateRef.current = { window: nativeWindow }
        emitMenuState(false)
        console.info('[PokéRun interaction] BG SCREEN DMA SUCCESS', {
          window: hex(nativeWindow),
          bitmap: hex(bitmap),
          pixelData: hex(pixelData),
          charPos,
          preflightCharPos: preflightPos,
          uploadedTiles: tileCount,
          uploadedBytes: requestedBytes,
          createInstructions: createCall.instructions,
          fillInstructions: fillCall.instructions,
          flushMapInstructions: flushMapCall.instructions,
          totalCharUploadInstructions: totalUploadInstructions,
          screenUploadInstructions: screenUploadCall.instructions,
          note: 'BG2 character and screen VRAM uploads both completed. BmpWin_DrawFrame has not run.',
        })
      } catch (reason) {
        console.info('[PokéRun interaction] BG SCREEN DMA PROBE FAILED', {
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
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
