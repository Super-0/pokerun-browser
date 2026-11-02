import { useEffect, useMemo, useRef, useState } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerDirection, MultiplayerEmoteKind, MultiplayerPlayerState, MultiplayerRomIdentity } from '../core/protocol'
import { White2ActorSystemProbe } from './White2ActorSystem'

const GAME_SYSTEM_FIELD = 0x20
const FIELDMAP_CTRL_GRID = 0

const FIELD_GET_MSGBG_SYS = 0x021804d0
const FIELD_GET_HEAP_ID = 0x02180500
const FIELD_GET_CONTROLLER_TYPE_ID = 0x0218056c
const FIELDMAP_CTRL_GRID_SET_UPDATE_DISABLE = 0x0219a4b0

const MSG_BG_CREATE_MSG_DATA = 0x021879e0
const MSG_BG_DELETE_MSG_DATA = 0x021879f8
const MSG_BG_CREATE_MENU_ITEMS_FROM_TABLE = 0x02187f4c
const MSG_BG_CREATE_MENU_FUNC = 0x02187ea0
const MSG_BG_DELETE_MENU_FUNC = 0x02187ee0
const LIST_MENU_UI_UPDATE = 0x02187f08
const MSG_BG_DRAW_MENU_FUNC_FRAME = 0x02188048

const GFL_HEAP_ALLOCATE_CORE = 0x02039dc8
const GFL_HEAP_FREE_CORE = 0x02039e58
const LIST_MENU_CORE_FREE_OPTION_LIST = 0x02024fd8

const TEXT_BANK_UNION_MSG = 399
const TEXT_BANK_PMS_WORDS_FEELINGS = 166

const BMPMENULIST_NULL = -1
const BMPMENULIST_CANCEL = -2
const NATIVE_STACK_RESERVE = 0x800
const POLL_MS = 34

const ROOT_ROWS = [
  { messageId: 0, value: 1 }, // Greet
  { messageId: 2, value: 2 }, // Battle
  { messageId: 3, value: 3 }, // Trade
  { messageId: 4, value: 0 }, // Cancel
]

const EMOTE_ROWS = [
  { messageId: 34, value: 10 }, // SURPRISE -> !
  { messageId: 36, value: 11 }, // NERVOUS -> ?
  { messageId: 32, value: 12 }, // HAPPY -> music note
  { messageId: 18, value: 13 }, // BORED -> ...
]

type NativeMenuPage = 'root' | 'emotes'

type NativeMenuState = {
  page: NativeMenuPage
  field: number
  heapId: number
  msgBg: number
  msgData: number
  menu: number
}

function facingDelta(direction: MultiplayerDirection) {
  if (direction === 'north') return { x: 0, y: -1 }
  if (direction === 'south') return { x: 0, y: 1 }
  if (direction === 'west') return { x: -1, y: 0 }
  return { x: 1, y: 0 }
}

function canInteract(local: MultiplayerPlayerState | null, remote: MultiplayerPlayerState | null) {
  if (!local || !remote || local.location.mapId !== remote.location.mapId) return false
  const expected = facingDelta(local.direction)
  return remote.x - local.x === expected.x && remote.y - local.y === expected.y
}

function isMainRamPointer(value: number) {
  return Number.isInteger(value) && value >= 0x02000000 && value < 0x02400000 && (value & 3) === 0
}

function signed32(value: number) {
  return value | 0
}

function hex(value: number) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

function makeRows(rows: { messageId: number; value: number }[]) {
  const bytes = new Uint8Array(rows.length * 8)
  const view = new DataView(bytes.buffer)
  rows.forEach((row, index) => {
    view.setUint32(index * 8, row.messageId >>> 0, true)
    view.setInt32(index * 8 + 4, row.value | 0, true)
  })
  return bytes
}

function makeRequest(count: number) {
  // White 2 ListMenuRequest is 0x20 bytes. These values mirror the field
  // script list-menu defaults, with a compact four-row window on the right.
  const bytes = new Uint8Array(0x20)
  const view = new DataView(bytes.buffer)
  view.setUint16(0x00, count, true)
  view.setUint16(0x02, count, true)
  bytes[0x04] = 0 // labelX
  bytes[0x05] = 13 // itemX
  bytes[0x06] = 0 // cursorX
  bytes[0x07] = 0x10 // listY=0, fgColor=1
  bytes[0x08] = 0x2f // bgColor=15, shadowColor=2
  view.setUint16(0x0a, 0x0008, true) // letterSpacing=0, lineSpacing=1
  view.setInt32(0x0c, 1, true) // pageSkip
  view.setUint16(0x10, 12, true) // fontSizeX
  view.setUint16(0x12, 13, true) // rowHeight
  view.setUint16(0x14, 17, true) // x (tiles)
  view.setUint16(0x16, 2, true) // y (tiles)
  view.setUint16(0x18, 14, true) // width (tiles)
  view.setUint16(0x1a, 8, true) // height (tiles)
  view.setUint32(0x1c, 0, true) // printCallback
  return bytes
}

function pageDefinition(page: NativeMenuPage) {
  if (page === 'emotes') {
    return { rows: EMOTE_ROWS, textBank: TEXT_BANK_PMS_WORDS_FEELINGS }
  }
  return { rows: ROOT_ROWS, textBank: TEXT_BANK_UNION_MSG }
}

function resultToEmote(result: number): MultiplayerEmoteKind | null {
  if (result === 10) return 'surprised'
  if (result === 11) return 'question'
  if (result === 12) return 'cheer'
  if (result === 13) return 'ellipsis'
  return null
}

export function White2NativeInteractionMenuRuntime({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const [presence, setPresence] = useState<MultiplayerPresenceSnapshot>({ local: null, remote: null })
  const stateRef = useRef<NativeMenuState | null>(null)
  const openingRef = useRef(false)
  const pollingRef = useRef(false)
  const cancelledRef = useRef(false)

  useEffect(() => multiplayerPresence.subscribe(setPresence), [])

  const interactable = useMemo(
    () => canInteract(presence.local, presence.remote),
    [presence.local, presence.remote],
  )

  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return

    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)
    cancelledRef.current = false

    async function nativeCall(address: number, r0 = 0, r1 = 0, r2 = 0, r3 = 0) {
      const call = await runtimeBridge.callArm9Thumb4(address, r0, r1, r2, r3, NATIVE_STACK_RESERVE)
      if (call.status !== 1) throw new Error(`Native call ${hex(address)} failed with status ${call.status} at ${hex(call.pc)}.`)
      return call.result >>> 0
    }

    async function freeScratch(pointer: number) {
      if (!isMainRamPointer(pointer)) return
      try { await nativeCall(GFL_HEAP_FREE_CORE, pointer) } catch { /* field teardown can invalidate scratch ownership */ }
    }

    async function destroyMenu(unfreeze: boolean) {
      const state = stateRef.current
      stateRef.current = null
      if (!state) return

      try {
        const liveField = await runtimeBridge.read32((await probe.inspect()).gameSystem + GAME_SYSTEM_FIELD)
        if (liveField === state.field) {
          await nativeCall(MSG_BG_DELETE_MENU_FUNC, state.menu)
          await nativeCall(MSG_BG_DELETE_MSG_DATA, state.msgData)
          if (unfreeze) await nativeCall(FIELDMAP_CTRL_GRID_SET_UPDATE_DISABLE, state.field, 0)
        }
      } catch (reason) {
        console.info('[PokéRun interaction] NATIVE MENU CLEANUP SKIPPED', {
          reason: reason instanceof Error ? reason.message : String(reason),
        })
      }
    }

    async function createPage(page: NativeMenuPage, field: number, heapId: number, msgBg: number) {
      const definition = pageDefinition(page)
      let rowsPtr = 0
      let requestPtr = 0
      let msgData = 0
      let options = 0
      let menu = 0

      try {
        rowsPtr = await nativeCall(GFL_HEAP_ALLOCATE_CORE, heapId, definition.rows.length * 8)
        requestPtr = await nativeCall(GFL_HEAP_ALLOCATE_CORE, heapId, 0x20)
        if (!isMainRamPointer(rowsPtr) || !isMainRamPointer(requestPtr)) throw new Error('White 2 field heap could not allocate native menu scratch memory.')

        await runtimeBridge.writeBytes(rowsPtr, makeRows(definition.rows))
        await runtimeBridge.writeBytes(requestPtr, makeRequest(definition.rows.length))

        msgData = await nativeCall(MSG_BG_CREATE_MSG_DATA, msgBg, definition.textBank)
        if (!isMainRamPointer(msgData)) throw new Error(`MsgBGPrinter_CreateMsgData returned ${hex(msgData)}.`)

        options = await nativeCall(
          MSG_BG_CREATE_MENU_ITEMS_FROM_TABLE,
          rowsPtr,
          definition.rows.length,
          msgData,
          heapId,
        )
        if (!isMainRamPointer(options)) throw new Error(`MsgBGPrinter_CreateMenuItemsFromTable returned ${hex(options)}.`)

        menu = await nativeCall(MSG_BG_CREATE_MENU_FUNC, msgBg, requestPtr, options)
        if (!isMainRamPointer(menu)) throw new Error(`MsgBGPrinter_CreateMenuFunc returned ${hex(menu)}.`)

        await nativeCall(MSG_BG_DRAW_MENU_FUNC_FRAME, menu)
        stateRef.current = { page, field, heapId, msgBg, msgData, menu }
        console.info('[PokéRun interaction] NATIVE WHITE 2 MENU OPEN', {
          page,
          field: hex(field),
          menu: hex(menu),
          msgData: hex(msgData),
          textBank: definition.textBank,
        })
      } catch (reason) {
        if (isMainRamPointer(menu)) {
          try { await nativeCall(MSG_BG_DELETE_MENU_FUNC, menu) } catch { /* best effort */ }
        } else if (isMainRamPointer(options)) {
          try { await nativeCall(LIST_MENU_CORE_FREE_OPTION_LIST, options) } catch { /* best effort */ }
        }
        if (isMainRamPointer(msgData)) {
          try { await nativeCall(MSG_BG_DELETE_MSG_DATA, msgData) } catch { /* best effort */ }
        }
        throw reason
      } finally {
        await freeScratch(rowsPtr)
        await freeScratch(requestPtr)
      }
    }

    async function replacePage(page: NativeMenuPage) {
      const current = stateRef.current
      if (!current) return
      const { field, heapId, msgBg } = current
      await destroyMenu(false)
      await createPage(page, field, heapId, msgBg)
    }

    async function openRootMenu() {
      if (openingRef.current || stateRef.current || runtimeBridge.status !== 'running') return
      openingRef.current = true
      let field = 0
      let frozen = false
      try {
        const scan = await probe.scanHeap()
        field = await runtimeBridge.read32(scan.gameSystem + GAME_SYSTEM_FIELD)
        if (!isMainRamPointer(field)) throw new Error(`White 2 field pointer is invalid (${hex(field)}).`)

        const controllerType = await nativeCall(FIELD_GET_CONTROLLER_TYPE_ID, field)
        if (controllerType !== FIELDMAP_CTRL_GRID) {
          console.info('[PokéRun interaction] NATIVE MENU BLOCKED', {
            reason: 'Only the grid field controller is frozen safely in the first native-menu pass.',
            controllerType,
          })
          return
        }

        const heapId = await nativeCall(FIELD_GET_HEAP_ID, field)
        const msgBg = await nativeCall(FIELD_GET_MSGBG_SYS, field)
        if (!isMainRamPointer(msgBg)) throw new Error(`Field_GetMsgBGSys returned ${hex(msgBg)}.`)

        await nativeCall(FIELDMAP_CTRL_GRID_SET_UPDATE_DISABLE, field, 1)
        frozen = true
        await createPage('root', field, heapId, msgBg)
      } catch (reason) {
        console.info('[PokéRun interaction] NATIVE MENU FAILED', {
          reason: reason instanceof Error ? reason.message : String(reason),
        })
        if (frozen && isMainRamPointer(field)) {
          try { await nativeCall(FIELDMAP_CTRL_GRID_SET_UPDATE_DISABLE, field, 0) } catch { /* best effort */ }
        }
      } finally {
        openingRef.current = false
      }
    }

    async function handleResult(result: number) {
      const current = stateRef.current
      if (!current) return

      if (result === BMPMENULIST_CANCEL) {
        if (current.page === 'emotes') await replacePage('root')
        else await destroyMenu(true)
        return
      }

      if (current.page === 'root') {
        if (result === 0) {
          await destroyMenu(true)
        } else if (result === 1) {
          await replacePage('emotes')
        } else {
          console.info('[PokéRun interaction] NATIVE MENU FEATURE PENDING', {
            feature: result === 2 ? 'battle' : 'trade',
          })
          await destroyMenu(true)
        }
        return
      }

      const emote = resultToEmote(result)
      if (emote) {
        await destroyMenu(true)
        multiplayerPresence.sendEmote(emote)
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'KeyX' || event.repeat || stateRef.current || openingRef.current || !interactable) return
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      event.stopImmediatePropagation()
      void openRootMenu()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true, passive: false })

    const timer = window.setInterval(() => {
      const state = stateRef.current
      if (!state || pollingRef.current || runtimeBridge.status !== 'running') return
      pollingRef.current = true
      void (async () => {
        try {
          const result = signed32(await nativeCall(LIST_MENU_UI_UPDATE, state.menu))
          if (result !== BMPMENULIST_NULL) await handleResult(result)
        } catch (reason) {
          console.info('[PokéRun interaction] NATIVE MENU UPDATE FAILED', {
            reason: reason instanceof Error ? reason.message : String(reason),
          })
          await destroyMenu(true)
        } finally {
          pollingRef.current = false
        }
      })()
    }, POLL_MS)

    return () => {
      cancelledRef.current = true
      window.removeEventListener('keydown', onKeyDown, true)
      window.clearInterval(timer)
      if (stateRef.current) void destroyMenu(true)
    }
  }, [bridge, interactable, rom.gameId, rom.sha256])

  return null
}
