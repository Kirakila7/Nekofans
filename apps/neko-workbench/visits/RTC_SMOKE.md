# Real RTC smoke evidence — 2026-10-28

## Current compatibility policy

The client now supports deployed Connect credentials through explicit local
`mediaPolicy: 'client-only'`. `mode: 'text'` remains the local session policy;
it no longer claims that a legacy server restricted the credential to text.
LiveKit may grant media publishing/subscription (host microphone; guest camera
and microphone), and TRTC may grant its deployed role-specific privileges
(host 35, guest 19, with optional audio bits 4/8). The isolated renderer still
has no capture, media publish, attachment or media-subscribe call path, rejects
all device permissions, and disables SDK automatic media subscription. Room,
identity, application and expiry checks remain. Administrative or broader
media credentials remain rejected. Missing mediaPolicy defaults to strict
credential checks for future text-only server grants and regression tests.

`rtc-smoke.cjs` now intentionally uses legacy LiveKit grants with
`canPublish: true`, `canSubscribe: true` and the deployed role-specific sources.
The server participant audit verifies both granted permissions and zero actual
media publications; it accepts LiveKit's protobuf JSON snake_case field names.
Earlier strict-token evidence below is retained as historical test evidence.

The legacy-grant run passed: two real Electron clients each received 2640 UTF8
bytes, the server reported both media permissions as true and published media
tracks as zero, and abrupt peer process exit was observed after 22.549 seconds.

The complete controller compatibility run also passed against the local legacy
service contract (no mode request/response fields, legacy identity tickets, no
end-room endpoint): invitation/acceptance, six provider SSE calls, six identical
persisted messages, and both sessions ended. It intentionally sent **zero** end
requests; cloud room termination was **not** asserted. This run's evidence is
`_smoke/controller-d8e74bea-41ea-4c91-ad52-a5f0c898a5c8/` in the final worktree.
The local server and both clients were stopped and temporary downloads/profiles
cleaned after testing. Screenshots, result JSON and SQLite evidence remain.

## Historical strict-token checks (superseded by the compatibility run above)

An earlier strict-token run passed on Windows with two independent Electron **44.7.0** processes, each using
the production `createRtcTransport` implementation and a hidden sandboxed local
renderer. Both connected to an actual local LiveKit **1.13.11** server and
exchanged 2640 UTF8 bytes of Chinese text in each direction, with fragmentation.
No fake RTC adapter was used. LiveKit's ListParticipants API reported two
participants with zero published media tracks. Both participant tokens had
`canPublish: false`, `canSubscribe: false`, and `canPublishData: true`.

This is a same-machine, two-process transport test, not a physical two-device
friendship/login/model integration acceptance test. TRTC permission-bit-3 data
delivery was not tested against Tencent's cloud service; its adapter has only
unit coverage and the official documented prerequisites have been checked.

The first packet immediately after both clients joined was not consistently
delivered while the receiver's data channel was establishing. The smoke repeats
its fixed marker every two seconds until both receivers acknowledge delivery.
The application must retain its session hello and ACK/retry layer; a vendor's
reliable send option alone does not provide offline buffering.

An additional real crash test terminated the guest Electron process without an
application goodbye. LiveKit's `ParticipantDisconnected` reached the host after
**22.574 seconds**, and the transport closed. A first 15-second observation
window was too short. This confirms the vendor event wiring, while showing why
the session's independent idle/deadline timers remain necessary.

## Historical controller integration against the server draft

`tests/neko-workbench/visits-smoke.cjs <repositoryRoot> <electron.exe>` additionally
passed against the final integrated worktree twice. It runs the real controller,
social HTTP client, Ed25519 ticket verification, generator/provider SSE HTTP,
RTC adapters, panel renderer and independent SQLite stores in two Electron
processes. Only the OAuth account session, Verse/Connect HTTP service endpoints,
and OpenAI-compatible model replies are explicit local test doubles.

The test observed one invitation, one acceptance, six real provider HTTP/SSE
calls, six identical messages in both histories, completed/ended on both sides,
and two end-room HTTP calls. After both processes exited, reopening the two
SQLite files still yielded six messages and ended state. The model HTTP payloads
contained no private-memory context or tools. Captures of both actual panels
were visually inspected, including the updated presence wording and persona
limits. This is not production Verse/Auth/Connect or physical two-device testing.

This earlier server-draft run's evidence is in its ignored directory
`apps/neko-workbench/visits/_smoke/controller-f9fc1387-59a5-4223-bb63-db86a64bfaed/`
(`result.json`, `panel-a.png`, `panel-b.png`, plus separate per-account SQLite files).

## Reproduce

Official server archive:
https://github.com/livekit/livekit/releases/download/v1.13.11/livekit_1.13.11_windows_amd64.zip

Archive SHA256 (matched the release's checksums.txt):
`5d071ea43339f0140d24a66f0b2ff8a7bf6c4d0dceb19b30abca835670213667`

Run the verified server with `--dev --bind 127.0.0.1 --config server.yaml`:

```yaml
port: 17880
rtc:
  tcp_port: 0
  udp_port: 17882
  use_external_ip: false
  node_ip: 127.0.0.1
  enable_loopback_candidate: true
  ips:
    includes:
      - 127.0.0.0/8
logging:
  level: warn
```

Then run `node apps/neko-workbench/visits/rtc-smoke.cjs <path-to-electron.exe>`.
Only the documented local development `devkey` / `secret` is used. The smoke
never reads production secrets or `.env`, and discards SDK/Chromium stderr
instead of persisting potential credential-bearing logs.

Historical strict-token result (the current legacy-grant run permits media in
credentials while still verifying zero actual media tracks):

```json
{"ok":true,"realRtc":"LiveKit 1.13.11","clients":2,"processes":2,"eachDirectionTextBytes":2640,"publishedMediaTracks":0,"mediaPublishAllowed":false,"mediaSubscribeAllowed":false,"result":"two real Electron sandbox clients exchanged fragmented UTF8 text"}
```

The server and test Electron processes were stopped after the test. No test
listener remained on TCP 17880/17881 or UDP 17882 (only TCP TIME_WAIT sockets).
The Windows server reports unsupported CPU monitoring; RTC functionality passed.
