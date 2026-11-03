import { useEffect, useMemo, useRef, useState } from 'react'
import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'
import { multiplayerPresence, type MultiplayerPresenceSnapshot } from '../core/MultiplayerPresence'
import type { MultiplayerDirection, MultiplayerPlayerState, MultiplayerRomIdentity } from '../core/protocol'
import { White2ActorSystemProbe } from './White2ActorSystem'

const FLD_ACT_GET_FIELD_EFFECTS = 0x02194f18
const FIELD_EFFECTS_GET_FIELD = 0x021a3760
const FIELD_GET_MSGBG_SYS = 0x021804d0
const FIELD_GET_CONTROLLER_TYPE_ID = 0x0218056c
const FIELDMAP_CTRL_GRID_SET_UPDATE_DISABLE = 0x0219a4b0
const MSG_BG_CREATE_YES_NO_MENU = 0x02188114
const MSG_BG_YES_NO_MENU_MAIN = 0x021881ac
const MSG_BG_DELETE_MENU_FUNC = 0x02187ee0

const FIELDMAP_CTRL_GRID = 0
const YES_NO_WAITING = 2
const NATIVE_STACK_RESERVE = 0x800
const POLL_MS = 34

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

function hex(value: number) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

export function White2NativeYesNoInteractionProbe({ bridge, rom }: { bridge: MelonDsBridge | null; rom: MultiplayerRomIdentity }) {
  const [presence, setPresence] = useState<MultiplayerPresenceSnapshot>({ local: null, remote: null })
  const menuRef = useRef(0)
  const fieldRef = useRef(0)
  const openingRef = useRef(false)
  const pollingRef = useRef(false)

  useEffect(() => multiplayerPresence.subscribe(setPresence), [])

  const interactable = useMemo(
    () => canInteract(presence.local, presence.remote),
    [presence.local, presence.remote],
  )

  useEffect(() => {
    if (!bridge || !White2ActorSystemProbe.supportsRom(rom)) return

    const runtimeBridge = bridge
    const probe = new White2ActorSystemProbe(runtimeBridge)

    async function nativeCall(address: number, r0 = 0, r1 = 0, r2 = 0, r3 = 0) {
      const call = await runtimeBridge.callArm9Thumb4(address, r0, r1, r2, r3, NATIVE_STACK_RESERVE)
      if (call.status !== 1) throw new Error(`Native call ${hex(address)} failed with status ${call.status} at ${hex(call.pc)}.`)
      return call.result >>> 0
    }

    async function closeMenu() {
      const menu = menuRef.current
      const field = fieldRef.current
      menuRef.current = 0
      fieldRef.current = 0
      try {
        if (isMainRamPointer(menu)) await nativeCall(MSG_BG_DELETE_MENU_FUNC, menu)
      } catch (reason) {
        console.info('[PokéRun interaction] YES/NO CLEANUP MENU FAILED', {
          reason: reason instanceof Error ? reason.message : String(reason),
        })
      }
      try {
        if (isMainRamPointer(field)) await nativeCall(FIELDMAP_CTRL_GRID_SET_UPDATE_DISABLE, field, 0)
      } catch (reason) {
        console.info('[PokéRun interaction] YES/NO CLEANUP FIELD FAILED', {
          reason: reason instanceof Error ? reason.message : String(reason),
        })
      }
    }

    async function openMenu() {
      if (openingRef.current || menuRef.current || runtimeBridge.status !== 'running') return
      openingRef.current = true
      let field = 0
      let frozen = false
      try {
        const scan = await probe.scanHeap()
        if (!isMainRamPointer(scan.playerActor)) throw new Error(`Player actor is invalid (${hex(scan.playerActor)}).`)

        const effects = await nativeCall(FLD_ACT_GET_FIELD_EFFECTS, scan.playerActor)
        if (!isMainRamPointer(effects)) throw new Error(`FldAct_GetFieldEffects returned ${hex(effects)}.`)

        field = await nativeCall(FIELD_EFFECTS_GET_FIELD, effects)
        if (!isMainRamPointer(field)) throw new Error(`FieldEffects_GetField returned ${hex(field)}.`)

        const controllerType = await nativeCall(FIELD_GET_CONTROLLER_TYPE_ID, field)
        if (controllerType !== FIELDMAP_CTRL_GRID) {
          throw new Error(`Field controller ${controllerType} is not the normal grid controller.`)
        }

        const msgBg = await nativeCall(FIELD_GET_MSGBG_SYS, field)
        if (!isMainRamPointer(msgBg)) throw new Error(`Field_GetMsgBGSys returned ${hex(msgBg)}.`)

        console.info('[PokéRun interaction] YES/NO FIELD PATH READY', {
          actor: hex(scan.playerActor),
          effects: hex(effects),
          field: hex(field),
          msgBg: hex(msgBg),
        })

        await nativeCall(FIELDMAP_CTRL_GRID_SET_UPDATE_DISABLE, field, 1)
        frozen = true

        const menu = await nativeCall(MSG_BG_CREATE_YES_NO_MENU, msgBg, 0)
        if (!isMainRamPointer(menu)) throw new Error(`MsgBGPrinter_CreateYesNoMenu returned ${hex(menu)}.`)

        fieldRef.current = field
        menuRef.current = menu
        console.info('[PokéRun interaction] NATIVE YES/NO MENU OPEN', {
          field: hex(field),
          menu: hex(menu),
        })
      } catch (reason) {
        console.info('[PokéRun interaction] NATIVE YES/NO FAILED', {
          reason: reason instanceof Error ? reason.message : String(reason),
        })
        if (frozen && isMainRamPointer(field)) {
          try { await nativeCall(FIELDMAP_CTRL_GRID_SET_UPDATE_DISABLE, field, 0) } catch { /* best effort */ }
        }
      } finally {
        openingRef.current = false
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.code !== 'KeyX' && event.code !== 'KeyS') || event.repeat) return

      console.info('[PokéRun interaction] INTERACT KEY SEEN', {
        code: event.code,
        interactable,
        bridgeStatus: runtimeBridge.status,
        menuOpen: Boolean(menuRef.current),
        opening: openingRef.current,
        local: presence.local ? {
          mapId: presence.local.location.mapId,
          x: presence.local.x,
          y: presence.local.y,
          direction: presence.local.direction,
        } : null,
        remote: presence.remote ? {
          mapId: presence.remote.location.mapId,
          x: presence.remote.x,
          y: presence.remote.y,
          direction: presence.remote.direction,
        } : null,
      })

      if (!interactable || menuRef.current || openingRef.current) return
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      event.stopImmediatePropagation()
      void openMenu()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true, passive: false })

    const timer = window.setInterval(() => {
      const menu = menuRef.current
      if (!menu || pollingRef.current || runtimeBridge.status !== 'running') return
      pollingRef.current = true
      void (async () => {
        try {
          const result = await nativeCall(MSG_BG_YES_NO_MENU_MAIN, menu)
          if (result !== YES_NO_WAITING) {
            console.info('[PokéRun interaction] NATIVE YES/NO RESULT', { result })
            await closeMenu()
          }
        } catch (reason) {
          console.info('[PokéRun interaction] NATIVE YES/NO UPDATE FAILED', {
            reason: reason instanceof Error ? reason.message : String(reason),
          })
          await closeMenu()
        } finally {
          pollingRef.current = false
        }
      })()
    }, POLL_MS)

    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.clearInterval(timer)
      if (menuRef.current || fieldRef.current) void closeMenu()
    }
  }, [bridge, interactable, presence.local, presence.remote, rom.gameId, rom.sha256])

  return null
}
