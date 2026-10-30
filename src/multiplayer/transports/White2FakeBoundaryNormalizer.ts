import type { MultiplayerDirection, MultiplayerMessage, MultiplayerPlayerState } from '../core/protocol'

type BoundaryEdge = {
  fixedAxis: 'x' | 'y'
  fixedCoordinate: number
  spanAxis: 'x' | 'y'
  spanStart: number
  spanEnd: number
}

type BoundaryTrigger = {
  matrixId: number
  sourceZoneId: number
  destinationZoneId: number
  direction: MultiplayerDirection
  sourceEdge: BoundaryEdge
  step: { x: number; y: number }
}

type BoundaryIndex = {
  schemaVersion: number
  safeOnly: boolean
  triggerCount: number
  byZone: Record<string, BoundaryTrigger[] | undefined>
}

type CompactState = {
  mapId: number | string
  x: number
  y: number
}

let boundaryIndex: BoundaryIndex | null = null
const lastFakeState = new Map<string, CompactState>()

void fetch('/dev-generated/white2-boundary-trigger-index.json', { cache: 'no-store' })
  .then(async response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const parsed = await response.json() as BoundaryIndex
    if (parsed.schemaVersion !== 1 || !parsed.safeOnly || typeof parsed.byZone !== 'object') {
      throw new Error('unexpected registry schema')
    }
    boundaryIndex = parsed
    console.info('[PokéRun static boundaries] LOADED', { triggers: parsed.triggerCount })
  })
  .catch(reason => {
    console.info('[PokéRun static boundaries] registry unavailable; run white2:extract before multiplayer dev', reason)
  })

function movementDirection(previous: CompactState, current: MultiplayerPlayerState): MultiplayerDirection | null {
  const dx = current.x - previous.x
  const dy = current.y - previous.y
  if (dx === 0 && dy === -1) return 'north'
  if (dx === 0 && dy === 1) return 'south'
  if (dx === -1 && dy === 0) return 'west'
  if (dx === 1 && dy === 0) return 'east'
  return null
}

function pointOnEdge(edge: BoundaryEdge, x: number, y: number) {
  const fixedValue = edge.fixedAxis === 'x' ? x : y
  const spanValue = edge.spanAxis === 'x' ? x : y
  return fixedValue === edge.fixedCoordinate
    && spanValue >= edge.spanStart
    && spanValue <= edge.spanEnd
}

function matchingTrigger(previous: CompactState, current: MultiplayerPlayerState) {
  if (!boundaryIndex || typeof previous.mapId !== 'number') return null
  const direction = movementDirection(previous, current)
  if (!direction) return null
  const candidates = boundaryIndex.byZone[String(previous.mapId)] ?? []
  return candidates.find(trigger =>
    trigger.direction === direction
    && trigger.step.x === current.x - previous.x
    && trigger.step.y === current.y - previous.y
    && pointOnEdge(trigger.sourceEdge, previous.x, previous.y)
  ) ?? null
}

/**
 * Development-only correction for the manual fake P2 controller. The controller
 * deliberately knows nothing about White 2 ROM structure; this transport layer
 * applies the validated static boundary registry to its normal GAME_STATE packets.
 * The state object is mutated in place so FakeRemoteDoorPeer's own authoritative
 * fakeState advances to the destination zone as well.
 */
export function normalizeWhite2FakeBoundaryMessage(message: MultiplayerMessage) {
  if (message.type !== 'GAME_STATE' || !message.senderId.startsWith('fake-remote-')) return

  const state = message.state
  const previous = lastFakeState.get(message.senderId)

  // Explicit door/warp scripts already own their map change. Never reinterpret them.
  if (state.transition) {
    lastFakeState.set(message.senderId, { mapId: state.location.mapId, x: state.x, y: state.y })
    return
  }

  if (previous) {
    // moveOneTile publishes one final idle packet from its pre-move snapshot. If
    // the preceding moving packet crossed a boundary, keep the canonical map ID.
    if (
      state.x === previous.x
      && state.y === previous.y
      && state.location.mapId !== previous.mapId
    ) {
      state.location.mapId = previous.mapId
    } else if (state.location.mapId === previous.mapId) {
      const trigger = matchingTrigger(previous, state)
      if (trigger) {
        state.location.mapId = trigger.destinationZoneId
        console.info('[PokéRun static boundaries] FAKE P2 MAP EDGE', {
          fromMapId: trigger.sourceZoneId,
          toMapId: trigger.destinationZoneId,
          direction: trigger.direction,
          from: { x: previous.x, y: previous.y },
          to: { x: state.x, y: state.y },
          matrixId: trigger.matrixId,
        })
      }
    }
  }

  lastFakeState.set(message.senderId, { mapId: state.location.mapId, x: state.x, y: state.y })
}
