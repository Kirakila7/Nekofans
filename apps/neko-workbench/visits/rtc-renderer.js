/* Text-only adapters. No media capture, publishing, attachment or subscription APIs. */
(function (root) {
  'use strict';
  const MAX_BYTES = 4096;
  const PART_BYTES = 900;
  const TOPIC = 'neko.visit.text.v1';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });

  function fragment(text, id) {
    const bytes = encoder.encode(text);
    if (bytes.length > MAX_BYTES) throw new Error('visit_frame_too_large');
    const count = Math.ceil(bytes.length / PART_BYTES);
    return Array.from({ length: count }, (_, index) => {
      const part = bytes.subarray(index * PART_BYTES, (index + 1) * PART_BYTES);
      const result = new Uint8Array(9 + part.length);
      result.set([0x4e, 0x56, 1]);
      new DataView(result.buffer).setUint32(3, id);
      result[7] = index; result[8] = count; result.set(part, 9);
      return result;
    });
  }

  function createReceiver(onFrame, now = Date.now) {
    const partial = new Map();
    return function receive(senderVid, input) {
      if (typeof senderVid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(senderVid)) return;
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      if (bytes.length < 10 || bytes.length > 909 || bytes[0] !== 0x4e || bytes[1] !== 0x56 || bytes[2] !== 1) return;
      const count = bytes[8], index = bytes[7];
      if (!count || count > 5 || index >= count || (index < count - 1 && bytes.length !== 909)) return;
      const time = now();
      for (const [key, value] of partial) if (time - value.time > 10000) partial.delete(key);
      const id = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(3);
      const key = `${senderVid}:${id}`;
      let item = partial.get(key);
      if (!item) {
        if (partial.size >= 32) return;
        item = { time, count, parts: new Map(), size: 0 }; partial.set(key, item);
      }
      if (item.count !== count || item.parts.has(index)) return;
      item.parts.set(index, bytes.slice(9)); item.size += bytes.length - 9;
      if (item.size > MAX_BYTES) { partial.delete(key); return; }
      if (item.parts.size !== count) return;
      partial.delete(key);
      const assembled = new Uint8Array(item.size);
      let offset = 0;
      for (let n = 0; n < count; n += 1) { assembled.set(item.parts.get(n), offset); offset += item.parts.get(n).length; }
      try {
        const frame = JSON.parse(decoder.decode(assembled));
        if (frame && typeof frame === 'object' && !Array.isArray(frame)) onFrame({ senderVid, frame });
      } catch { /* Malformed or oversized packets do not reach the session. */ }
    };
  }

  async function createAdapter({ grant, sdk, onFrame, onStatus, onDisconnect, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    let closed = false;
    let serial = Promise.resolve();
    let packetId = 0;
    const receive = createReceiver(onFrame);
    let sendPart, leave;
    if (grant.transport === 'livekit') {
      const room = new sdk.Room({ adaptiveStream: false, dynacast: false, webAudioMix: false });
      leave = () => room.disconnect();
      room.on(sdk.RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        if (!closed && participant && topic === TOPIC) receive(participant.identity, payload);
      });
      room.on(sdk.RoomEvent.Reconnecting, () => { if (!closed) onStatus('reconnecting'); });
      room.on(sdk.RoomEvent.Reconnected, () => { if (!closed) onStatus('connected'); });
      room.on(sdk.RoomEvent.Disconnected, () => { if (!closed) onDisconnect(); });
      room.on(sdk.RoomEvent.ParticipantDisconnected, (participant) => {
        if (!closed && participant?.identity && participant.identity !== grant.vid) onDisconnect();
      });
      const v = grant.vendor.livekit;
      try { await room.connect(v.url, v.token, { autoSubscribe: false }); }
      catch (error) { closed = true; await room.disconnect(); throw error; }
      sendPart = (bytes) => room.localParticipant.publishData(bytes, { reliable: true, topic: TOPIC });
    } else if (grant.transport === 'trtc') {
      sdk.setLogLevel?.(4);
      const rtc = sdk.create();
      leave = async () => { try { await rtc.exitRoom(); } finally { rtc.destroy(); } };
      rtc.on(sdk.EVENT.CUSTOM_MESSAGE, (event) => {
        if (!closed && event.cmdId === 1) receive(event.userId, event.data);
      });
      rtc.on(sdk.EVENT.KICKED_OUT, () => { if (!closed) onDisconnect(); });
      rtc.on(sdk.EVENT.REMOTE_USER_EXIT, (event) => {
        if (!closed && event?.userId && event.userId !== grant.vid) onDisconnect();
      });
      rtc.on(sdk.EVENT.CONNECTION_STATE_CHANGED, (event) => {
        if (closed) return;
        if (event.state === 'DISCONNECTED') onDisconnect();
        else if (event.state === 'RECONNECTING') onStatus('reconnecting');
        else if (event.state === 'CONNECTED') onStatus('connected');
      });
      const v = grant.vendor.trtc;
      try { await rtc.enterRoom({ sdkAppId: v.sdk_app_id, userId: v.user_id, userSig: v.user_sig,
        privateMapKey: v.private_map_key, strRoomId: v.str_room_id, scene: sdk.TYPE.SCENE_RTC,
        role: sdk.TYPE.ROLE_ANCHOR, autoReceiveAudio: false, autoReceiveVideo: false }); }
      catch (error) { closed = true; await leave(); throw error; }
      sendPart = (bytes) => rtc.sendCustomMessage({ cmdId: 1, data: bytes.buffer });
    } else throw new Error('visit_unknown_transport');
    return {
      send(text) {
        const parts = fragment(text, ++packetId);
        const operation = serial.then(async () => {
          for (const bytes of parts) {
            if (closed) throw new Error('visit_rtc_closed');
            await sendPart(bytes);
            // <= 7 packets / second and <= 6363 bytes / second, below TRTC quotas.
            await sleep(160);
          }
        });
        serial = operation.catch(() => {});
        return operation;
      },
      async close() { if (closed) return; closed = true; await leave(); },
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { fragment, createReceiver, createAdapter }; return;
  }
  let adapter = null;
  let connecting = false;
  const bridge = root.visitRtc;
  const send = (message) => bridge.send(message);
  async function loadSdk(transport) {
    const sources = {
      trtc: ['vendor/trtc.js', 'sha256-mnm38g4liu1FedNS1ZrCSC1Yk35TRBemiy5h6Y9KbCU=', 'TRTC'],
      livekit: ['vendor/livekit-client.umd.js', 'sha256-f6F+N69emW2KJfFaY33MBiAhW8AbOU5dIJ9yav59wE0=', 'LivekitClient'],
    };
    const [src, integrity, globalName] = sources[transport];
    // TRTC debug plugins otherwise support loading scripts from sessionStorage.
    root.sessionStorage.removeItem('TRTC_ENABLE_DEBUG_PLUGIN');
    root.sessionStorage.removeItem('TRTC_DEBUG_DIALOG_PATH');
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src; script.integrity = integrity;
      script.onload = resolve; script.onerror = () => reject(new Error('visit_sdk_load_failed'));
      document.head.appendChild(script);
    });
    return root[globalName];
  }
  bridge.listen(async (message) => {
    if (message.type === 'connect' && !connecting) {
      connecting = true;
      try {
        const sdk = await loadSdk(message.grant.transport);
        adapter = await createAdapter({ grant: message.grant, sdk,
          onFrame: (value) => send({ type: 'frame', ...value }),
          onStatus: (status) => send({ type: 'status', status }),
          onDisconnect: () => send({ type: 'disconnected' }),
        });
        send({ type: 'joined' });
      } catch { send({ type: 'failed' }); }
    } else if (message.type === 'send' && adapter) {
      try { await adapter.send(message.text); send({ type: 'sent', id: message.id, ok: true }); }
      catch { send({ type: 'sent', id: message.id, ok: false }); }
    }
  });
  root.addEventListener('pagehide', () => { if (adapter) adapter.close().catch(() => {}); });
  send({ type: 'ready' });
})(globalThis);
