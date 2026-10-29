# Local test workbench 0.28.16 (source, pending installation)

The daily artifact is built from this repository. `config/daily-release.json` is the version authority; every app includes `Contents/Resources/WORKBENCH_BUILD.json` with the source commit and SHA-256 of every shipped source file. Historical QA checkouts and profiles are not release inputs.

## Pending source changes

- The work area shows a project and session chooser instead of the unbound native landing page. A genuinely active DSH session can be resumed; starting a project-bound session retains its input and drafts. DSH selection and active-session fields are feature-detected internal APIs of the installed version; isolated DOM and Electron tests cover navigation and layout, while real DSH session transitions and older-version fallback still need verification.

- Community and Bilibili replace the chatroom inside the existing left content area while retaining its width and the right-hand work area. The rail or the return control switches back to chatroom or workspace navigation. The three-column configuration entry is removed; old saved layout data is preserved but not activated on startup. DOM tests cover navigation, drafts and collapsed-sidebar recovery; a temporary real DSH window showed the live community and Bilibili pages on the left. This does not verify login, identity linking or video playback. Opening settings while community identity authorization is pending cancels that attempt.
- Simplify the left rail and workbench settings: layout configuration moves into common settings; the fish entry is named for its existing settings action; existing tools remain available under a collapsed section, and native account/privacy/advanced settings remain accessible. Synthetic layout and settings tests plus a temporary DSH window verified the layout entry, focus return, tools expansion and native settings navigation. In legacy single-pane community mode, opening workbench settings still closes that community view; preserving it requires a separate native-view suspend/resume change.
- Workbench navigation, settings, account menu and role settings adapt to narrower containers. Native community and Bilibili panel toolbars wrap and their embedded views track the actual toolbar and pane dimensions. An isolated Electron test with real mouse input verified dragging across one and two native views while preserving page rendering, keyboard focus and chat divider reset. Actual remote site responsiveness, non-default zoom and interrupted drags outside the window remain to be checked in the daily app.

- In the default chatroom view the sidebar and coding area start at a 3:1 proportion excluding the rail, subject to minimum usable widths. Dragging resizes the grid continuously; keyboard arrows, Home/End and double-click are available. The adjusted width is session-only and resets on reopening. Isolated DOM and Electron fixtures exercise responsive geometry, actual DSH compact controls were visually checked, but native-view pointer routing still needs production verification. The startup picker stays inside the coding pane and uses a compact layout in narrow panes; the latter still needs production verification.
- Companion chat now distinguishes connection checks, an unconfigured provider and failures, retains unsent text and lets the user restore failed input without replacing an existing draft. Provider replies have not been tested with real credentials.
- Startup detects conflicting native DSH profile use and offers retry or exit without terminating the other process; a second daily-workbench launch focuses the existing instance. Conflict and single-instance behavior were tested in isolated fixtures, not against a live user session.

- On opening the workbench, the right-hand coding area offers a search and selection surface for known local work sessions and their projects. Opening a DSH session or starting a session for a known DSH project uses the existing native navigation; Codex remains disabled while its integration is testing. The project catalog is derived from known sessions and does not discover empty projects. A user-selected custom split dismisses the selector without replacing the saved layout. Synthetic DOM tests verify navigation and draft preservation; real-session and installed-app verification are pending.
- A workbench-styled control in the DSH coding area exposes the existing native Plugins, Automation and More navigation, preserving native handlers and plugin contributions. DOM checks verify the adapter; real-window positioning and native service behavior still need verification.

## Included local workbench changes

- Each workbench opening starts with the chatroom sidebar and a single coding area. Community and Bilibili replace the sidebar content while the coding area remains visible; previously saved multi-pane data is retained without activating it.
- The left rail opens a static chatroom preview by default in the existing sidebar. A separate rail control returns to workspace navigation; companion and account controls remain mounted. Any configured native community or Bilibili sidebar view is temporarily hidden and restored when returning to workspace, without changing the saved layout or the main panels. The preview does not connect to a chat service or show real members or messages.
- Interaction and accessibility refinements, with layout, regions, characters and the light-blue palette unchanged. Enabled controls show hover and press states; disabled controls (including Codex, which stays 测试中 and unavailable) show none. Keyboard focus rings are 2px. Async saves expose `aria-busy` and cannot be submitted twice. The session list announces loading and errors. Low-contrast text and buttons now use darker shades of the same hues.
- Unified layout configuration is easier to understand. The ▤ dialog shows what each region currently holds, labels the sidebar choice 工作区导航, and offers 不显示 to return two panes to one (at least one main pane always remains). Escape closes the dialog. The divider supports arrow keys, Home/End and double-click reset, and reports its value to assistive technology. Drop zones highlight the target region. Panel headers show refresh, copy and error states that the native site view previously covered. A failed save reverts to the last saved layout. The persisted layout format is unchanged. Synthetic JSDOM tests cover these controls. Real community login, Bilibili playback and production DSH layout were not verified in this change.

- When its original workspace position is hidden, the main companion moves into the persistent rail's empty area, where it can roam or be dragged; it returns when the original position is visible. The existing character, interaction menu and chat draft are retained, and reduced-motion settings stop automatic movement.
- Channel startup protects newer start/pause actions from stale status responses.
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
- Native community identity handoff, screen companion and Bigfish pet-motion intake, with independent credentials and explicit screen-sharing consent.

Claude integration remains a proposal. Real supplier credentials, QQ/Bilibili binding and community identity sync are not established by synthetic test success.

Screen companion's optional private context uses confirmed legacy Chat API memories and recent Chat API messages; it does not yet recall the native N.E.K.O. memory added in Workbench PR #5.

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

The private Workbench main already contains the #14 and #15 integration above; this branch preserves those existing changes without newly applying the Bigfish patches. This does not merge or close source PRs in the Bigfish repository. Workbench #7 remains a separate, unmerged change.

## Build and install

Run `node scripts/build-neko-daily.mjs --electron-zip <official darwin-arm64 Electron archive> --output <new staging directory>` from a committed source checkout. The archive must be a trusted official runtime; the build records its SHA-256 and performs local ad-hoc signature verification.

The download contains one app and one installer entry. Quit the old app, then run `安装日常版.command`. It replaces the same daily app path and prepares a locked memory environment under Application Support. Chat databases, persona files and encrypted account settings are not packaged or uploaded.

The installer links an existing canonical checkout to the daily workbench after checking its `origin` repository. Existing sessions keep their own directories; new default work uses that linked checkout. The local link file contains only the project path and repository URL.
