import fs from 'node:fs'

const path = 'src/multiplayer/games/White2DoorTransition.ts'
let source = fs.readFileSync(path, 'utf8')

const before = `      const propType = await this.call(\n        FIELD_PROP_HOLDER_GET_PROP_TYPE,\n        holder,\n        0,\n        0,\n        0,\n        'FieldChunkPropHolder_GetPropType',\n      )\n`

const after = `      const propType = await this.call(\n        FIELD_PROP_HOLDER_GET_PROP_TYPE,\n        propSystem,\n        holder,\n        0,\n        0,\n        'FieldChunkPropHolder_GetPropType',\n      )\n`

if (!source.includes(before)) {
  throw new Error('Expected FieldChunkPropHolder_GetPropType call shape was not found; the fix may already be applied or the source changed.')
}

source = source.replace(before, after)
fs.writeFileSync(path, source)
console.log('Fixed FieldChunkPropHolder_GetPropType(system, holder) native call signature.')
