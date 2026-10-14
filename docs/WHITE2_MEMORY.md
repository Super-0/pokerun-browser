# Pokémon White 2 live-memory research

## Supported experimental fingerprint

The first live-state adapter is intentionally revision-specific.

| Field | Value |
| --- | --- |
| ROM SHA-256 | `54bec4091ba3eb89f4e1ee4e2f3421005835804376a34e5e45f3157e1f55625a` |
| NDS title | `POKEMON W2` |
| Game code | `IRDO` |
| Status | Manually validated for map, X, Y, and facing direction in a live development session |

Other White 2 fingerprints remain unsupported by the live-state adapter until
the same memory structure is independently verified for them.

## Live player structure

The validated reader resolves the player-position structure as:

```text
base = read32(0x02000024)
pos  = base + 0x36780
```

Fields used by multiplayer:

| Field | Read | Offset from `pos` | Validation |
| --- | --- | ---: | --- |
| Map ID | `u16` | `0x00` | Changed from 427 outside to 428 on entering a building |
| X | `u16` | `0x06` | Right `+1`, right `+1`, left `-1` |
| Z | `u16` | `0x0A` | Observed 1 outside and 0 inside; not currently transmitted |
| Y | `u16` | `0x0E` | Up `-1`, down `+1` |
| Facing | `u8` | `0x19` | Controlled direction changes; mapping below |

Facing values observed for this fingerprint:

| Raw | Normalized |
| ---: | --- |
| `0x00` | `north` |
| `0x40` | `west` |
| `0x80` | `south` |
| `0xC0` | `east` |

Controlled movement evidence from one outside location:

```text
MAP 427 • X 42 • Y 763 • Z 1
MAP 427 • X 43 • Y 763 • Z 1   right
MAP 427 • X 44 • Y 763 • Z 1   right
MAP 427 • X 43 • Y 763 • Z 1   left
MAP 427 • X 43 • Y 762 • Z 1   up
MAP 427 • X 43 • Y 763 • Z 1   down
```

Entering a building produced:

```text
MAP 428 • X 5 • Y 10 • Z 0
```

Direction research around the resolved structure also showed the direction byte
at `pos + 0x19` changing consistently with right/left/up/down while the known X
and Y fields changed as expected.

## Multiplayer use

`White2LiveStateAdapter` owns all White 2-specific addresses and converts the
raw fields into the generic multiplayer state:

```ts
{
  location: { mapId },
  x,
  y,
  direction,
}
```

The multiplayer game screen polls this adapter at roughly 10 Hz for the tested
fingerprint, publishes `GAME_STATE` only when map/X/Y/direction changes, and
shows both local and remote normalized state in the debug panel. `startId` and
sequence filtering remain responsible for rejecting stale/out-of-order state.

## Development panel workflow

`Arm9MemoryInspector` supplies development-only bounded snapshot/compare
primitives over `MelonDsBridge.readBytes()`. In a development build, the
**WHITE 2 ARM9 MEMORY RESEARCH** panel accepts an ARM9 hexadecimal start address
and bounded byte length (maximum `65536`). Captures remain local to the tab and
can be compared/exported for further research.

The experimental position probe in that panel exists for research visibility;
the actual multiplayer reader is isolated in `White2LiveStateAdapter`.

## Remaining validation

The current evidence is sufficient for the first same-revision multiplayer
state-exchange experiment, but broader support still requires:

1. Repeat the pointer/offset checks after a full emulator restart.
2. Repeat after save reload.
3. Exercise additional town/route/interior/floor transitions.
4. Verify whether the same structure applies to other White 2 regions/revisions.
5. Keep remote-avatar injection separate until normalized state exchange is stable.

Addresses from another revision must remain hypotheses until these tests pass
for that revision's exact SHA-256.
