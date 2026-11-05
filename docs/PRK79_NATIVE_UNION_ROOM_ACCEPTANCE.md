# PRK79 • Native Union Room invitation acceptance

## Current goal
Two actual White 2 cartridges, in separate melonDS tabs with **distinct
in-game trainer saves**, should complete a normal in-game invitation
without the communication error. This is a **temporary Union Room integration
test**; the eventual product will initiate native interactions from PokeRun's
regular overworld, not by moving Ace Trainer avatars around the Union Room.

## Confirmed before PRK79
- PRK75 isolation disables PokeRun's injected actor and input interception.
- PRK78 5 ms host polling enabled native authentication, association,
  bidirectional data, and correct names in the Union Room.
- The other player can receive an invitation, but accepting it fails.
- Native MP commands and replies are transmitted; host-side
  `MP_RecvReplies` was still a stub returning zero.

## PRK79 implementation
- AID 1–15 is carried as validated transport metadata on native MP replies.
- Ordinary Wi-Fi frames and host reply slots now use separate receive queues.
- Default empty replies do **not** count as successful replies.
- Reply entries are copied only into the proper 1024-byte host AID slot,
  with bounded queues, timestamp checks, and diagnostic counters.
- New protocol version rejects incompatible old/updated browser tabs.
- Native PRK79 stamp is `0x50524B45`; rebuilding melonDS is mandatory.
- No guest save writes, ROM modification, fake trainer spawn, RF channel
  forcing or fake acknowledgement success is performed by this patch.

## Remaining risk
The host's reply poll is called synchronously when its emulated MP
transmission completes. Browser `BroadcastChannel` delivery is
asynchronous, and a 5 ms JavaScript polling interval cannot run while a
single `processFrame` call blocks the event loop. So a populated reply
queue does not prove it arrived within the relevant native reply window.
Do **not** report PRK79 as fixed until normal invitation acceptance works.
Use `mpReplyHostPolls`, `mpRepliesQueued`, `mpReplyHostMatched`,
`mpReplyStale`, and `mpReplyEmpty` to determine the next step.

## Terminal commands

```bash
cd /workspaces/pokerun-browser
git pull --ff-only origin mp/map-transition-recovery-v2
git rev-parse --short HEAD
git submodule update --init --recursive
npm run build:melonds
npm run build
npm run dev:multiplayer
```

Close both old P1/P2 tabs before rebuilding so that no old JS/WASM pairing
or half-open radio session survives.

## Test (disposable saves only)
1. Launch both players with **PRK75 RADIO ISOLATION** checked.
2. Use two different trainer saves in separate, visible tabs at 1×.
3. Leave the low-latency **5 ms radio** option enabled on both sides.
4. Start local DS radio on both, enter the Union Room and confirm each
   trainer's name appears.
5. On **each** tab, press `1. CAPTURE BEFORE`, invite the other
   through the normal game menu, and have the other accept.
6. Press `2. CAPTURE AFTER` on both. Report whether the game succeeded
   or displayed a communication error, and paste both **PRK79
   INVITATION TEST RESULT** blocks.
7. STOP & CLEAR RADIO QUEUES before closing either game tab.

## How to interpret
- Host polls > 0, queued = 0: the reply path may not have delivered in time.
- Queued > 0, matched = 0, stale > 0: timestamps rejected replies.
- Queued > 0, matched = 0, stale = 0: missing AID selection or timing gap.
- Matched > 0 and game still errors: investigate native reply/ACK timing
  and game-visible protocol completion rather than assuming success.
- Both sides exchange names and data only: discovery is functioning, not
  sufficient to establish stable invitation acceptance.

## UI cleanup
The main DEV view now contains only native link start/stop, host reply
health, and a scoped invitation comparison. Old PRK63 C-Gear import controls,
one-emulator beacon-baseline surveys, detailed RF histograms, and standalone
PRK62 research are removed from the main workflow. Historical research and
diagnostic exports remain available in source/docs. Backup, party inspection,
and frame liveness are accessible only in expandable Advanced sections.
