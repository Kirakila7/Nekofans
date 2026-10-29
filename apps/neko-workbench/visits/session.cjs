'use strict';
const { randomUUID } = require('node:crypto');
const { publicPersona, limitUtf8, MAX_TEXT_BYTES, MAX_TEXT_CODEPOINTS } = require('./generator.cjs');
const PROTOCOL = 'neko-visit-text-v1';
const MAX_TURNS = 6;
const MAX_FRAME_BYTES = 4096;

function createVisitSession({ grant, persona: rawPersona, store, transport, generate, verifyPeer, onChange = () => {},
  retryMs = 1200, maxAttempts = 5, handshakeTimeoutMs = 600000, handshakeDeadlineMs,
  idleTimeoutMs = 120000, maxSessionMs = 600000 }) {
  if (!grant || grant.mode !== 'text' || !['host', 'guest'].includes(grant.role)
    || typeof grant.visit_id !== 'string' || !grant.visit_id || typeof grant.vid !== 'string' || !grant.vid
    || typeof grant.identity_ticket !== 'string' || !grant.identity_ticket) throw new Error('invalid_visit_grant');
  const persona = publicPersona(rawPersona);
  const roomId = grant.visit_id, role = grant.role, vid = grant.vid;
  const expiry = typeof grant.expires_at === 'number'
    ? (grant.expires_at < 1e12 ? grant.expires_at * 1000 : grant.expires_at)
    : Date.parse(grant.expires_at);
  const peerRole = role === 'host' ? 'guest' : 'host';
  let phase = 'connecting', reason = '', peer = null, started = false, closed = false;
  let helloId, peerHelloId, helloAck = false, controller = null, timer, incoming = Promise.resolve();
  let progressTimer, sessionTimer;
  let offMessage, offDisconnect;
  const messages = [], pending = new Map(), seen = new Map();
  const snapshot = () => structuredClone({ visitId: roomId, role, phase, reason, persona, peer,
    messages, generating: !!controller });
  const publish = () => { try { onChange(snapshot()); } catch {} };
  const live = () => !closed && ['connecting', 'active'].includes(phase);
  function state(next, why = '') {
    phase = next; reason = why; store.setState(roomId, phase, reason); publish();
  }
  function clearPending() { for (const p of pending.values()) clearTimeout(p.timer); pending.clear(); }
  function finish(why, failed = false) {
    if (!live()) return;
    controller?.abort(); controller = null; clearTimeout(timer); clearTimeout(progressTimer); clearTimeout(sessionTimer); clearPending();
    state(failed ? 'error' : 'ended', why);
  }
  function send(frame) {
    if (closed) return;
    if (Buffer.byteLength(JSON.stringify(frame), 'utf8') > MAX_FRAME_BYTES) { finish('frame_too_large', true); return; }
    try { Promise.resolve(transport.send(frame)).catch(() => finish('transport_failed', true)); }
    catch { finish('transport_failed', true); }
  }
  function frame(type, values = {}) {
    return { protocol: PROTOCOL, roomId, senderVid: vid, type, id: randomUUID(), seq: 0, ...values };
  }
  function reliable(value) {
    if (closed) return;
    const item = { frame: value, attempts: 0, timer: null };
    pending.set(value.id, item);
    function attempt() {
      if (closed || !pending.has(value.id)) return;
      // The host sends an invitation before the guest opens their desktop. During
      // that human wait, repeat hello until the invitation deadline, not 5 retries.
      const waitingForPeer = value.type === 'hello' && !peer && phase === 'connecting';
      if (!waitingForPeer && item.attempts >= maxAttempts) {
        pending.delete(value.id);
        finish('delivery_timeout', true);
        return;
      }
      if (!waitingForPeer) item.attempts++;
      // Install timer before send: injected transports may ACK synchronously.
      item.timer = setTimeout(attempt, retryMs);
      send(value);
    }
    attempt();
  }
  const ack = value => send(frame('ack', { replyTo: value.id, seq: value.seq }));
  function expireActive(why) {
    if (phase !== 'active' || closed) return;
    finish(why, true); reliable(frame('leave', { reason: why }));
  }
  function progress() {
    if (phase !== 'active' || closed) return;
    clearTimeout(progressTimer);
    progressTimer = setTimeout(() => expireActive('idle_timeout'), idleTimeoutMs);
  }
  function activate() {
    if (!live() || !peer || !helloAck) return;
    clearTimeout(timer);
    if (phase !== 'active') {
      state('active');
      if (phase !== 'active' || closed) return;
      progress();
      sessionTimer = setTimeout(() => expireActive('session_timeout'), maxSessionMs);
    }
    void maybeGenerate();
  }
  async function maybeGenerate() {
    if (phase !== 'active' || controller || closed || messages.length >= MAX_TURNS) return;
    const nextRole = messages.length % 2 === 0 ? 'host' : 'guest';
    if (nextRole !== role) return;
    const ownController = new AbortController(); controller = ownController; publish();
    try {
      if (!live() || ownController.signal.aborted) return;
      const generated = await generate({ persona: { ...persona }, signal: ownController.signal,
        messages: messages.map(m => ({ role: m.role === role ? 'assistant' : 'user', text: m.text })) });
      if (!live() || closed || ownController.signal.aborted || controller !== ownController) return;
      if (typeof generated !== 'string' || !generated.trim()) throw new Error('invalid_reply');
      const text = limitUtf8(generated.trim(), MAX_TEXT_BYTES, MAX_TEXT_CODEPOINTS);
      const value = frame('text', { seq: messages.length + 1, replyTo: messages.at(-1)?.id || helloId, text: text.trim() });
      append(value, role); controller = null; progress(); publish();
      if (live()) reliable(value);
    } catch {
      if (live() && !ownController.signal.aborted) { finish('generation_failed', true); reliable(frame('leave', { reason: 'generation_failed' })); }
    } finally {
      if (controller === ownController) { controller = null; publish(); }
    }
  }
  function append(value, senderRole) {
    const message = { id: value.id, seq: value.seq, senderVid: value.senderVid, role: senderRole, text: value.text };
    store.appendMessage(roomId, message); messages.push(message);
  }
  function valid(value, senderVid) {
    return value && typeof value === 'object' && value.protocol === PROTOCOL && value.roomId === roomId
      && typeof senderVid === 'string' && senderVid !== vid && value.senderVid === senderVid
      && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 100
      && Number.isSafeInteger(value.seq) && value.seq >= 0 && value.seq <= MAX_TURNS;
  }
  async function receive({ senderVid, frame: value } = {}) {
    if (!started || closed || !valid(value, senderVid)
      || Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_FRAME_BYTES) return;
    if (value.type === 'hello') {
      if (!live() && !peer) return;
      if (peer && peer.vid !== senderVid) return;
      if (!seen.has(value.id)) {
        if (!live() || typeof value.ticket !== 'string' || value.ticket.length > 16384 || value.role !== peerRole) return;
        const remotePersona = publicPersona(value.persona);
        const claims = await verifyPeer({ ticket: value.ticket, senderVid, role: peerRole });
        if (!live() || closed) return;
        if (!claims || claims.visit_id !== roomId || claims.vid !== senderVid || claims.role !== peerRole) throw new Error('invalid_peer');
        if (peer) return; // One verified identity and one handshake per room.
        peer = { vid: senderVid, role: peerRole, persona: remotePersona };
        peerHelloId = value.id;
        seen.set(value.id, 'hello'); publish();
      }
      ack(value); activate(); return;
    }
    if (!peer || peer.vid !== senderVid) return;
    if (value.type === 'ack') {
      const item = pending.get(value.replyTo);
      if (!item || item.frame.seq !== value.seq) return;
      clearTimeout(item.timer); pending.delete(value.replyTo);
      if (value.replyTo === helloId) { helloAck = true; activate(); }
      if (item.frame.type === 'text' && item.frame.seq === MAX_TURNS) finish('completed');
      return;
    }
    if (seen.has(value.id)) { if (seen.get(value.id) === value.type) ack(value); return; }
    if (!live()) return;
    if (value.type === 'leave') {
      seen.set(value.id, 'leave'); ack(value); finish('peer_left'); return;
    }
    if (value.type !== 'text' || typeof value.text !== 'string' || !value.text.trim()
      || Buffer.byteLength(value.text, 'utf8') > MAX_TEXT_BYTES || [...value.text].length > MAX_TEXT_CODEPOINTS
      || value.seq !== messages.length + 1 || value.seq > MAX_TURNS
      || (value.seq % 2 === 1 ? 'host' : 'guest') !== peerRole
      || (messages.length === 0 && value.replyTo !== peerHelloId)
      || (messages.length > 0 && value.replyTo !== messages.at(-1).id)) return;
    // Only a newly accepted turn is progress. ACKs, duplicate hellos, and replayed
    // messages cannot keep a silent session alive or extend the absolute deadline.
    append(value, peerRole); seen.set(value.id, 'text'); ack(value); progress(); publish();
    if (messages.length === MAX_TURNS) finish('completed');
    else activate();
  }
  function start() {
    if (started || closed) return snapshot();
    const hello = frame('hello', { ticket: grant.identity_ticket, role, persona }); helloId = hello.id;
    if (Buffer.byteLength(JSON.stringify(hello), 'utf8') > MAX_FRAME_BYTES) throw new Error('visit_hello_too_large');
    const deadline = Math.min(Date.now() + handshakeTimeoutMs,
      Number.isFinite(handshakeDeadlineMs) ? handshakeDeadlineMs : Infinity,
      Number.isFinite(expiry) ? expiry : Infinity);
    if (deadline <= Date.now()) throw new Error('visit_expired');
    store.openVisit({ visitId: roomId, role, vid, persona }); started = true;
    offMessage = transport.onMessage(event => {
      incoming = incoming.then(() => receive(event)).catch(() => {
        finish('peer_verification_failed', true);
      });
    });
    offDisconnect = transport.onDisconnect(() => finish('disconnected', true));
    timer = setTimeout(() => finish('handshake_timeout', true), deadline - Date.now());
    reliable(hello); publish(); return snapshot();
  }
  function stop(why = 'stopped') {
    if (!started || !live()) return snapshot();
    const safeReason = ['stopped', 'owner_left', 'shutdown'].includes(why) ? why : 'stopped';
    finish(safeReason); reliable(frame('leave', { reason: safeReason })); return snapshot();
  }
  function close() {
    if (closed) return;
    if (started && live()) stop('shutdown');
    closed = true; controller?.abort(); controller = null; clearTimeout(timer); clearTimeout(progressTimer); clearTimeout(sessionTimer); clearPending();
    offMessage?.(); offDisconnect?.(); transport.close();
  }
  return { start, stop, snapshot, close };
}
module.exports = { createVisitSession, PROTOCOL, MAX_TURNS, MAX_FRAME_BYTES };
