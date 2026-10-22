import fs from 'node:fs'

const path = 'src/multiplayer/games/White2DedicatedTrainerRuntime.tsx'
let source = fs.readFileSync(path, 'utf8')

const oldBlock = `      const directionKnowledge = knowledge[remote.direction]
      const requestedMotionKind = remoteMotionKind
      const fallbackWalkSequence = directionKnowledge.walkSequence.length
        ? directionKnowledge.walkSequence
        : bootstrapWalkSequence(knowledge, remote.direction)
      const sequence = requestedMotionKind === 'run'
        ? (directionKnowledge.runSequence.length ? directionKnowledge.runSequence : fallbackWalkSequence)
        : fallbackWalkSequence

      if (moving && sequence.length) {
        if (!remoteWasMoving || activeRemoteMotionKind !== requestedMotionKind) {
          remoteSequenceIndex = 0
          remoteStepStartedAt = now
        }
        activeRemoteMotionKind = requestedMotionKind
`

const newBlock = `      const directionKnowledge = knowledge[remote.direction]
      const requestedMotionKind = remoteMotionKind
      const fallbackWalkSequence = directionKnowledge.walkSequence.length
        ? directionKnowledge.walkSequence
        : bootstrapWalkSequence(knowledge, remote.direction)
      const walkSequence = fallbackWalkSequence
      const runSequence = directionKnowledge.runSequence.length
        ? directionKnowledge.runSequence
        : fallbackWalkSequence
      const sequence = requestedMotionKind === 'run' ? runSequence : walkSequence

      if (moving && sequence.length) {
        if (!remoteWasMoving) {
          remoteSequenceIndex = 0
          remoteStepStartedAt = now
        } else if (activeRemoteMotionKind !== requestedMotionKind) {
          const previousSequence = activeRemoteMotionKind === 'run' ? runSequence : walkSequence
          if (previousSequence.length) {
            const previousIndex = remoteSequenceIndex % previousSequence.length
            const previousStep = previousSequence[previousIndex]
            const previousProgress = Math.min(
              0.999,
              Math.max(0, (now - remoteStepStartedAt) / Math.max(1, previousStep.holdMs)),
            )
            const cyclePhase = (previousIndex + previousProgress) / previousSequence.length
            const mappedPhase = cyclePhase * sequence.length
            const mappedIndex = Math.min(sequence.length - 1, Math.floor(mappedPhase))
            const mappedProgress = mappedPhase - Math.floor(mappedPhase)
            remoteSequenceIndex = mappedIndex
            remoteStepStartedAt = now - mappedProgress * sequence[mappedIndex].holdMs
          } else {
            remoteSequenceIndex = 0
            remoteStepStartedAt = now
          }
        }
        activeRemoteMotionKind = requestedMotionKind
`

if (!source.includes(oldBlock)) {
  throw new Error('Expected remote gait playback block was not found; branch may have changed.')
}

source = source.replace(oldBlock, newBlock)
fs.writeFileSync(path, source)
console.log('Applied gait phase-preservation experiment.')
