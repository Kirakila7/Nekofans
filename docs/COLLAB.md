# Parallel work rules

Applies to every agent or session that writes code in `neko-fish/`.

## Ownership

- Each task owns an explicit list of files. A task edits only its own files.
- Shared files have one owner, the coordinator:
  - `packages/*/src/index.ts`
  - `packages/app-contracts/**`
  - `packages/character-runtime/src/schema.ts`
  - `services/neko-memory/launcher.py` (task routes go in `services/neko-memory/routes_<task>.py`, auto-loaded by the launcher)
  - this file
- A task that needs a shared-file change writes its module in its own file and states the required export or route in its report. The coordinator applies it.
- New public types go in `packages/app-contracts/src/` (coordinator) before tasks that consume them start.

## Shared state

- `app.sqlite` schema is defined only in `packages/character-runtime/src/schema.ts`. Other modules open the database through `Character.open` and add no `CREATE TABLE`.
- Tests never write to the repo or cwd. Each test uses its own `mkdtemp` directory and removes it in `after`/`finally`.

## Ports

`node --test` runs test files in parallel, so every test file gets its own port.

| Range | Use |
|---|---|
| 59005 | `tests/character-runtime/identity.test.ts` mock |
| 59006 | `tests/memory-adapter/commit-dedup.test.ts` mock |
| 59007 | `tests/memory-adapter/recall.test.ts` mock |
| 59010 | `tests/integration/full-stack.test.ts` launcher |
| 59020 | `tests/memory/rename-flow.test.ts` launcher |
| 59011-59016, 59021-59026 | launcher sibling ports for the two launcher tests above |
| 59030 | `tests/memory/recall-real.test.ts` launcher (F07); siblings 59031-59036 |
| 59040-59046 | free (was F08 correction-backup-real, removed in framework v1) |
| 59050-59059 | F09 pet window / overlay (tests, local static servers, Electron debug ports) |
| 59060-59069 | F10 voice input (ASR mocks, launcher 59060 + siblings 59061-59066) |
| 59070-59079 | F11 voice output (TTS mocks, playback harness) |
| 59080 | `tests/memory/free-llm-live.test.ts` launcher (opt-in NEKO_LIVE_FREE=1); siblings 59081-59086 |
| 59087-59099 | free; the coordinator assigns one per new test file |

The launcher reads `NEKO_MEMORY_SERVER_PORT` and `NEKO_DATA_ROOT` from the environment; tests must set both.

## Verification

- Current framework v1: run from `neko-fish/` with `npm test`. This includes the local v1 acceptance chain and reusable offline modules.
- The archived NEKO and voice integration suites are separate opt-in work; do not start those services for the v1 default app.
- A v1 task is done only when the v1 suite passes, not just its own file. Report excluded legacy/live checks explicitly.

## Git and worktrees

- Each task in a batch runs in its own git worktree on its own branch, cut from `main`. Worktrees live under `.claude/worktrees/` (ignored).
- A task commits only on its own branch, after the full suite passes there. It never pushes, merges, rebases or touches `main`.
- At batch close the coordinator merges each branch into `main`, runs the full suite, and makes one commit per batch.
- `services/neko-memory/vendor/` is a pinned upstream snapshot (`config/upstream-lock.json`). Do not edit it.
