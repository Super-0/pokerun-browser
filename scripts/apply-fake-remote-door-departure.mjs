import fs from 'node:fs'

const fakePath = 'src/multiplayer/debug/FakeRemotePeerPanel.tsx'
let fake = fs.readFileSync(fakePath, 'utf8')

const importBefore = `  type MultiplayerMessage,\n  type MultiplayerPlayer,\n`
const importAfter = `  type MultiplayerMessage,\n  type MultiplayerMapTransition,\n  type MultiplayerPlayer,\n`
if (!fake.includes(importBefore)) throw new Error('Fake peer protocol import anchor not found.')
fake = fake.replace(importBefore, importAfter)

const snapshotBefore = `  recordedFrames: number\n  recordedDurationMs: number\n}\n`
const snapshotAfter = `  recordedFrames: number\n  recordedDurationMs: number\n  doorCaptureArmed: boolean\n  capturedDoorTransition: MultiplayerMapTransition | null\n}\n`
if (!fake.includes(snapshotBefore)) throw new Error('Fake snapshot type anchor not found.')
fake = fake.replace(snapshotBefore, snapshotAfter)

const cloneBefore = `    location: { ...state.location },\n    worldPosition: state.worldPosition ? { ...state.worldPosition } : undefined,\n  }\n}\n`
const cloneAfter = `    location: { ...state.location },\n    worldPosition: state.worldPosition ? { ...state.worldPosition } : undefined,\n    transition: state.transition ? {\n      ...state.transition,\n      fromWorldPosition: state.transition.fromWorldPosition ? { ...state.transition.fromWorldPosition } : undefined,\n      toWorldPosition: state.transition.toWorldPosition ? { ...state.transition.toWorldPosition } : undefined,\n    } : undefined,\n  }\n}\n\nfunction cloneTransition(transition: MultiplayerMapTransition): MultiplayerMapTransition {\n  return {\n    ...transition,\n    fromWorldPosition: transition.fromWorldPosition ? { ...transition.fromWorldPosition } : undefined,\n    toWorldPosition: transition.toWorldPosition ? { ...transition.toWorldPosition } : undefined,\n  }\n}\n`
if (!fake.includes(cloneBefore)) throw new Error('clonePlayerState anchor not found.')
fake = fake.replace(cloneBefore, cloneAfter)

const fieldsBefore = `  private recordingMapId: MultiplayerPlayerState['location']['mapId'] | null = null\n  private recordedPath: RecordedPathFrame[] = []\n  private snapshot: FakeRemoteSnapshot = {\n`
const fieldsAfter = `  private recordingMapId: MultiplayerPlayerState['location']['mapId'] | null = null\n  private recordedPath: RecordedPathFrame[] = []\n  private doorCaptureArmed = false\n  private capturedDoorTransition: MultiplayerMapTransition | null = null\n  private snapshot: FakeRemoteSnapshot = {\n`
if (!fake.includes(fieldsBefore)) throw new Error('Fake peer field anchor not found.')
fake = fake.replace(fieldsBefore, fieldsAfter)

const initialSnapshotBefore = `    recordingPath: false,\n    recordedFrames: 0,\n    recordedDurationMs: 0,\n  }\n`
const initialSnapshotAfter = `    recordingPath: false,\n    recordedFrames: 0,\n    recordedDurationMs: 0,\n    doorCaptureArmed: false,\n    capturedDoorTransition: null,\n  }\n`
const snapshotOccurrences = fake.split(initialSnapshotBefore).length - 1
if (snapshotOccurrences !== 2) throw new Error(`Expected two fake snapshot initializer anchors, found ${snapshotOccurrences}.`)
fake = fake.split(initialSnapshotBefore).join(initialSnapshotAfter)

const joinResetBefore = `    this.readyRequested = false\n    this.update({ roomCode: normalized, gameStarted: false, hostState: null, fakeState: null, phase: \`JOINING \${normalized}\` })\n`
const joinResetAfter = `    this.readyRequested = false\n    this.doorCaptureArmed = false\n    this.capturedDoorTransition = null\n    this.update({\n      roomCode: normalized,\n      gameStarted: false,\n      hostState: null,\n      fakeState: null,\n      doorCaptureArmed: false,\n      capturedDoorTransition: null,\n      phase: \`JOINING \${normalized}\`,\n    })\n`
if (!fake.includes(joinResetBefore)) throw new Error('Fake peer join reset anchor not found.')
fake = fake.replace(joinResetBefore, joinResetAfter)

const doorMethodsAnchor = `  async walk(direction: MultiplayerDirection, tiles = 1) {\n`
const doorMethods = `  armDoorTransitionCapture() {\n    if (!this.startId || !this.hostState) {\n      this.update({ phase: 'WAITING FOR HOST GAME STATE' })\n      return\n    }\n    this.stopScript()\n    this.doorCaptureArmed = true\n    this.capturedDoorTransition = null\n    this.update({\n      doorCaptureArmed: true,\n      capturedDoorTransition: null,\n      phase: 'DOOR CAPTURE ARMED • WALK HOST THROUGH A BUILDING DOOR',\n    })\n  }\n\n  clearDoorTransitionCapture() {\n    this.doorCaptureArmed = false\n    this.capturedDoorTransition = null\n    this.update({\n      doorCaptureArmed: false,\n      capturedDoorTransition: null,\n      phase: 'DOOR TRANSITION CAPTURE CLEARED',\n    })\n  }\n\n  async replayCapturedDoorDeparture() {\n    const transition = this.capturedDoorTransition\n    const host = this.hostState\n    if (!transition || !this.startId || !host) {\n      this.update({ phase: 'CAPTURE A HOST DOOR TRANSITION FIRST' })\n      return\n    }\n    if (host.location.mapId !== transition.fromMapId) {\n      this.update({ phase: \`RETURN HOST TO MAP \${String(transition.fromMapId)} BEFORE REPLAY\` })\n      return\n    }\n\n    const generation = this.beginScript(\`REMOTE DOOR DEPARTURE • \${String(transition.fromMapId)} → \${String(transition.toMapId)}\`)\n    const fromWorld = transition.fromWorldPosition ?? worldFromGrid(transition.fromX, transition.fromY)\n    const toWorld = transition.toWorldPosition ?? worldFromGrid(transition.toX, transition.toY, fromWorld.y)\n    const replayTransition = cloneTransition(transition)\n    replayTransition.id = \`fake-door:\${this.playerId}:\${Date.now()}\`\n    replayTransition.detectedAt = Date.now()\n\n    // First place Player 2 at the exact White 2-approved final outside position.\n    // Keeping this visible briefly makes the departure timing easy to inspect.\n    this.publish({\n      location: { mapId: transition.fromMapId },\n      x: transition.fromX,\n      y: transition.fromY,\n      direction: transition.fromDirection,\n      movementState: 'idle',\n      worldPosition: { ...fromWorld },\n    })\n    await sleep(450)\n    if (generation !== this.scriptGeneration) return\n\n    // Publish the real destination plus explicit transition metadata. The local\n    // client remains on fromMapId, so its door runtime should animate the door\n    // while the dedicated remote actor leaves the local map.\n    this.publish({\n      location: { mapId: transition.toMapId },\n      x: transition.toX,\n      y: transition.toY,\n      direction: transition.toDirection,\n      movementState: 'idle',\n      worldPosition: { ...toWorld },\n      transition: replayTransition,\n    })\n\n    await sleep(900)\n    if (generation === this.scriptGeneration) {\n      this.finishScript(\`REMOTE DOOR DEPARTURE COMPLETE • NOW ON MAP \${String(transition.toMapId)}\`)\n    }\n  }\n\n${doorMethodsAnchor}`
if (!fake.includes(doorMethodsAnchor)) throw new Error('Fake peer walk method anchor not found.')
fake = fake.replace(doorMethodsAnchor, doorMethods)

const receiveBefore = `      this.hostPlayerId = message.playerId\n      this.hostState = message.state\n      this.captureRecordedHostState(message.state)\n      this.update({ hostState: message.state })\n`
const receiveAfter = `      this.hostPlayerId = message.playerId\n      this.hostState = message.state\n      this.captureRecordedHostState(message.state)\n\n      if (this.doorCaptureArmed && message.state.transition) {\n        this.doorCaptureArmed = false\n        this.capturedDoorTransition = cloneTransition(message.state.transition)\n        console.info('[PokéRun fake door] CAPTURED HOST TRANSITION', this.capturedDoorTransition)\n        this.update({\n          doorCaptureArmed: false,\n          capturedDoorTransition: this.capturedDoorTransition,\n          phase: \`CAPTURED DOOR • \${String(this.capturedDoorTransition.fromMapId)} → \${String(this.capturedDoorTransition.toMapId)}\`,\n        })\n      }\n\n      this.update({ hostState: message.state })\n`
if (!fake.includes(receiveBefore)) throw new Error('Fake peer GAME_STATE receive anchor not found.')
fake = fake.replace(receiveBefore, receiveAfter)

const activateBefore = `    this.fakeState = null\n    this.clearRecordedPath()\n    this.update({ gameStarted: true, fakeState: null, phase: 'GAME STARTED • WAITING FOR HOST POSITION' })\n`
const activateAfter = `    this.fakeState = null\n    this.clearRecordedPath()\n    this.doorCaptureArmed = false\n    this.capturedDoorTransition = null\n    this.update({\n      gameStarted: true,\n      fakeState: null,\n      doorCaptureArmed: false,\n      capturedDoorTransition: null,\n      phase: 'GAME STARTED • WAITING FOR HOST POSITION',\n    })\n`
if (!fake.includes(activateBefore)) throw new Error('Fake peer activateStart anchor not found.')
fake = fake.replace(activateBefore, activateAfter)

const uiAnchor = `    <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(53,84,107,0.35)' }}>\n      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>\n        <b>LEGAL PATH</b>\n`
const uiBlock = `    <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(53,84,107,0.35)' }}>\n      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>\n        <b>DOOR TRANSITION</b>\n        <span style={{ opacity: 0.75 }}>\n          {snapshot.doorCaptureArmed\n            ? 'ARMED'\n            : snapshot.capturedDoorTransition\n              ? \`\${String(snapshot.capturedDoorTransition.fromMapId)} → \${String(snapshot.capturedDoorTransition.toMapId)}\`\n              : 'NONE'}\n        </span>\n      </div>\n      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>\n        <button\n          disabled={controlsDisabled || snapshot.doorCaptureArmed || Boolean(snapshot.script)}\n          onClick={() => peer.armDoorTransitionCapture()}\n        >ARM NEXT HOST DOOR</button>\n        <button\n          disabled={controlsDisabled || !snapshot.capturedDoorTransition || snapshot.doorCaptureArmed || Boolean(snapshot.script)}\n          onClick={() => void peer.replayCapturedDoorDeparture()}\n        >REPLAY DEPARTURE</button>\n        <button\n          disabled={!snapshot.capturedDoorTransition && !snapshot.doorCaptureArmed}\n          onClick={() => peer.clearDoorTransitionCapture()}\n        >CLEAR DOOR</button>\n        <span/>\n      </div>\n      <div style={{ marginTop: 5, opacity: 0.68 }}>\n        Arm, walk the real trainer through a building door once, return to the outside map, then replay that exact White 2 transition as Player 2.\n      </div>\n    </div>\n\n${uiAnchor}`
if (!fake.includes(uiAnchor)) throw new Error('Fake peer legal-path UI anchor not found.')
fake = fake.replace(uiAnchor, uiBlock)

fs.writeFileSync(fakePath, fake)

const transitionPath = 'src/multiplayer/games/White2RemoteTransitionRuntime.tsx'
let transitionSource = fs.readFileSync(transitionPath, 'utf8')

const playBefore = `        const animation = await doors.playNearestDoor(world)\n        if (animation.handle) activeDoor = { handle: animation.handle, mapId: localMapId, startedAt: now }\n        lastWarning = ''\n`
const playAfter = `        const animation = await doors.playNearestDoor(world)\n        console.info('[PokéRun door] DOOR RESULT', {\n          mapId: localMapId,\n          matched: animation.matched,\n          handle: animation.handle,\n          world,\n        })\n        if (animation.handle) activeDoor = { handle: animation.handle, mapId: localMapId, startedAt: now }\n        lastWarning = ''\n`
if (!transitionSource.includes(playBefore)) throw new Error('Remote door playDoor anchor not found.')
transitionSource = transitionSource.replace(playBefore, playAfter)

const departureBefore = `      if (sameMap(local.location.mapId, transition.fromMapId)) {\n        await playDoor(transition.fromWorldPosition, local.location.mapId, now)\n        return\n      }\n`
const departureAfter = `      if (sameMap(local.location.mapId, transition.fromMapId)) {\n        console.info('[PokéRun door] REMOTE DEPARTURE', {\n          id: transition.id,\n          fromMapId: transition.fromMapId,\n          toMapId: transition.toMapId,\n          fromWorldPosition: transition.fromWorldPosition ?? null,\n        })\n        await playDoor(transition.fromWorldPosition, local.location.mapId, now)\n        return\n      }\n`
if (!transitionSource.includes(departureBefore)) throw new Error('Remote door departure anchor not found.')
transitionSource = transitionSource.replace(departureBefore, departureAfter)

fs.writeFileSync(transitionPath, transitionSource)
console.log('Applied fake remote door departure capture/replay harness and door diagnostics.')
