import fs from 'node:fs'

const path = 'src/multiplayer/games/White2DedicatedTrainerRuntime.tsx'
let source = fs.readFileSync(path, 'utf8')

const before = 'const MAP_STABLE_MS = 280\n'
const after = `// Transition validation: White 2 can publish the new map ID before the new\n// field scene has finished its entrance/fade setup. Give the actor scene a full\n// second to settle before creating/binding PokéRun's dedicated remote.\nconst MAP_STABLE_MS = 1200\n`

if (!source.includes(before)) {
  throw new Error('Expected MAP_STABLE_MS = 280 was not found; test may already be applied or branch changed.')
}

source = source.replace(before, after)
fs.writeFileSync(path, source)
console.log('Applied 1200 ms field-stability delay experiment.')
