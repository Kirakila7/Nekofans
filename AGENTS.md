# Workbench development and releases

This repository is the canonical source for the daily N.E.K.O. workbench. Make new changes here. Dated output checkouts are historical snapshots, not additional release targets.

- Preserve the existing engine switch locations. Selecting a bound assistant must update its sidebar filter and right-hand engine together.
- Preserve independent companion chat, engine accounts, drafts, sessions, and project memory. Never import QA profiles into the daily profile.
- Build daily artifacts from this checkout with `scripts/build-neko-daily.mjs`. Install only the app named in `config/daily-release.json`; keep one daily app and stop task-owned QA instances after verification.
- Keep `docs/workbench/INTEGRATION_STATUS.md` current. Pending source PRs are references, not authorization to apply their patches.
- Test with synthetic data and local model fixtures. Do not report fixture success as real supplier, OAuth, community, or QQ account verification.
- Exclude user data, logs, keys, local runtimes, and virtual environments from commits and release source manifests.
