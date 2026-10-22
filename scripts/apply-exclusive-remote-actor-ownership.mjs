import fs from 'node:fs'

const path = 'src/multiplayer/games/White2DedicatedTrainerRuntime.tsx'
let source = fs.readFileSync(path, 'utf8')

if (!source.includes('const ACTOR_TCB = 0x84')) {
  const anchor = 'const ACTOR_WPOS = 0x44\n'
  if (!source.includes(anchor)) throw new Error('ACTOR_WPOS anchor not found.')
  source = source.replace(anchor, anchor + 'const ACTOR_TCB = 0x84\n')
}

if (!source.includes('const GFL_TCB_REMOVE = 0x0203a6d4')) {
  const anchor = 'const FLDACT_GET_BLACT_IDX = 0x02167240\n'
  if (!source.includes(anchor)) throw new Error('FLDACT_GET_BLACT_IDX anchor not found.')
  source = source.replace(
    anchor,
    anchor
      + 'const GFL_TCB_REMOVE = 0x0203a6d4\n'
      + 'const FLDACT_SET_SHADOW_GROUP = 0x0216784c\n'
      + 'const FLDACT_SET_FORCE_OFF_SHADOW = 0x0216787c\n',
  )
}

if (!source.includes('async function detachDedicatedActorNativeUpdate')) {
  const anchor = '    async function detachDedicatedBillboardAnimation(current: DedicatedBinding) {'
  const index = source.indexOf(anchor)
  if (index < 0) throw new Error('detachDedicatedBillboardAnimation anchor not found.')

  const helper = `    async function detachDedicatedActorNativeUpdate(current: DedicatedBinding) {\n      // PokéRun already owns the dedicated remote actor's position and BlAct.\n      // Remove White 2's per-actor TCB so its native move/draw callback cannot\n      // restore the underlying NPC model after the remote changes maps.\n      const forceShadow = await runtimeBridge.callArm9Thumb4(\n        FLDACT_SET_FORCE_OFF_SHADOW,\n        current.actorAddress,\n        1,\n        0,\n        0,\n        NATIVE_STACK_RESERVE,\n      )\n      if (forceShadow.status !== 1) {\n        throw new Error(\`FldAct_SetForceOffShadow failed with status \${forceShadow.status} at PC \${hex(forceShadow.pc)}.\`)\n      }\n\n      const shadowGroup = await runtimeBridge.callArm9Thumb4(\n        FLDACT_SET_SHADOW_GROUP,\n        current.actorAddress,\n        0,\n        0,\n        0,\n        NATIVE_STACK_RESERVE,\n      )\n      if (shadowGroup.status !== 1) {\n        throw new Error(\`FldAct_SetShadowGroup failed with status \${shadowGroup.status} at PC \${hex(shadowGroup.pc)}.\`)\n      }\n\n      const tcb = await runtimeBridge.read32(current.actorAddress + ACTOR_TCB)\n      if (isMainRamPointer(tcb)) {\n        const removed = await runtimeBridge.callArm9Thumb4(\n          GFL_TCB_REMOVE,\n          tcb,\n          0,\n          0,\n          0,\n          NATIVE_STACK_RESERVE,\n        )\n        if (removed.status !== 1) {\n          throw new Error(\`GFL_TCBRemove failed with status \${removed.status} at PC \${hex(removed.pc)}.\`)\n        }\n        await runtimeBridge.write32(current.actorAddress + ACTOR_TCB, 0)\n      }\n\n      console.info('[PokéRun lifecycle] REMOTE NATIVE UPDATE DETACHED', {\n        actor: current.actorAddress,\n        tcb,\n      })\n    }\n\n`

  source = source.slice(0, index) + helper + source.slice(index)
}

const bindBefore = `      await detachDedicatedBillboardAnimation(next)\n      const world = remote.worldPosition\n`
const bindAfter = `      await detachDedicatedBillboardAnimation(next)\n      await detachDedicatedActorNativeUpdate(next)\n      const world = remote.worldPosition\n`

if (source.includes(bindBefore)) {
  source = source.replace(bindBefore, bindAfter)
} else if (!source.includes('await detachDedicatedActorNativeUpdate(next)')) {
  throw new Error('bindDedicatedActor ownership-transfer anchor not found.')
}

fs.writeFileSync(path, source)
console.log('Detached the dedicated remote FieldActor native TCB and disabled its native shadow; PokéRun now owns its updates exclusively.')
