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
const FIELDMAP_CTRL_GRID_SET_UPDATE_DISABLE = 0x0219a4b0
const MSG_BG_PRINTER_SETUP_SYS_FRAME = 0x0218a4e4
const FIELD_MSGBG_CREATE_BMP_WIN = 0x0218a638

const FIELDMAP_CTRL_GRID = 0
const MSGBG_BG2 = 2
const MSGBG_PLTT_BG2 = 14
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
  field: number
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
    console.info('[PokéRun interaction] ATOMIC WINDOW PROBE EFFECT', {
      hasBridge: Boolean(bridge),
      supported,
      bridgeStatus: bridge?.status ?? null,
      gameId: rom.gameId,
      sha256: rom.sha256,
    })

    if (!bridge || !supported) return

    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    // PRK10 intentionally adds the new fixed-arity atomic stack-argument call as
    // an isolated diagnostic surface. Existing callArm9Thumb4 users are left
    // untouched until this path is proven in White 2.
    const atomicRuntime = (runtimeBridge as unknown as { emulator: AtomicRuntime | null }).emulator
    if (!atomicRuntime || typeof atomicRuntime.callArm9Thumb8Atomic !== 'function') {
      console.info('[PokéRun interaction] ATOMIC WINDOW PROBE UNAVAILABLE', {
        reason: 'PRK10 atomic stack-argument export is unavailable.',
      })
      return
    }

    const emitMenuState = (open: boolean) => {
      window.dispatchEvent(new CustomEvent(WHITE2_NATIVE_MENU_STATE_EVENT, { detail: { open } }))
    }

    console.info('[PokéRun interaction] ATOMIC WINDOW PROBE MOUNTED', {
      bridgeStatus: runtimeBridge.status,
      rom: rom.gameId,
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
      return result
    }

    async function openWindow() {
      if (openingRef.current || stateRef.current || runtimeBridge.status !== 'running') {
        if (stateRef.current) {
          console.info('[PokéRun interaction] ATOMIC WINDOW STABILITY HOLD', {
            window: hex(stateRef.current.window),
          })
        }
        return
      }
      openingRef.current = true

      let field = 0
      let frozen = false

      try {
        const scan = await probe.scanHeap()
        if (!scan.playerActor || !isMainRamPointer(scan.playerActor.address)) {
          throw new Error(`Player actor is invalid (${hex(scan.playerActor?.address ?? 0)}).`)
        }

        const playerActor = scan.playerActor.address
        const effects = await atomicCall(FLD_ACT_GET_FIELD_EFFECTS, playerActor)
        if (!isMainRamPointer(effects)) throw new Error(`FldAct_GetFieldEffects returned ${hex(effects)}.`)

        field = await atomicCall(FIELD_EFFECTS_GET_FIELD, effects)
        if (!isMainRamPointer(field)) throw new Error(`FieldEffects_GetField returned ${hex(field)}.`)

        const controllerType = await atomicCall(FIELD_GET_CONTROLLER_TYPE_ID, field)
        if (controllerType !== FIELDMAP_CTRL_GRID) {
          throw new Error(`Field controller ${controllerType} is not the normal grid controller.`)
        }

        const heapId = await atomicCall(FIELD_GET_HEAP_ID, field)
        const msgBg = await atomicCall(FIELD_GET_MSGBG_SYS, field)
        if (!isMainRamPointer(msgBg)) throw new Error(`Field_GetMsgBGSys returned ${hex(msgBg)}.`)

        // FieldMsgBG begins with HeapID (u16), then bg/bg2/palette (u16 each).
        const bg = await runtimeBridge.read16(msgBg + 0x02)
        const bg2 = await runtimeBridge.read16(msgBg + 0x04)
        const paletteBefore = await runtimeBridge.read16(msgBg + 0x06)
        console.info('[PokéRun interaction] ATOMIC WINDOW FIELD PATH READY', {
          actor: hex(playerActor),
          effects: hex(effects),
          field: hex(field),
          heapId,
          msgBg: hex(msgBg),
          bg,
          bg2,
          paletteBefore,
        })

        if (bg2 !== MSGBG_BG2) {
          throw new Error(`FieldMsgBG bg2 is ${bg2}; expected ${MSGBG_BG2}.`)
        }

        await atomicCall(FIELDMAP_CTRL_GRID_SET_UPDATE_DISABLE, field, 1)
        frozen = true

        console.info('[PokéRun interaction] ATOMIC WINDOW SETUP SYS FRAME CALL', {
          address: hex(MSG_BG_PRINTER_SETUP_SYS_FRAME),
        })
        await atomicCall(MSG_BG_PRINTER_SETUP_SYS_FRAME, msgBg)
        // Match MsgBGPrinter_CreateMenuFuncCallback: select the BG2 palette.
        // +0x06 is palette; +0x08 is the font pointer and must never be touched.
        await runtimeBridge.write16(msgBg + 0x06, MSGBG_PLTT_BG2)

        console.info('[PokéRun interaction] ATOMIC WINDOW CREATE CALL', {
          address: hex(FIELD_MSGBG_CREATE_BMP_WIN),
          args: {
            bg: bg2,
            heapId,
            x: 18,
            y: 2,
            width: 12,
            height: 5,
            palette: MSGBG_PLTT_BG2,
          },
        })

        const nativeWindow = await atomicCall(
          FIELD_MSGBG_CREATE_BMP_WIN,
          bg2,
          heapId,
          18,
          2,
          12,
          5,
          MSGBG_PLTT_BG2,
          0,
        )
        if (!isMainRamPointer(nativeWindow)) {
          throw new Error(`FieldMsgBG_CreateBmpWin returned ${hex(nativeWindow)}.`)
        }

        const magicAndMode = await runtimeBridge.read16(nativeWindow + 0x00)
        const nativeBg = await runtimeBridge.read8(nativeWindow + 0x02)
        const x = await runtimeBridge.read8(nativeWindow + 0x03)
        const y = await runtimeBridge.read8(nativeWindow + 0x04)
        const sizeX = await runtimeBridge.read8(nativeWindow + 0x05)
        const sizeY = await runtimeBridge.read8(nativeWindow + 0x06)
        const palette = await runtimeBridge.read8(nativeWindow + 0x09)
        const bitmap = await runtimeBridge.read32(nativeWindow + 0x0c)
        const magic = magicAndMode & 0x7fff

        if (magic !== 0x7fb2 || !isMainRamPointer(bitmap)) {
          throw new Error(
            `FieldMsgBG_CreateBmpWin returned invalid BmpWin ${hex(nativeWindow)} `
            + `(magic=${hex(magic)} bitmap=${hex(bitmap)}).`,
          )
        }

        stateRef.current = { field, window: nativeWindow }
        emitMenuState(true)
        console.info('[PokéRun interaction] ATOMIC NATIVE WINDOW OPEN', {
          field: hex(field),
          window: hex(nativeWindow),
          bitmap: hex(bitmap),
          bg: nativeBg,
          x,
          y,
          sizeX,
          sizeY,
          palette,
          note: 'One-call stability probe: no printer, list, cursor, update, or delete is invoked.',
        })
      } catch (reason) {
        console.info('[PokéRun interaction] ATOMIC NATIVE WINDOW FAILED', {
          reason: reason instanceof Error ? reason.message : String(reason),
        })
        if (frozen && isMainRamPointer(field)) {
          try { await atomicCall(FIELDMAP_CTRL_GRID_SET_UPDATE_DISABLE, field, 0) } catch { /* best effort */ }
        }
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
        windowOpen: Boolean(stateRef.current),
        opening: openingRef.current,
      })
      void openWindow()
    }

    window.addEventListener(WHITE2_INTERACT_EVENT, onInteract)

    return () => {
      window.removeEventListener(WHITE2_INTERACT_EVENT, onInteract)
      emitMenuState(false)
      const state = stateRef.current
      stateRef.current = null
      if (state && isMainRamPointer(state.field)) {
        void atomicCall(FIELDMAP_CTRL_GRID_SET_UPDATE_DISABLE, state.field, 0).catch(() => undefined)
      }
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
