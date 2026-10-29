'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { inflateSync } = require('node:zlib');
const MAX_FRAME_BYTES = 4096;

function frameText(frame) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('visit_invalid_frame');
  const text = JSON.stringify(frame);
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new Error('visit_frame_too_large');
  return text;
}

// These are consistency checks, not signature verification: Connect is the trusted issuer.
function validateGrant(grant) {
  if (!grant || grant.mode !== 'text' || !['host', 'guest'].includes(grant.role)
      || (grant.mediaPolicy !== undefined && !['strict', 'client-only'].includes(grant.mediaPolicy))
      || !/^[A-Za-z0-9_-]{1,128}$/.test(grant.visit_id || '')
      || !/^[A-Za-z0-9_-]{1,128}$/.test(grant.vid || '')) throw new Error('visit_invalid_text_grant');
  try {
    // Compatibility is explicit and local. Legacy vendor grants may authorize
    // media, while this isolated renderer still implements only data exchange.
    const clientOnly = grant.mediaPolicy === 'client-only';
    if (grant.transport === 'livekit') {
      const v = grant.vendor.livekit;
      const u = new URL(v.url);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      if (u.username || u.password || !(u.protocol === 'wss:' || (loopback && u.protocol === 'ws:'))) throw Error();
      const payload = JSON.parse(Buffer.from(v.token.split('.')[1], 'base64url').toString());
      const video = payload.video;
      if (payload.sub !== grant.vid || !Number.isSafeInteger(payload.exp) || payload.exp * 1000 <= Date.now()
          || (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || payload.nbf * 1000 > Date.now() + 30000))
          || video.room !== grant.visit_id || video.roomJoin !== true || video.canPublishData !== true
          || ['roomAdmin', 'roomCreate', 'roomList', 'roomRecord', 'ingressAdmin', 'destinationRoom'].some(key => video[key])) throw Error();
      if (!clientOnly && (video.canPublish !== false || video.canSubscribe !== false)) throw Error();
      if (clientOnly) {
        if (typeof video.canPublish !== 'boolean' || typeof video.canSubscribe !== 'boolean') throw Error();
        const sources = video.canPublishSources;
        const allowed = grant.role === 'host' ? ['microphone'] : ['camera', 'microphone'];
        // The deployed Connect issuer constrains media to these sources. Do not
        // broaden compatibility to an unrestricted or screen-sharing publisher.
        if (video.canPublish && (!Array.isArray(sources) || !sources.length || sources.some(source => !allowed.includes(source)))) throw Error();
      }
    } else if (grant.transport === 'trtc') {
      const v = grant.vendor.trtc;
      if (v.user_id !== grant.vid || v.str_room_id !== grant.visit_id || !Number.isSafeInteger(v.sdk_app_id) || v.sdk_app_id <= 0) throw Error();
      const compressed = Buffer.from(v.private_map_key.replace(/\*/g, '+').replace(/-/g, '/').replace(/_/g, '='), 'base64');
      const payload = JSON.parse(inflateSync(compressed, { maxOutputLength: 8192 }).toString());
      const buf = Buffer.from(payload['TLS.userbuf'], 'base64');
      const userLength = buf.readUInt16BE(1);
      const offset = 3 + userLength;
      const roomLength = buf.readUInt16BE(offset + 20);
      const privileges = buf.readUInt32BE(offset + 12);
      const legacyBase = privileges & ~(4 | 8);
      const allowedLegacy = grant.role === 'host' ? [3, 35] : [3, 19];
      if (buf[0] !== 1 || buf.length !== offset + 22 + roomLength
          || buf.subarray(3, offset).toString() !== grant.vid || buf.readUInt32BE(offset) !== v.sdk_app_id
          || buf.readUInt32BE(offset + 8) * 1000 <= Date.now()
          || (clientOnly ? !allowedLegacy.includes(legacyBase) : privileges !== 3)
          || buf.subarray(offset + 22).toString() !== grant.visit_id) throw Error();
    } else throw Error();
  } catch { throw new Error('visit_media_or_invalid_credentials'); }
  return grant;
}

async function createRtcTransport({ BrowserWindow, ipcMain, grant, baseDir = __dirname, onStatus = () => {}, signal }) {
  if (signal?.aborted) throw new Error('visit_rtc_aborted');
  validateGrant(grant);
  const id = randomUUID();
  const channel = `neko-visit-rtc:${id}`;
  const pageURL = pathToFileURL(path.join(baseDir, 'rtc.html')).href;
  const win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(baseDir, 'rtc-preload.cjs'), additionalArguments: [`--neko-visit-rtc=${id}`],
    partition: `visit-rtc-${id}`, sandbox: true, contextIsolation: true,
    nodeIntegration: false, webSecurity: true, backgroundThrottling: false,
  } });
  const wc = win.webContents;
  wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  wc.session.setPermissionCheckHandler(() => false);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event) => event.preventDefault());
  wc.on('will-attach-webview', (event) => event.preventDefault());
  const messages = new Set();
  const disconnects = new Set();
  const pending = new Map();
  const earlyMessages = [];
  let closed = false;
  let joined = false;
  let sequence = 0;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Attach immediately so a load failure cannot leave a rejected ready promise unobserved.
  ready.catch(() => {});
  const isTrusted = (event) => event.sender === wc && event.senderFrame === wc.mainFrame && event.senderFrame?.url === pageURL;
  function close(reason = 'closed') {
    if (closed) return;
    closed = true;
    clearTimeout(joinTimer);
    signal?.removeEventListener('abort', abort);
    ipcMain.removeListener(channel, receive);
    rejectReady(new Error(`visit_rtc_${reason}`));
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('visit_rtc_closed')); }
    pending.clear();
    if (!win.isDestroyed()) win.destroy();
    for (const cb of disconnects) cb(reason);
    messages.clear(); disconnects.clear(); earlyMessages.length = 0;
  }
  function receive(event, message) {
    if (!isTrusted(event) || closed || !message || typeof message !== 'object') return;
    if (message.type === 'ready') wc.send(channel, { type: 'connect', grant });
    else if (message.type === 'joined') { joined = true; clearTimeout(joinTimer); resolveReady(); onStatus('connected'); }
    else if (message.type === 'failed') close('failed');
    else if (message.type === 'disconnected') close('disconnected');
    else if (message.type === 'status' && ['reconnecting', 'connected'].includes(message.status)) onStatus(message.status);
    else if (message.type === 'sent') {
      const item = pending.get(message.id);
      if (item) { pending.delete(message.id); clearTimeout(item.timer); message.ok ? item.resolve() : item.reject(new Error('visit_rtc_send_failed')); }
    } else if (message.type === 'frame' && typeof message.senderVid === 'string'
        && /^[A-Za-z0-9_-]{1,128}$/.test(message.senderVid) && message.senderVid !== grant.vid) {
      try { frameText(message.frame); } catch { return; }
      const value = { senderVid: message.senderVid, frame: message.frame };
      if (!messages.size && earlyMessages.length < 32) earlyMessages.push(value);
      else for (const cb of messages) cb(value);
    }
  }
  const joinTimer = setTimeout(() => close('join_timeout'), 30000);
  const abort = () => close('aborted');
  signal?.addEventListener('abort', abort, { once: true });
  ipcMain.on(channel, receive);
  win.on('closed', () => close('window_closed'));
  wc.on('render-process-gone', () => close('renderer_gone'));
  try { await win.loadURL(pageURL); await ready; } catch { close('failed'); throw new Error('visit_rtc_connect_failed'); }
  return {
    send(frame) {
      if (closed || !joined) return Promise.reject(new Error('visit_rtc_closed'));
      let text;
      try { text = frameText(frame); } catch (error) { return Promise.reject(error); }
      // Eight worst-case frames take 6.4 seconds at our TRTC pacing, below send timeout.
      if (pending.size >= 8) return Promise.reject(new Error('visit_rtc_backpressure'));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('visit_rtc_send_timeout')); }, 15000);
        pending.set(id, { resolve, reject, timer });
        wc.send(channel, { type: 'send', id, text });
      });
    },
    onMessage(cb) { messages.add(cb); for (const value of earlyMessages.splice(0)) cb(value); return () => messages.delete(cb); },
    onDisconnect(cb) { disconnects.add(cb); if (closed) cb('closed'); return () => disconnects.delete(cb); },
    close,
  };
}

module.exports = { createRtcTransport, validateGrant, frameText, MAX_FRAME_BYTES };
