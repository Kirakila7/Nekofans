# N.E.K.O. workbench adapter

This directory vendors the pinned MIT upstream named in UPSTREAM.json. README.md,
NOTICE.md, LICENSE and originalSha256 preserve the upstream record. This is a
locally adapted copy, not an unmodified upstream release.

Local changes:

- Isolate B站 credentials, persona, logs and diaries in the current fish workspace;
  preserve the actual DSH profile for native session storage.
- Default paused; use fish-care.cjs for serialized explicit start/pause, login
  continuation, cancellation generations, account sign-out and safe failure state.
- Put detailed settings in a right-side workbench pane; reuse the upstream section
  and QR flow. Keep the native settings section available too.
- Default to local diary/read activity. Gate platform writes on enabled AND the
  user's explicit workbench.allowExternalWrites setting before network transport.
- Retain workspace-write and avoid prompts requesting broader sandbox permissions.
- Stop all owned timers, abort delivery, cancel the exact fish agent and owned jobs.
- Normalize trailing whitespace in a few upstream docs and CLI files.
- Bundle qrcode 1.5.4 with esbuild 0.25.11 for offline QR rendering; dependency
  notices are in deps/. No upstream install scripts run at application startup.

Rebuild QR bundle (in a disposable dependency directory populated from the pinned
package-lock.json):

```sh
esbuild node_modules/qrcode/lib/index.js --bundle --platform=node --format=cjs --outfile=qrcode.cjs
```

UPSTREAM.json records original file hashes and distributed file hashes separately.
Runtime user data, credentials, sessions, screenshots, node_modules and upstream
test fixtures are not distributed in this snapshot. Tests for this adaptation are
in the repository's tests/neko-workbench/fish-care.test.cjs and fish-host-fixture.mjs.
