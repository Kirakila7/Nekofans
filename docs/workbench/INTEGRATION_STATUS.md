# Unified daily workbench 0.28.0

The daily artifact is built from this repository. `config/daily-release.json` is the version authority; every app includes `Contents/Resources/WORKBENCH_BUILD.json` with the source commit and SHA-256 of every shipped source file. Historical QA checkouts and profiles are not release inputs.

## Included local workbench changes

- Shared native DSH accounts, plugins and sessions; Codex app-server workspace and read-only account/quota entry.
- Existing switch positions preserved. Picking a bound assistant updates its sidebar selection and right-hand engine together; DSH and Codex drafts stay separate.
- Compact companion chat, background-integrated draggable character, role appearances and the 0.27.4 child-session/helper animation rules.
- Workbench PR #5 native N.E.K.O. memory, including in-flight sync draining and canonical macOS recovery paths.
- Workbench PR #6 QQ/Bilibili coordination and routing, plus the local DeepSeek API preset and error-handling fixes.
- Native community identity handoff, screen companion and Bigfish pet-motion intake, with independent credentials and explicit screen-sharing consent.

Claude integration remains a proposal. Real supplier credentials, QQ/Bilibili binding and community identity sync are not established by synthetic test success.

Screen companion's optional private context uses confirmed legacy Chat API memories and recent Chat API messages; it does not yet recall the native N.E.K.O. memory added in Workbench PR #5.

## Public lobby (频道), pending

The workbench has a 频道 panel for the new N.E.K.O.Chat service (protocol: `N.E.K.O.Chat/docs/protocol.md`). It is uncommitted work on `feat/lobby-chat` and is not in the 0.28.0 daily artifact. Details are in `apps/neko-workbench/IMPLEMENTATION_v0.29.md`.

- Modules: `lobby-config`, `lobby-auth`, `lobby-client`, `lobby-frames`, `lobby-sanitize`, `lobby-avatars`, `lobby-cat`, `lobby-experience`, `lobby-controller` (main process) and `lobby-composer.js` plus `createLobbyView` in the workspace shell (renderer). Wired through `workbench:lobby` IPC with `assertWorkbenchCaller`, and `lobby`/`subscribeLobby` in the preload.
- Participation: off, assist (她帮你起草, user sends; default) or independent (her own cat messages by mention, owner-or-mention or free trigger). Both AI modes require the Chat API backend. Origin labels: `human`, `human_ai` (人＋AI 共同回复), cat (AI 独立发言).
- Memory write-back: summaries of lobby segments the user took part in go to the native memory through `recordSharedExperience` (`lobby:` item ids, `lobby-msg:` refs, `inferred`). Independent mode reads no memory; assist reads recall only.
- Isolation: companion chat keeps working when the lobby is unconfigured, offline, muted, failing to initialize or generating a suggestion.

Verified only with synthetic fixtures: injected fetch, fake WebSocket, a loopback OAuth callback server on port 0, fake model providers, fake clocks and temporary memory directories. The N.E.K.O.Chat backend has its own tests and a two-user smoke script (`scripts/ws_smoke.py`) against fake auth; the workbench has not been run end-to-end against that backend in this step.

Not verified:

- Real OAuth sign-in against auth.project-neko.cn. The public client `neko-chat-desktop-prod` (and `-dev`) is not registered yet, and whether Hydra accepts arbitrary loopback ports is unconfirmed.
- A production chat server. `NEKO_WORKBENCH_CHAT_URL` has no default, so the panel shows 频道服务未配置 until it is set.
- Real model behaviour: suggestion quality, independent replies, prompt-injection resistance, and whether summaries keep other people's words attributed. The memory worker's own fact extraction from lobby summaries is also untested.
- The Electron GUI with this panel; no QA instance was launched for this work.

## bigfish-pet intake

The GitHub PR list was inspected on 2026-10-28. It contains 14 PRs: 12 merged, 1 open and 1 draft. Issue #2 is not a PR.

| PR | Topic | Intake status |
| --- | --- | --- |
| #1 | N.E.K.O. v3 workbench/community and voice division | Existing integrated baseline |
| #3 | Main chat, lightweight memory and session/community entries | Existing baseline; memory superseded by workbench #5 |
| #4 | Embedded right-hand native community | Existing integrated baseline |
| #5 | Preserve chat replies and errors | Existing integrated baseline |
| #6 | Three role tiers and real task navigation | Existing baseline plus workbench role refinements |
| #7 | N.E.K.O. running cat choice | Existing integrated baseline |
| #8 | Animated appearances, custom images and cat sizing | Existing integrated baseline |
| #9 | Claude proportions and compact corner names | Existing integrated baseline |
| #10 | Pixel Claude/Gemini choices | Existing integrated baseline |
| #11 | Fish-care entry and embedded settings | Existing baseline plus workbench #6 coordination |
| #12 | Native community identity flow | Integrated; real account binding and synchronization still require verification |
| #13 | Subagent exploration and return | Integrated with later 0.27.4 role-specific behavior and bounded return expiry |
| #14 | Screen sharing and companion text feedback | Integrated with explicit destination confirmation and optional private-context consent; real screen and provider use remain unverified |
| #15 | Fountain spawning and DBSCAN | Integrated with bounded return expiry; real desktop motion and performance remain unverified |

The user explicitly requested intake of #14 and #15 after fixing their known issues. This work does not merge or close source PRs in the Bigfish repository. Workbench #7 remains a separate, unmerged change.

## Build and install

Run `node scripts/build-neko-daily.mjs --electron-zip <official darwin-arm64 Electron archive> --output <new staging directory>` from a committed source checkout. The archive must be a trusted official runtime; the build records its SHA-256 and performs local ad-hoc signature verification.

The download contains one app and one installer entry. Quit the old app, then run `安装日常版.command`. It replaces the same daily app path and prepares a locked memory environment under Application Support. Chat databases, persona files and encrypted account settings are not packaged or uploaded.

The installer links an existing canonical checkout to the daily workbench after checking its `origin` repository. Existing sessions keep their own directories; new default work uses that linked checkout. The local link file contains only the project path and repository URL.
