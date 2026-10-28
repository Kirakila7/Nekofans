'use strict';
// Run with Node: node rtc-smoke.cjs <electron.exe>. Requires a local LiveKit dev
// server at ws://127.0.0.1:17880. Uses ONLY documented devkey/secret, never user secrets.
const { createHmac, randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const ROOM_PREFIX = 'rtc-smoke-';
function token(subject, video) {
  const now = Math.floor(Date.now() / 1000);
  const parts = [ { alg: 'HS256', typ: 'JWT' }, { iss: 'devkey', sub: subject, nbf: now - 5, exp: now + 120, video } ];
  const value = parts.map((p) => Buffer.from(JSON.stringify(p)).toString('base64url')).join('.');
  return `${value}.${createHmac('sha256', 'secret').update(value).digest('base64url')}`;
}
const text = '双猫纯文本验证。'.repeat(110);

async function client() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const { createRtcTransport } = require('./rtc-transport.cjs');
  const side = process.argv[2], room = process.argv[3], userDir = process.argv[4];
  if (!['a', 'b'].includes(side) || !room.startsWith(ROOM_PREFIX)) throw new Error('bad smoke arguments');
  app.setPath('userData', userDir);
  app.disableHardwareAcceleration();
  await app.whenReady();
  process.send?.({ type: 'phase', side, phase: 'app-ready' });
  const grant = { mode: 'text', mediaPolicy: 'client-only', visit_id: room, vid: `cat-${side}`, role: side === 'a' ? 'host' : 'guest', transport: 'livekit',
    vendor: { livekit: { url: 'ws://127.0.0.1:17880', token: token(`cat-${side}`, {
      room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true,
      canPublishSources: side === 'a' ? ['microphone'] : ['camera', 'microphone'],
    }) } } };
  const transport = await createRtcTransport({ BrowserWindow, ipcMain, grant });
  transport.onDisconnect(() => process.send?.({ type: 'disconnected', side }));
  let received = false;
  transport.onMessage((message) => {
    if (received) return;
    const peer = side === 'a' ? 'b' : 'a';
    if (message.senderVid !== `cat-${peer}` || message.frame.text !== text || message.frame.from !== peer) {
      process.send({ type: 'failed', side, code: 'payload_mismatch' }); return;
    }
    received = true; process.send({ type: 'received', side, bytes: Buffer.byteLength(message.frame.text) });
  });
  process.on('message', async (message) => {
    if (message === 'send') {
      try { await transport.send({ type: 'smoke', from: side, text }); process.send({ type: 'sent', side }); }
      catch { process.send({ type: 'failed', side, code: 'send_failed' }); }
    }
    if (message === 'close') { transport.close(); app.quit(); }
  });
  process.send({ type: 'ready', side, electron: process.versions.electron });
}

async function run() {
  const { spawn } = require('node:child_process');
  const executable = process.argv[2];
  if (!executable || !fs.existsSync(executable)) throw new Error('Pass an installed Electron executable');
  const room = ROOM_PREFIX + randomUUID();
  const root = path.join(__dirname, '_smoke', room); fs.mkdirSync(root, { recursive: true });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const children = [], ready = new Set(), received = new Set(), sent = new Set();
  let resolvePeerExit;
  const peerExit = new Promise(resolve => { resolvePeerExit = resolve; });
  let retryTimer = null;
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const timeout = setTimeout(() => rejectDone(new Error(`rtc_smoke_timeout ready=${ready.size} sent=${sent.size} received=${received.size}`)), 45000);
  try {
    for (const side of ['a', 'b']) {
      const child = spawn(executable, [__filename, side, room, path.join(root, side)], {
        env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      children.push(child);
      // SDK/Chromium logs may contain credentials: do not echo or persist stderr.
      child.stderr.resume();
      child.on('error', () => rejectDone(new Error('electron_spawn_failed')));
      child.on('exit', (code) => { if (code && received.size < 2) rejectDone(new Error(`electron_exit_${side}_${code}`)); });
      child.on('message', (message) => {
        if (message.type === 'phase') console.log(`smoke ${side}: ${message.phase}`);
        if (message.type === 'failed') rejectDone(new Error(message.code));
        if (message.type === 'disconnected' && side === 'a') resolvePeerExit();
        if (message.type === 'ready') {
          console.log(`smoke ${side}: joined`);
          ready.add(side);
          if (ready.size === 2) {
            for (const participant of children) participant.send('send');
            // A reliable LiveKit packet is not buffered for a peer whose data channel
            // is still establishing. The session layer uses ACK/retry; this transport
            // smoke repeats its fixed test marker until both receivers acknowledge it.
            retryTimer = setInterval(() => { for (const participant of children) if (participant.connected) participant.send('send'); }, 2000);
          }
        }
        if (message.type === 'received') { received.add(side); console.log(`smoke ${side}: received`); }
        if (message.type === 'sent') { sent.add(side); console.log(`smoke ${side}: sent`); }
        if (received.size === 2 && sent.size === 2) resolveDone();
      });
    }
    await done;
    const response = await fetch('http://127.0.0.1:17880/twirp/livekit.RoomService/ListParticipants', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token('smoke-audit', { room, roomAdmin: true })}` },
      body: JSON.stringify({ room }), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('participant_audit_failed');
    const body = await response.json();
    const participants = body.participants || [];
    if (participants.length !== 2 || participants.some((p) => (p.tracks || []).length !== 0)) throw new Error('unexpected_media_publication');
    const mediaPermissions = participants.map(p => ({ publish: p.permission?.canPublish ?? p.permission?.can_publish, subscribe: p.permission?.canSubscribe ?? p.permission?.can_subscribe }));
    if (mediaPermissions.some(p => p.publish !== true || p.subscribe !== true)) {
      console.log(JSON.stringify({ permissionAudit: participants.map(p => p.permission || null) }));
      throw new Error('legacy_media_grant_not_applied');
    }
    clearInterval(retryTimer);
    // Abrupt process exit, not an application-level goodbye: the remaining real
    // SDK must report ParticipantDisconnected and close the session transport.
    const peerExitStarted = Date.now();
    children[1].kill();
    let peerTimer;
    try { await Promise.race([peerExit, new Promise((_, reject) => { peerTimer = setTimeout(() => reject(new Error('peer_exit_not_observed')), 45000); })]); }
    finally { clearTimeout(peerTimer); }
    console.log(JSON.stringify({ ok: true, realRtc: 'LiveKit 1.13.11', clients: 2, processes: 2,
      eachDirectionTextBytes: Buffer.byteLength(text), publishedMediaTracks: 0, mediaPublishAllowed: true,
      mediaSubscribeAllowed: true, clientMediaPolicy:'client-only', peerProcessExitObserved: true, peerExitObservedMs: Date.now() - peerExitStarted,
      result: 'two real Electron sandbox clients exchanged fragmented UTF8 text' }));
  } finally {
    clearTimeout(timeout);
    clearInterval(retryTimer);
    await Promise.all(children.map((child) => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send('close'); else child.kill();
    })));
  }
}

(process.versions.electron ? client() : run()).catch((error) => {
  if (process.send) { process.send({ type: 'failed', code: error.message }); require('electron').app.exit(1); }
  else { console.error(error.message); process.exitCode = 1; }
});
