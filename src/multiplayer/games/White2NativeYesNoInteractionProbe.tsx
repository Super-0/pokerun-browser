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

const GFL_HEAP_ALLOCATE_CORE = 0x02039dc8
const GFL_HEAP_FREE_CORE = 0x02039e58
const LIST_MENU_CORE_CREATE_OPTION_LIST = 0x02024f8c
const LIST_MENU_CORE_FREE_OPTION_LIST = 0x02024fd8
const LIST_MENU_CORE_APPEND_STRBUF_OPTION = 0x02025008

const MSG_BG_CREATE_MENU_FUNC = 0x02187ea0
const MSG_BG_DELETE_MENU_FUNC = 0x02187ee0
const LIST_MENU_UI_UPDATE = 0x02187f08
const MSG_BG_DRAW_MENU_FUNC_FRAME = 0x02188048

const FIELDMAP_CTRL_GRID = 0
const STRBUF_MAGIC = 0xb6f8d2ec
const STRBUF_TERMINATOR = 0xffff
const LIST_WAITING = -1
const LIST_MENU_REQUEST_SIZE = 0x20
const MENU_RECOVERY_RADIUS = 0x4000
const MENU_DECISION_INPUT_WINDOW_MS = 300
const WHITE2_NATIVE_MENU_STATE_EVENT = 'pokerun:white2-native-menu-state'
const NATIVE_STACK_RESERVE = 0x800
const POLL_MS = 34

const PROBE_ITEMS = [
  { label: 'EMOTE', value: 1 },
  { label: 'CLOSE', value: 0 },
] as const

type NativeMenuState = {
  field: number
  menu: number
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= 0x02000000 && value < 0x02400000 && (value & 3) === 0
}

function hex(value: number) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

function signed32(value: number) {
  return value | 0
}

function makeRequest(count: number) {
  const bytes = new Uint8Array(LIST_MENU_REQUEST_SIZE)
  const view = new DataView(bytes.buffer)
  view.setUint16(0x00, count, true)
  view.setUint16(0x02, count, true)
  bytes[0x04] = 0
  bytes[0x05] = 13
  bytes[0x06] = 0
  bytes[0x07] = 0x13
  bytes[0x08] = 0x2f
  bytes[0x09] = 0
  view.setUint16(0x0a, 0x0008, true)
  view.setUint32(0x0c, 0, true)
  view.setUint16(0x10, 12, true)
  view.setUint16(0x12, 13, true)
  view.setUint16(0x14, 18, true)
  view.setUint16(0x16, 2, true)
  view.setUint16(0x18, 12, true)
  view.setUint16(0x1a, 5, true)
  view.setUint32(0x1c, 0, true)
  return bytes
}

function makeStrBuf(text: string) {
  const size = text.length + 1
  const bytes = new Uint8Array(size * 2 + 10)
  const view = new DataView(bytes.buffer)
  view.setUint16(0x00, size, true)
  view.setUint16(0x02, text.length, true)
  view.setUint32(0x04, STRBUF_MAGIC, true)
  for (let index = 0; index < text.length; index += 1) {
    view.setUint16(0x08 + index * 2, text.charCodeAt(index), true)
  }
  view.setUint16(0x08 + text.length * 2, STRBUF_TERMINATOR, true)
  return bytes
}

export function White2NativeYesNoInteractionProbe({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const stateRef = useRef<NativeMenuState | null>(null)
  const openingRef = useRef(false)
  const pollingRef = useRef(false)

  useEffect(() => {
    const supported = White2ActorSystemProbe.supportsRom(rom)
    console.info('[PokéRun interaction] DIRECT MENU PROBE EFFECT', {
      hasBridge: Boolean(bridge),
      supported,
      bridgeStatus: bridge?.status ?? null,
      gameId: rom.gameId,
      sha256: rom.sha256,
    })

    if (!bridge || !supported) return

    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    let lastDecisionInputAt = 0
    let lastUnarmedResult: number | null = null

    const emitMenuState = (open: boolean) => {
      window.dispatchEvent(new CustomEvent(WHITE2_NATIVE_MENU_STATE_EVENT, { detail: { open } }))
    }

    console.info('[PokéRun interaction] DIRECT MENU PROBE MOUNTED', {
      bridgeStatus: runtimeBridge.status,
      rom: rom.gameId,
    })

    async function nativeCall(address: number, r0 = 0, r1 = 0, r2 = 0, r3 = 0) {
      const call = await runtimeBridge.callArm9Thumb4(address, r0, r1, r2, r3, NATIVE_STACK_RESERVE)
      if (call.status !== 1) {
        throw new Error(
          `Native call ${hex(address)} failed with status ${call.status} at ${hex(call.pc)}; `
          + `lr=${hex(call.lr)} instructions=${call.instructions}.`,
        )
      }
      return call.result >>> 0
    }

    async function freeScratch(pointer: number) {
      if (!isMainRamPointer(pointer)) return
      try { await nativeCall(GFL_HEAP_FREE_CORE, pointer) } catch { /* best effort during teardown */ }
    }

    async function createOptions(heapId: number) {
      const options = await nativeCall(LIST_MENU_CORE_CREATE_OPTION_LIST, PROBE_ITEMS.length, heapId)
      if (!isMainRamPointer(options)) throw new Error(`ListMenuCore_CreateOptionList returned ${hex(options)}.`)

      try {
        for (const item of PROBE_ITEMS) {
          let textPtr = 0
          try {
            const strBuf = makeStrBuf(item.label)
            textPtr = await nativeCall(GFL_HEAP_ALLOCATE_CORE, heapId, strBuf.length)
            if (!isMainRamPointer(textPtr)) throw new Error(`Could not allocate StrBuf for ${item.label}.`)
            await runtimeBridge.writeBytes(textPtr, strBuf)
            await nativeCall(LIST_MENU_CORE_APPEND_STRBUF_OPTION, options, textPtr, item.value, heapId)
          } finally {
            await freeScratch(textPtr)
          }
        }
        return options
      } catch (reason) {
        try { await nativeCall(LIST_MENU_CORE_FREE_OPTION_LIST, options) } catch { /* best effort */ }
        throw reason
      }
    }

    async function recoverMenuPointer(msgBg: number, options: number, anchor: number) {
      const start = Math.max(0x02000000, (anchor - MENU_RECOVERY_RADIUS) & ~3)
      const end = Math.min(0x02400000 - 0x14, (anchor + MENU_RECOVERY_RADIUS) & ~3)

      for (let address = start; address <= end; address += 4) {
        if ((await runtimeBridge.read32(address)) !== msgBg) continue
        if ((await runtimeBridge.read32(address + 0x0c)) !== options) continue

        const printer = await runtimeBridge.read32(address + 0x04)
        const window = await runtimeBridge.read32(address + 0x08)
        const list = await runtimeBridge.read32(address + 0x10)
        if (!isMainRamPointer(printer) || !isMainRamPointer(window) || !isMainRamPointer(list)) continue

        console.info('[PokéRun interaction] NATIVE MENU POINTER RECOVERED', {
          menu: hex(address),
          printer: hex(printer),
          window: hex(window),
          options: hex(options),
          list: hex(list),
        })
        return address
      }

      return 0
    }

    async function closeMenu() {
      const state = stateRef.current
      stateRef.current = null
      emitMenuState(false)
      lastDecisionInputAt = 0
      lastUnarmedResult = null
      if (!state) return

      try {
        if (isMainRamPointer(state.menu)) await nativeCall(MSG_BG_DELETE_MENU_FUNC, state.menu)
      } catch (reason) {
        console.info('[PokéRun interaction] DIRECT MENU CLEANUP MENU FAILED', {
          reason: reason instanceof Error ? reason.message : String(reason),
        })
      }

      try {
        if (isMainRamPointer(state.field)) await nativeCall(FIELDMAP_CTRL_GRID_SET_UPDATE_DISABLE, state.field, 0)
      } catch (reason) {
        console.info('[PokéRun interaction] DIRECT MENU CLEANUP FIELD FAILED', {
          reason: reason instanceof Error ? reason.message : String(reason),
        })
      }
    }

    async function openMenu() {
      if (openingRef.current || stateRef.current || runtimeBridge.status !== 'running') return
      openingRef.current = true

      let field = 0
      let requestPtr = 0
      let options = 0
      let menu = 0
      let frozen = false

      try {
        const scan = await probe.scanHeap()
        if (!scan.playerActor || !isMainRamPointer(scan.playerActor.address)) {
          throw new Error(`Player actor is invalid (${hex(scan.playerActor?.address ?? 0)}).`)
        }

        const playerActor = scan.playerActor.address
        const effects = await nativeCall(FLD_ACT_GET_FIELD_EFFECTS, playerActor)
        if (!isMainRamPointer(effects)) throw new Error(`FldAct_GetFieldEffects returned ${hex(effects)}.`)

        field = await nativeCall(FIELD_EFFECTS_GET_FIELD, effects)
        if (!isMainRamPointer(field)) throw new Error(`FieldEffects_GetField returned ${hex(field)}.`)

        const controllerType = await nativeCall(FIELD_GET_CONTROLLER_TYPE_ID, field)
        if (controllerType !== FIELDMAP_CTRL_GRID) {
          throw new Error(`Field controller ${controllerType} is not the normal grid controller.`)
        }

        const heapId = await nativeCall(FIELD_GET_HEAP_ID, field)
        const msgBg = await nativeCall(FIELD_GET_MSGBG_SYS, field)
        if (!isMainRamPointer(msgBg)) throw new Error(`Field_GetMsgBGSys returned ${hex(msgBg)}.`)

        console.info('[PokéRun interaction] DIRECT MENU FIELD PATH READY', {
          actor: hex(playerActor),
          effects: hex(effects),
          field: hex(field),
          heapId,
          msgBg: hex(msgBg),
        })

        await nativeCall(FIELDMAP_CTRL_GRID_SET_UPDATE_DISABLE, field, 1)
        frozen = true

        requestPtr = await nativeCall(GFL_HEAP_ALLOCATE_CORE, heapId, LIST_MENU_REQUEST_SIZE)
        if (!isMainRamPointer(requestPtr)) throw new Error(`Menu request allocation returned ${hex(requestPtr)}.`)
        const request = makeRequest(PROBE_ITEMS.length)
        await runtimeBridge.writeBytes(requestPtr, request)
        console.info('[PokéRun interaction] DIRECT MENU REQUEST READY', {
          request: hex(requestPtr),
          size: request.length,
          packedBits: hex(new DataView(request.buffer).getUint32(0x08, true)),
        })

        options = await createOptions(heapId)
        const createCall = await runtimeBridge.callArm9Thumb4(
          MSG_BG_CREATE_MENU_FUNC,
          msgBg,
          requestPtr,
          options,
          0,
          NATIVE_STACK_RESERVE,
        )

        if (createCall.status === 1 && isMainRamPointer(createCall.result)) {
          menu = createCall.result >>> 0
        } else {
          menu = await recoverMenuPointer(msgBg, options, requestPtr)
          if (!isMainRamPointer(menu)) {
            throw new Error(
              `MsgBGPrinter_CreateMenuFunc did not yield a recoverable menu `
              + `(status=${createCall.status} result=${hex(createCall.result)} pc=${hex(createCall.pc)} `
              + `lr=${hex(createCall.lr)} instructions=${createCall.instructions}).`,
            )
          }

          console.info('[PokéRun interaction] NATIVE MENU BRIDGE RETURN RECOVERED', {
            status: createCall.status,
            result: hex(createCall.result),
            pc: hex(createCall.pc),
            lr: hex(createCall.lr),
            instructions: createCall.instructions,
            menu: hex(menu),
          })
        }

        options = 0
        await nativeCall(MSG_BG_DRAW_MENU_FUNC_FRAME, menu)

        stateRef.current = { field, menu }
        lastDecisionInputAt = 0
        lastUnarmedResult = null
        emitMenuState(true)
        console.info('[PokéRun interaction] NATIVE DIRECT MENU OPEN', {
          field: hex(field),
          menu: hex(menu),
          source: 'direct-strbuf',
        })
      } catch (reason) {
        console.info('[PokéRun interaction] NATIVE DIRECT MENU FAILED', {
          reason: reason instanceof Error ? reason.message : String(reason),
        })

        if (isMainRamPointer(menu)) {
          try { await nativeCall(MSG_BG_DELETE_MENU_FUNC, menu) } catch { /* best effort */ }
        } else if (isMainRamPointer(options)) {
          try { await nativeCall(LIST_MENU_CORE_FREE_OPTION_LIST, options) } catch { /* best effort */ }
        }

        if (frozen && isMainRamPointer(field)) {
          try { await nativeCall(FIELDMAP_CTRL_GRID_SET_UPDATE_DISABLE, field, 0) } catch { /* best effort */ }
        }
        emitMenuState(false)
      } finally {
        await freeScratch(requestPtr)
        openingRef.current = false
      }
    }

    const onInteract = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined
      console.info('[PokéRun interaction] INTERACT EVENT RECEIVED', {
        code: detail?.code ?? null,
        bridgeStatus: runtimeBridge.status,
        menuOpen: Boolean(stateRef.current),
        opening: openingRef.current,
      })
      void openMenu()
    }

    const onMenuDecisionKey = (event: KeyboardEvent) => {
      if (!stateRef.current || event.repeat || (event.code !== 'KeyX' && event.code !== 'KeyZ')) return
      lastDecisionInputAt = performance.now()
      lastUnarmedResult = null
      console.info('[PokéRun interaction] NATIVE MENU DECISION INPUT', { code: event.code })
    }

    window.addEventListener(WHITE2_INTERACT_EVENT, onInteract)
    window.addEventListener('keydown', onMenuDecisionKey)

    const timer = window.setInterval(() => {
      const state = stateRef.current
      if (!state || pollingRef.current || runtimeBridge.status !== 'running') return
      pollingRef.current = true
      void (async () => {
        try {
          const updateCall = await runtimeBridge.callArm9Thumb4(
            LIST_MENU_UI_UPDATE,
            state.menu,
            0,
            0,
            0,
            NATIVE_STACK_RESERVE,
          )
          if (updateCall.status !== 1) {
            throw new Error(
              `Native call ${hex(LIST_MENU_UI_UPDATE)} failed with status ${updateCall.status} at ${hex(updateCall.pc)}; `
              + `lr=${hex(updateCall.lr)} instructions=${updateCall.instructions}.`,
            )
          }

          const result = signed32(updateCall.result)
          if (result === LIST_WAITING) {
            lastUnarmedResult = null
            return
          }

          const decisionAgeMs = lastDecisionInputAt > 0 ? performance.now() - lastDecisionInputAt : Number.POSITIVE_INFINITY
          if (decisionAgeMs <= MENU_DECISION_INPUT_WINDOW_MS) {
            console.info('[PokéRun interaction] NATIVE DIRECT MENU RESULT', {
              result,
              decisionAgeMs: Math.round(decisionAgeMs),
            })
            await closeMenu()
            return
          }

          if (lastUnarmedResult !== result) {
            lastUnarmedResult = result
            console.info('[PokéRun interaction] NATIVE MENU IGNORED UNARMED RESULT', {
              result,
              raw: hex(updateCall.result),
            })
          }
        } catch (reason) {
          console.info('[PokéRun interaction] NATIVE DIRECT MENU UPDATE FAILED', {
            reason: reason instanceof Error ? reason.message : String(reason),
          })
          await closeMenu()
        } finally {
          pollingRef.current = false
        }
      })()
    }, POLL_MS)

    return () => {
      window.removeEventListener(WHITE2_INTERACT_EVENT, onInteract)
      window.removeEventListener('keydown', onMenuDecisionKey)
      window.clearInterval(timer)
      emitMenuState(false)
      if (stateRef.current) void closeMenu()
    }
  }, [bridge, rom.gameId, rom.sha256])

  return null
}
