# Development and testing

Start with [AGENTS.md](AGENTS.md) and [HANDOFF.md](HANDOFF.md). Use Node.js 24 and the checked-in lockfile. The test server uses a fixed loopback port and a fresh Chromium context per test. No cartridge, battery save, native build or submodules are required for the standard checks.

## Windows PowerShell

Use the actual checkout directory in the first command. If the branch is on another machine only, transfer the commits as described below first.

```powershell
Set-Location 'C:\src\pokerun-browser'
if (-not (Test-Path .\package.json)) { throw 'Open the PokéRun checkout first.' }
git status -sb
git switch tooling/shared-dev-tests
node --version
npm.cmd ci
npx.cmd playwright install chromium
npm.cmd run verify
npm.cmd run test:integration
```

To run the standard checks separately in Windows, use `npm.cmd run test:unit`, `npm.cmd run build` and `npm.cmd run test:browser`. On macOS or Linux, use `npm` and `npx` in the same commands. On a fresh Linux/WSL desktop or CI image install browser system dependencies with `npx playwright install --with-deps chromium`. Open `playwright-report/index.html` for the most recent run. Failure traces and screenshots are under `test-results/`; open a trace with `npx.cmd playwright show-trace PATH_TO_TRACE` on Windows. A second run on the same port checks teardown. If port 4180 is occupied, close the owner or set `POKERUN_TEST_PORT` to an unused port.

## Test matrix

| Tier | Command | Assertions and boundaries |
| --- | --- | --- |
| Fast unit | `npm run test:unit` | Protocol version and malformed envelopes; synthetic timing shows which decisions were stale and separates delivery from clock estimates. |
| Browser smoke | `npm run test:smoke` | Launcher blocks without saves, enables PRK75 isolation by default, and is cross-origin isolated. Two browser pages auto-pair in the same context and cannot ready or start without cartridges; a third page in a fresh context stays isolated. |
| Deterministic integration | `npm run test:integration` | Real IndexedDB and storage stores. Two independent batteries with one shared synthetic cartridge survive reload; a fresh context sees neither. Legacy typed array and ArrayBuffer records restore. |
| Standard regression | `npm run verify` | Runs unit tests, TypeScript/Vite production build and all ROM-free browser checks. The GitHub workflow uses this command and uploads the ROM-free HTML report. |
| Native boundary | `npm run build:melonds`, then `npm run test:native` | Builds the pinned runtime and checks the actual browser stamp, exports, reply enqueue trace and monotonic clock without a ROM. |
| Private real gameplay | `npm run test:white2:prepare`, then `npm run test:white2` | Verified White 2, two real emulators, distinct trainer IDs and disposable battery slots, 1× DS frame health, native association and a bounded greeting attempt with paired evidence. Follow the [runbook](docs/PRK80_GREETING_RUNBOOK.md). |

Use a targeted command while iterating, such as `npm.cmd run test:browser -- -g "legacy"`. Browser tests should wait for observable conditions. A feature test should exercise its normal entry point, distinguish the two clients, and assert state before and after the action. Use short synthetic byte arrays when testing storage rather than copying actual saves.

## Clean WSL/Linux native build

Clone into the Linux filesystem inside WSL. The desktop run from a Windows-mounted checkout failed on the first source patch. The native wrapper temporarily patches and resets its submodule, so keep local submodule work in a separate checkout. Set the clone URL or local bundle to the location carrying the tooling commits.

```bash
sudo apt-get update
sudo apt-get install -y git cmake make python3
mkdir -p ~/src
cd ~/src
git clone https://github.com/Super-0/pokerun-browser.git pokerun-native
cd pokerun-native
# For a local-only branch, fetch the reviewed bundle first.
# git fetch /mnt/c/src/pokerun-tooling.bundle tooling/shared-dev-tests:refs/heads/tooling/shared-dev-tests
git switch tooling/shared-dev-tests
git merge-base --is-ancestor bf2c494 HEAD
git submodule update --init --recursive
git -C third_party/ds-anywhere status --short
test -z "$(git -C third_party/ds-anywhere status --porcelain)" || exit 1

git clone https://github.com/emscripten-core/emsdk.git ~/src/pokerun-emsdk
~/src/pokerun-emsdk/emsdk install 3.1.74
~/src/pokerun-emsdk/emsdk activate 3.1.74
source ~/src/pokerun-emsdk/emsdk_env.sh
emcc --version
node --version
npm ci
npm run build:melonds
npm run build
npx playwright install --with-deps chromium
npm run test:native
```

With the Windows checkout at `C:\src\pokerun-browser`, copy the paired outputs from the Linux checkout at the same Git SHA. Then run `npm.cmd run test:native` on Windows.

```bash
mkdir -p /mnt/c/src/pokerun-browser/public/emulators/melonds
cp public/emulators/melonds/wasmemulator.{js,wasm} /mnt/c/src/pokerun-browser/public/emulators/melonds/
```

A stale stamp, failed patch, missing runtime, inaccessible Vite port or failing browser setup is a setup failure. Record that before interpreting gameplay. Rebuild and copy both artifacts together.

## Continue in Work or ordinary ChatGPT

1. Review `git status -sb`, `git diff --check`, the staged paths and the latest handoff. Commit only reviewed source, synthetic tests and sanitized notes. Record `git rev-parse HEAD`. Share the Git branch through the normal remote when authorized, or transfer a Git bundle containing only committed objects.
2. If the tooling branch is local only, from the worktree run `git bundle create /path/to/pokerun-tooling.bundle tooling/shared-dev-tests ^bf2c494`. On another checkout that already has `bf2c494`, run `git bundle verify /path/to/pokerun-tooling.bundle` and `git fetch /path/to/pokerun-tooling.bundle tooling/shared-dev-tests:refs/heads/tooling/shared-dev-tests`. If a desktop branch with that name exists, fetch into a separate ref and compare histories before integrating. Do not force-update it.
3. In Work or regular ChatGPT paste the sanitized [HANDOFF.md](HANDOFF.md), the branch/SHA and one intended next check. If ChatGPT lacks a terminal, ask it for a patch and exact commands. Apply and run those locally, paste only sanitized results, then commit from the checkout. Private fixtures and profiles must be provisioned locally and stay outside the bundle.

Suggested restart prompt:

> Continue PokéRun on tooling/shared-dev-tests at SHA ____. Read AGENTS.md, DEVELOPMENT.md, HANDOFF.md and the linked runbook. Use the next single hypothesis in the handoff. State the observable reproducer and stopping condition. If you cannot run commands, give me the patch and Windows npm.cmd commands and wait for my sanitized results.
