# Local source consolidation — 2026-11-01

The integration destination is `codex/unified-local-work-20261101` in the
`neko-workbench-windows` checkout, based on main `55ba491`. This source
integration does not build, install or publish a release.

## Included sources

The local inventory covers 101 changed-file entries across seven dirty
worktrees. Counts include duplicate files across worktrees. Older full-file
snapshots were compared with the current implementation instead of replacing
newer main code wholesale.

| Source | Entries | Integration decision |
| --- | ---: | --- |
| Windows candidate | 13 | Retain the Windows-first layout, themed native caption controls, fullscreen IPC, source checks and isolated native QA. |
| Original workbench | 48 | 24 files already match; 22 match main history and have subsequent fixes. Its memory/settings menu is already present in current main. Preserve the remaining diary adapter as inactive source. |
| Old running preview | 10 | Retain newer native markers, sidebar/account ownership, collapsed rail and measured input placement. Update the side-rail DOM fixture to expect the current 72px collapsed rail. Keep historical integration notes as history. |
| Visits RTC | 14 | Nine files already match. Retain current deployed-server compatibility, stricter identity/expiry checks and updated smoke coverage/documentation in the five remaining files. |
| Visits session | 5 | All files already match. |
| Visits social | 6 | One file already matches. Retain deployed identity/Connect compatibility and the newer OAuth callback/retry coverage. |
| Visits UI | 5 | Three files already match. Retain the newer authentication feedback and its tests in the remaining two files. |

## DeepSeek repair

Read stash `b17894abda574f97999bd06ee0df4471d8eb172a`, including its two
untracked gateway files, and merge its source changes against the current
implementation. Regenerate the embedded client from the merged sources.

- The lobby can use the selected DeepSeek account backend through a dedicated
  account bridge, with independent turns and cancellation. It does not reuse
  private chat history, turn locks or memory extraction. The public provider
  exports only streaming chat; RPC methods have an explicit allowlist.
- Quoting a cat inserts an actual visible mention. Failed sends and cancelled
  quotes retain the draft; inserting a mention never truncates a full draft.
- Preserve current opt-in account memory, QQ/Fish session privacy filtering,
  independent video views, Chat/Work navigation and Windows caption controls
  while resolving the older stash conflicts.
- Keep both stash entries. In particular, historical recovery stash
  `ac30814148dcdcf7b6c63f637b6f7c2fcb430c82` is not applied.

`WhaleDiaryMemoryAdapter` is retained for source completeness but is not wired
into the default memory controller. Its synthetic tests cover candidate/evidence
labels, replay/restart, read-only source files, revisions, tombstones and binding
validation. The native memory provider remains the default.

## Recovery and validation

Before integration, all seven worktrees were copied to the ignored local
`_archive/local-consolidation-20261101` directory, with binary patches, file
copies, inventory hashes and the stash delta. `final-classification.json`
records the disposition of every inventoried entry. Original source worktrees
and stash objects remain available; no reset, stash pop or history rewrite was
performed. The existing preview launcher targets the Windows checkout and
retains its previous account, data and workspace paths. Its running window was
not restarted.

Validation: 1,043 tests total, 1,031 passed, zero failed and 12 skipped; 227
workbench source syntax checks and skin/generated-client checks pass. The
side-rail DOM check passes. Actual Electron/main with a disposable empty profile
passes Chat/Work, both themes and 100%, 125% and 150% page zoom without taking
foreground focus. No production login, supplier reply, channel send, physical
caption-button acceptance, macOS device test or installer build is claimed.
