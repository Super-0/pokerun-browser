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
const BMP_WIN_CREATE_DYNAMIC = 0x020480ec

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
    console.info('[PokéRun interaction] BMPWIN ALLOC PROBE EFFECT', {
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
      console.info('[PokéRun interaction] BMPWIN ALLOC PROBE UNAVAILABLE', {
        reason: 'Scheduler-aware stack-argument native-call export is unavailable.',
      })
      return
    }

    const emitMenuState = (open: boolean) => {
      window.dispatchEvent(new CustomEvent(WHITE2_NATIVE_MENU_STATE_EVENT, { detail: { open } }))
    }

    console.info('[PokéRun interaction] BMPWIN ALLOC PROBE MOUNTED', {
      bridgeStatus: runtimeBridge.status,
      rom: rom.gameId,
      address: hex(BMP_WIN_CREATE_DYNAMIC),
      note: 'PRK12 isolates BmpWin_CreateDynamic before bitmap fill/map flush/char flush/BG load/frame draw.',
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

    async function probeBmpWinAllocation() {
      if (openingRef.current || stateRef.current || runtimeBridge.status !== 'running') {
        if (stateRef.current) {
          console.info('[PokéRun interaction] BMPWIN ALLOC PROBE HOLD', {
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
        const effectsCall = await atomicCall(FLD_ACT_GET_FIELD_EFFECTS, playerActor)
        const effects = effectsCall.result
        if (!isMainRamPointer(effects)) throw new Error(`FldAct_GetFieldEffects returned ${hex(effects)}.`)

        const fieldCall = await atomicCall(FIELD_EFFECTS_GET_FIELD, effects)
        const field = fieldCall.result
        if (!isMainRamPointer(field)) throw new Error(`FieldEffects_GetField returned ${hex(field)}.`)

        const controllerCall = await atomicCall(FIELD_GET_CONTROLLER_TYPE_ID, field)
        const controllerType = controllerCall.result
        if (controllerType !== FIELDMAP_CTRL_GRID) {
          throw new Error(`Field controller ${controllerType} is not the normal grid controller.`)
        }

        const heapCall = await atomicCall(FIELD_GET_HEAP_ID, field)
        const heapId = heapCall.result
        const msgBgCall = await atomicCall(FIELD_GET_MSGBG_SYS, field)
        const msgBg = msgBgCall.result
        if (!isMainRamPointer(msgBg)) throw new Error(`Field_GetMsgBGSys returned ${hex(msgBg)}.`)

        const bg = await runtimeBridge.read16(msgBg + 0x02)
        const bg2 = await runtimeBridge.read16(msgBg + 0x04)
        const paletteBefore = await runtimeBridge.read16(msgBg + 0x06)
        console.info('[PokéRun interaction] BMPWIN ALLOC FIELD PATH READY', {
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

        console.info('[PokéRun interaction] BMPWIN CREATE DYNAMIC CALL', {
          address: hex(BMP_WIN_CREATE_DYNAMIC),
          args: {
            bg: bg2,
            x: 18,
            y: 2,
            width: 12,
            height: 5,
            palette: MSGBG_PLTT_BG2,
            fromEnd: 1,
          },
          note: 'No frame setup, bitmap fill, map flush, char flush, BG load, or frame draw is performed in this probe.',
        })

        const createCall = await atomicCall(
          BMP_WIN_CREATE_DYNAMIC,
          bg2,
          18,
          2,
          12,
          5,
          MSGBG_PLTT_BG2,
          1,
          0,
        )
        const nativeWindow = createCall.result
        if (!isMainRamPointer(nativeWindow)) {
          throw new Error(`BmpWin_CreateDynamic returned ${hex(nativeWindow)}.`)
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
        const colorMode = magicAndMode >>> 15

        if (magic !== 0x7fb2 || !isMainRamPointer(bitmap)) {
          throw new Error(
            `BmpWin_CreateDynamic returned invalid BmpWin ${hex(nativeWindow)} `
            + `(magic=${hex(magic)} bitmap=${hex(bitmap)}).`,
          )
        }

        stateRef.current = { window: nativeWindow }
        emitMenuState(false)
        console.info('[PokéRun interaction] BMPWIN CREATE DYNAMIC SUCCESS', {
          window: hex(nativeWindow),
          bitmap: hex(bitmap),
          bg: nativeBg,
          x,
          y,
          sizeX,
          sizeY,
          width,
          height,
          palette,
          charPos,
          colorMode,
          instructions: createCall.instructions,
          note: 'Allocation-only breakpoint passed. Nothing is expected to be visible on-screen yet.',
        })
      } catch (reason) {
        console.info('[PokéRun interaction] BMPWIN CREATE DYNAMIC FAILED', {
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
        allocationComplete: Boolean(stateRef.current),
        opening: openingRef.current,
      })
      void probeBmpWinAllocation()
    }

    window.addEventListener(WHITE2_INTERACT_EVENT, onInteract)

    return () => {
      window.removeEventListener(WHITE2_INTERACT_EVENT, onInteract)
      emitMenuState(false)
      // Deliberately do not invoke BmpWin_Free in PRK12. This is a one-shot
      // allocation diagnostic and a fresh emulator session owns its lifetime.
      stateRef.current = null
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
