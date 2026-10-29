# RTC SDKs

These unchanged files were copied from Project-N-E-K-O/N.E.K.O static/libs at
183272c5b, with hashes verified against that project's pinned transport loader.
The text-only adapters are implemented separately; no original media adapter is bundled.

* `trtc.js`: trtc-sdk-v5 5.20.1, https://github.com/LiteAVSDK/TRTC_Web,
  https://registry.npmjs.org/trtc-sdk-v5/-/trtc-sdk-v5-5.20.1.tgz.
  SHA-256: 9a79b7f20e258aed4579d352d59ac2482d58937e534417a68b2e61e98f4a6c25.
  ISC and embedded dependency notices: [TRTC.LICENSE](TRTC.LICENSE).
* `livekit-client.umd.js`: livekit-client 2.22.3, https://github.com/livekit/client-sdk-js,
  https://registry.npmjs.org/livekit-client/-/livekit-client-2.22.3.tgz.
  SHA-256: 7fa17e37af5e996d8a25f15a637dcc0620215bc01b394e5d209f726afe7dc04d.
  Apache-2.0: [LIVEKIT.LICENSE](LIVEKIT.LICENSE). Embedded dependencies retain
  their own permissive licenses, as distributed upstream.

Keep these license files and notices with desktop distributions. SDK scripts are
loaded only in the isolated local RTC renderer, with pinned subresource integrity.
No npm production dependency or remotely loaded script is required.

Custom message size/rate reference:
https://web.sdk.qcloud.com/trtc/webrtc/doc/en/tutorial-46-advanced-data-messages.html
LiveKit reliable packet reference: https://docs.livekit.io/transport/data/packets/
