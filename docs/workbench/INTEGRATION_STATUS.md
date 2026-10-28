# Local test workbench 0.28.5

The daily artifact is built from this repository. `config/daily-release.json` is the version authority; every app includes `Contents/Resources/WORKBENCH_BUILD.json` with the source commit and SHA-256 of every shipped source file. Historical QA checkouts and profiles are not release inputs.

## Included local workbench changes

- The main companion moves to the top of the persistent rail when its original workspace position is hidden, and returns when that position becomes visible. The existing character and chat draft are retained.
- Optional unified layout allows the sidebar and two main slots to place the native DSH workspace, existing community view and Bilibili view; one real view per external site is reused when moved. The companion community action respects this layout, and the original single-pane behavior remains when it is disabled. Synthetic isolated Electron tests cover geometry and view isolation; production DSH layout, real community login and Bilibili playback still need runtime verification.
- Clicking the main companion opens its interaction menu: community visiting reuses the existing embedded native community, while chat returns focus to the existing input. Dragging does not trigger the menu. The same menu is available from the companion in the collapsed rail; it does not start an autonomous visit, send a message, or invent a social memory.
- Workbench PR #13 (`c673090888176de81d10e72693fbd90c934720b1`) session shortcuts are included in the 0.28.4 local build. Each assistant row has a new-session button; the duplicate top-level plus and work/leisure switch are hidden. Unbound entries open their existing configuration. The Codex shortcut stays disabled while Codex testing is paused.
- Codex is temporarily unavailable and marked as testing. New Codex sessions, sends, model selection and account reads are disabled; saved sessions, seat bindings, credentials and choices remain intact. An already running turn retains stop and approval controls until it settles. DSH remains available. Re-enablement requires changing the explicit availability flag and verifying the native integration.
- Workbench PR #10 (`d5ff80619f23fa279c670e0355f954503ad23e27`) sidebar hide/expand ported onto the 0.28.1 Codex model-picker source (`4567f2e`). Collapse removes the sidebar grid track completely; a native-expand action appears above Bilibili in the persistent rail. Dragging the sidebar divider past the left threshold invokes native collapse. Only the side-rail source and its generated block were taken from the older trial branch. This is a local test build, separate from the published 0.28.1 release.
- Shared native DSH accounts, plugins and sessions; Codex app-server workspace and read-only account/quota entry.
- Existing switch positions preserved. Picking a bound assistant updates its sidebar selection and right-hand engine together; DSH and Codex drafts stay separate.
- Codex model and reasoning selectors read the native `model/list` catalog and send explicit choices with `turn/start`. Only advertised reasoning options are shown. Native-default mode preserves existing Codex configuration. Per-conversation choices are stored in a private local workbench file, independent of the DSH port; they do not rewrite native Codex configuration. Listing a model does not prove permission to execute it.
- New Codex tasks retain the created thread ID for follow-up messages. Failed sends preserve drafts and error feedback; missing catalog choices require explicit correction instead of silently switching models.
- Compact companion chat, background-integrated draggable character, role appearances and the 0.27.4 child-session/helper animation rules.
- Workbench PR #5 native N.E.K.O. memory, including in-flight sync draining and canonical macOS recovery paths.
- Workbench PR #6 QQ/Bilibili coordination and routing, plus the local DeepSeek API preset and error-handling fixes.

Claude integration remains a proposal. Real supplier credentials, QQ/Bilibili binding and community identity sync are not established by synthetic test success.

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
| #12 | Native community identity flow | Existing code baseline; real binding/sync still requires account verification |
| #13 | Subagent exploration and return | Existing baseline with later 0.27.4 role-specific behavior |
| #14 | Screen sharing and companion text feedback | **Pending. Draft; no patch applied in this consolidation.** |
| #15 | Fountain spawning and DBSCAN | **Pending. No additional patch applied.** Some related local animation work already exists and is preserved; that does not mark the whole source PR integrated. |

This local test build retains its 0.28.2 source baseline. Bigfish PRs #14 and #15 were separately integrated into the private Workbench GitHub main branch; this local build does not yet contain that integration. This work does not merge or close PRs in the Bigfish repository.

## Build and install

Run `node scripts/build-neko-daily.mjs --electron-zip <official darwin-arm64 Electron archive> --output <new staging directory>` from a committed source checkout. The archive must be a trusted official runtime; the build records its SHA-256 and performs local ad-hoc signature verification.

The download contains one app and one installer entry. Quit the old app, then run `安装日常版.command`. It replaces the same daily app path and prepares a locked memory environment under Application Support. Chat databases, persona files and encrypted account settings are not packaged or uploaded.

The installer links an existing canonical checkout to the daily workbench after checking its `origin` repository. Existing sessions keep their own directories; new default work uses that linked checkout. The local link file contains only the project path and repository URL.
