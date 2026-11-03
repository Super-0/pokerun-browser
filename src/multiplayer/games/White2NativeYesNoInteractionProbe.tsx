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
const GFL_BGSYS_GET_BG_COLOR_PALETTE_MODE = 0x02045890
const GFL_BGSYS_GET_BG_BYTES_PER_TILE = 0x020458a4
const GFL_BITMAP_FILL = 0x02047168
const BMP_WIN_CREATE_DYNAMIC = 0x020480ec

const FIELDMAP_CTRL_GRID = 0
const MSGBG_BG2 = 2
const MSGBG_PLTT_BG2 = 14
const MSGBG_COLOR_BG_FILL = 0xff
const WINDOW_WIDTH = 12
const WINDOW_HEIGHT = 5
const WINDOW_X = 18
const WINDOW_Y = 2
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

type NativeWindowState = {
  window: number
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= 0x02000000 && value < 0x02400000 && (value & 3) === 0
}

function hex(value: number) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

export function White2NativeYesNoInteractionProbe({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const stateRef = useRef<NativeWindowState | null>(null)
  const openingRef = useRef(false)

  useEffect(() => {
    const supported = White2ActorSystemProbe.supportsRom(rom)
    console.info('[PokéRun interaction] BG CHAR PREFLIGHT PROBE EFFECT', {
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
      console.info('[PokéRun interaction] BG CHAR PREFLIGHT PROBE UNAVAILABLE', {
        reason: 'Scheduler-aware stack-argument native-call export is unavailable.',
      })
      return
    }

    const emitMenuState = (open: boolean) => {
      window.dispatchEvent(new CustomEvent(WHITE2_NATIVE_MENU_STATE_EVENT, { detail: { open } }))
    }

    console.info('[PokéRun interaction] BG CHAR PREFLIGHT PROBE MOUNTED', {
      bridgeStatus: runtimeBridge.status,
      rom: rom.gameId,
      allocAddress: hex(GFL_BGSYS_ALLOC_CHAR),
      freeAddress: hex(GFL_BGSYS_FREE_CHAR_MEMORY),
      createAddress: hex(BMP_WIN_CREATE_DYNAMIC),
      fillAddress: hex(GFL_BITMAP_FILL),
      note: 'PRK14 preflights the exact BG2 character allocation, frees it immediately, then retries BmpWin_CreateDynamic and GFL_BitmapFill.',
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
          console.info('[PokéRun interaction] BG CHAR PREFLIGHT PROBE HOLD', {
            window: hex(stateRef.current.window),
          })
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
        if (bg2 !== MSGBG_BG2) {
          throw new Error(`FieldMsgBG bg2 is ${bg2}; expected ${MSGBG_BG2}.`)
        }

        const colorModeCall = await atomicCall(GFL_BGSYS_GET_BG_COLOR_PALETTE_MODE, bg2)
        const bytesPerTileCall = await atomicCall(GFL_BGSYS_GET_BG_BYTES_PER_TILE, bg2)
        const colorMode = colorModeCall.result
        const bytesPerTile = bytesPerTileCall.result
        const requestedBytes = WINDOW_WIDTH * WINDOW_HEIGHT * bytesPerTile

        console.info('[PokéRun interaction] BG CHAR PREFLIGHT FIELD PATH READY', {
          actor: hex(playerActor),
          effects: hex(effects),
          field: hex(field),
          heapId,
          msgBg: hex(msgBg),
          bg,
          bg2,
          paletteBefore,
          colorMode,
          bytesPerTile,
          requestedTiles: WINDOW_WIDTH * WINDOW_HEIGHT,
          requestedBytes,
        })

        console.info('[PokéRun interaction] BG CHAR ALLOC PREFLIGHT CALL', {
          address: hex(GFL_BGSYS_ALLOC_CHAR),
          bg: bg2,
          size: requestedBytes,
          fromEnd: 1,
          note: 'This is the exact character-memory request BmpWin_CreateDynamic should make for this 12x5 BG2 window.',
        })

        const allocCall = await atomicCall(GFL_BGSYS_ALLOC_CHAR, bg2, requestedBytes, 1)
        const preflightPos = allocCall.result
        if (preflightPos === AREAMAN_FAIL) {
          console.info('[PokéRun interaction] BG CHAR ALLOC PREFLIGHT FAILED', {
            bg: bg2,
            requestedBytes,
            bytesPerTile,
            result: hex(preflightPos),
            instructions: allocCall.instructions,
            conclusion: 'BG2 character AreaMan could not find a contiguous run for the native 12x5 window request at this moment.',
          })
          emitMenuState(false)
          return
        }

        console.info('[PokéRun interaction] BG CHAR ALLOC PREFLIGHT SUCCESS', {
          bg: bg2,
          requestedBytes,
          bytesPerTile,
          charPos: preflightPos,
          instructions: allocCall.instructions,
        })

        const freeCall = await atomicCall(GFL_BGSYS_FREE_CHAR_MEMORY, bg2, preflightPos, requestedBytes)
        console.info('[PokéRun interaction] BG CHAR ALLOC PREFLIGHT FREED', {
          bg: bg2,
          charPos: preflightPos,
          requestedBytes,
          instructions: freeCall.instructions,
        })

        console.info('[PokéRun interaction] BMPWIN CREATE DYNAMIC CALL', {
          address: hex(BMP_WIN_CREATE_DYNAMIC),
          args: {
            bg: bg2,
            x: WINDOW_X,
            y: WINDOW_Y,
            width: WINDOW_WIDTH,
            height: WINDOW_HEIGHT,
            palette: MSGBG_PLTT_BG2,
            fromEnd: 1,
          },
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
          throw new Error(
            `BmpWin_CreateDynamic returned ${hex(nativeWindow)} after allocator preflight `
            + `successfully reserved and freed charPos ${preflightPos}.`,
          )
        }

        const magicAndMode = await runtimeBridge.read16(nativeWindow + 0x00)
        const nativeBg = await runtimeBridge.read8(nativeWindow + 0x02)
        const x = await runtimeBridge.read8(nativeWindow + 0x03)
        const y = await runtimeBridge.read8(nativeWindow + 0x04)
        const sizeX = await runtimeBridge.read8(nativeWindow + 0x05)
        const sizeY = await runtimeBridge.read8(nativeWindow + 0x06)
        const width = await runtimeBridge.read8(nativeWindow + 0x07)
        const height = await runtimeBridge.read8(nativeWindow + 0x08)
        const palette = await runtimeBridge.read8(nativeWindow + 0x09)
        const charPos = await runtimeBridge.read16(nativeWindow + 0x0a)
        const bitmap = await runtimeBridge.read32(nativeWindow + 0x0c)
        const magic = magicAndMode & 0x7fff
        const windowColorMode = magicAndMode >>> 15

        if (magic !== 0x7fb2 || !isMainRamPointer(bitmap)) {
          throw new Error(
            `BmpWin_CreateDynamic returned invalid BmpWin ${hex(nativeWindow)} `
            + `(magic=${hex(magic)} bitmap=${hex(bitmap)}).`,
          )
        }

        const pixelData = await runtimeBridge.read32(bitmap + 0x00)
        const bitmapWidth = await runtimeBridge.read16(bitmap + 0x04)
        const bitmapHeight = await runtimeBridge.read16(bitmap + 0x06)
        const tileSize = await runtimeBridge.read16(bitmap + 0x08)
        const storage = await runtimeBridge.read16(bitmap + 0x0a)
        if (!isMainRamPointer(pixelData)) {
          throw new Error(`GFLBitmap pixel data is invalid (${hex(pixelData)}).`)
        }
        const firstWordBefore = await runtimeBridge.read32(pixelData)

        console.info('[PokéRun interaction] BITMAP FILL CALL', {
          address: hex(GFL_BITMAP_FILL),
          bitmap: hex(bitmap),
          pixelData: hex(pixelData),
          color: MSGBG_COLOR_BG_FILL,
          bitmapWidth,
          bitmapHeight,
          tileSize,
          storage,
          firstWordBefore: hex(firstWordBefore),
          note: 'No map flush, char flush, BG load, or frame draw is invoked.',
        })

        const fillCall = await atomicCall(GFL_BITMAP_FILL, bitmap, MSGBG_COLOR_BG_FILL)
        const firstWordAfter = await runtimeBridge.read32(pixelData)
        if (firstWordAfter !== 0xffffffff) {
          throw new Error(
            `GFL_BitmapFill returned but the first pixel word is ${hex(firstWordAfter)}; expected 0xFFFFFFFF.`,
          )
        }

        stateRef.current = { window: nativeWindow }
        emitMenuState(false)
        console.info('[PokéRun interaction] BG CHAR PREFLIGHT + BITMAP FILL SUCCESS', {
          window: hex(nativeWindow),
          bitmap: hex(bitmap),
          pixelData: hex(pixelData),
          bg: nativeBg,
          x,
          y,
          sizeX,
          sizeY,
          width,
          height,
          palette,
          charPos,
          preflightCharPos: preflightPos,
          colorMode: windowColorMode,
          bytesPerTile,
          createInstructions: createCall.instructions,
          fillInstructions: fillCall.instructions,
          firstWordBefore: hex(firstWordBefore),
          firstWordAfter: hex(firstWordAfter),
          note: 'Allocator preflight, native BmpWin allocation, and CPU-side bitmap fill all passed. Nothing is expected to be visible yet.',
        })
      } catch (reason) {
        console.info('[PokéRun interaction] BG CHAR PREFLIGHT PROBE FAILED', {
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
      // Deliberately do not free a successful BmpWin in this one-shot diagnostic.
      // A fresh emulator session owns its lifetime.
      stateRef.current = null
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
