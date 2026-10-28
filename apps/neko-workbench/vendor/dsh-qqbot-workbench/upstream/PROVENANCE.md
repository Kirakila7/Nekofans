# Tencent DSH QQ Bot upstream archive

- Package: `@tencent-connect/dsh-qqbot@0.5.3`
- Source: https://github.com/tencent-connect/dsh-qqbot
- Registry: https://registry.npmjs.org/@tencent-connect/dsh-qqbot/-/dsh-qqbot-0.5.3.tgz
- SHA-256: `f4b2280792ea95a550f9a95e96be7b437973ed07a32408463409de67ac7b6986`
- License: MIT; see LICENSE.

The archive is the unmodified official distribution. The workbench starts with
QQ disabled; when the user selects Start, it installs the pinned dependencies
in its private data directory with `npm ci --ignore-scripts`. In particular,
`@tencent-connect/qqbot-connector` is downloaded from npm on the user's machine
and is not redistributed here; its npm license field says UNLICENSED.

The installed copy is adapted locally before execution: the QQ profile is
isolated and owner-only; credentials never appear in fallback instructions;
model settings and per-peer preferences use the isolated QQ profile rather
than the upstream global home-directory files;
requests go through the DSH connection authentication gate; installed DSH
runtime modules are resolved without relying on ASAR-incompatible symlinks;
incoming message bodies are omitted from the main log; and the QQ settings
client is exported under an independent module name. The workbench control
mounts the adapted plugin through the DSH loader only after an explicit Start.
QQ access starts disabled for private and group messages, file delivery and
media downloading; users may review settings before authorizing access.

A `bound` status means credentials were saved and reloaded, not proof of a live
QQ gateway or successful real message exchange. Local real-DSH tests used a
mocked QQ connector and fake credentials; real account tests remain separate.

QQ-created and resumed agents receive a scoped tool guard and an empty
inherited-tool allowlist before any preset is mounted; the guard denies all
model tool executions, including agent-scoped tools. Until its fork/rebuild
path has independent coverage, the QQ `/model` command and remote model
rebuild are disabled. This is an application tool policy, not an OS sandbox.

Reproducible macOS integration check, requiring installed DeepSeek Harness,
Node/npm and registry access, with a simulated QQ peer and no QQ network:

    node tests/neko-workbench/qqbot-real-guard-qa.cjs

The check uses a fresh temporary profile and runs the official adapted QQ
SessionManager through a real DSH host; it checks creation, switching the
preset to minimal, session resume, disabled model rebuild and a negative
control with an ordinary workbench agent.
