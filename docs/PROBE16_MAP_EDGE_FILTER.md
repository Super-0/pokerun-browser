# Probe 16 — White 2 Seamless Map Edges and Gate Filtering

Date: 2026-11-02
Branch: `mp/map-transition-recovery-v2`

## Proven seamless edge

White 2 zones 437 and 439 are a true same-field seamless boundary:

- 437 = Route 19
- 439 = Floccesy Town
- P1 keeps the same FieldActor and billboard across the map-ID flip.
- There is no `FLD_STATUS_BUSY_LOADING` field teardown.
- Native P2 can remain the same UID `0xFC` FieldCommActor, comm system, TCB and shadow while one player has crossed and the other has not.
- Probe 16 validated preservation in both directions, including multi-second map-ID mismatch windows with P2 continuously visible.

## Gate-intercepted geometric adjacency

The static matrix also places zones 427 and 437 beside each other, but normal gameplay does not cross directly:

- 427 = Aspertia City
- 438 = Aspertia Gate
- 437 = Route 19
- observed gameplay path: `427 -> 438 -> 437` and reverse.

The White 2 event data confirms reciprocal native warps `427 <-> 438 <-> 437`. Therefore a same-matrix geometric adjacency is not sufficient evidence that a boundary is directly traversable.

## Runtime registry rule

`runtime-boundary-export.mjs` now combines matrix adjacency with `warps.json`.

A geometric `A <-> B` boundary is quarantined when the ROM contains a reciprocal third-zone bridge `A <-> G <-> B`. This identifies route gates/tunnels without hardcoding individual pairs.

The exact tested-ROM anchors are validated during export:

- `427 <-> 437` must be quarantined through intermediate zone `438`.
- `437 <-> 439` must remain in the traversable registry.

The runtime registry is schema version 2 with `traversableOnly: true`. `White2FakeBoundaryNormalizer` rejects stale schema-v1 registries so an old generated file cannot accidentally let fake P2 bypass a gate.

Use `npm run white2:runtime-boundaries` to rebuild only the runtime boundary registry from already-extracted `generated/white2` data.
