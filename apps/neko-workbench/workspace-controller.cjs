'use strict';
const { projectGroups } = require('./workspace-layout.cjs');
const { CODEX_AVAILABLE, CODEX_TESTING_MESSAGE } = require('./codex-availability.cjs');
function createWorkspaceController({ layout, codex, readDsh, validateDsh, now = Date.now, codexAvailable = () => CODEX_AVAILABLE || layout.get().codexEnabled === true } = {}) {
  let cached = null, fetchedAt = 0, pending = null;
  const canUseCodex = () => typeof codexAvailable === 'function' ? codexAvailable() === true : codexAvailable === true;
  async function publicCatalog(value) {
    if (typeof validateDsh !== 'function') return value;
    const ids = value.sessions.filter(row => row.provider === 'dsh').map(row => row.id);
    if (!ids.length) return value;
    const requested = new Set(ids);
    let allowed, unavailable = false;
    try {
      const result = await validateDsh(ids);
      if (!Array.isArray(result) || result.some(id => typeof id !== 'string' || !requested.has(id))) throw Error('Invalid session check');
      allowed = new Set(result);
    } catch { allowed = new Set(); unavailable = true; }
    const sessions = value.sessions.filter(row => row.provider !== 'dsh' || allowed.has(row.id));
    const removed = ids.length - sessions.filter(row => row.provider === 'dsh').length;
    return { ...value, sessions, projects: projectGroups(sessions),
      nextDshOffset: value.nextDshOffset == null ? null : Math.max(0, value.nextDshOffset - removed),
      ...(unavailable ? { providers: { ...value.providers, dsh: 'unavailable' }, nextDshOffset: null } : {}) };
  }
  async function cachedCatalog() {
    const previous = cached, result = await publicCatalog(previous);
    // A parallel refresh may already have replaced this snapshot.
    if (cached === previous) { cached = result; if (result.providers.dsh === 'unavailable') fetchedAt = -Infinity; }
    return structuredClone(result);
  }
  async function catalog({ force = false, dshOffset = 0 } = {}) {
    if (!Number.isSafeInteger(dshOffset) || dshOffset < 0 || dshOffset > 100000) throw Error('会话分页无效');
    if (!force && !dshOffset && cached && now() - fetchedAt < 20000) return cachedCatalog();
    if (pending) { await pending; if (!dshOffset && cached) return cachedCatalog(); }
    if (dshOffset && cached && typeof validateDsh === 'function') {
      // Revalidate the loaded prefix before using an offset into the filtered
      // corpus; removing a private row must not skip the next public session.
      const current = await cachedCatalog();
      if (current.providers.dsh === 'unavailable') return current;
      if (current.nextDshOffset != null) dshOffset = Math.min(dshOffset, current.nextDshOffset);
    }
    pending = (async () => {
      const results = await Promise.allSettled([readDsh({ offset: dshOffset, limit: 80 }), canUseCodex() ? codex.list() : Promise.resolve({ sessions: [], status: 'testing', more: false })]);
      const native = results[0].status === 'fulfilled' ? results[0].value : { sessions: [], status: 'unavailable', nextOffset: null };
      const cx = results[1].status === 'fulfilled' ? results[1].value : { sessions: [], status: 'unavailable', more: false };
      const oldDsh = dshOffset ? cached?.sessions.filter(s => s.provider === 'dsh') || [] : [];
      const sessions = [...new Map([...oldDsh, ...native.sessions, ...cx.sessions].map(row => [row.provider + ':' + row.id, row])).values()];
      cached = await publicCatalog({ sessions, projects: projectGroups(sessions), providers: { dsh: native.status, codex: cx.status }, nextDshOffset: native.nextOffset ?? null, codexMore: !!cx.more, fetchedAt: now() });
      fetchedAt = typeof validateDsh === 'function' && cached.providers.dsh === 'unavailable' ? -Infinity : now();
    })();
    try { await pending; } finally { pending = null; }
    return structuredClone(cached);
  }
  function knownProject(root) { return root === null || cached?.projects.some(p => p.cwd === root); }
  function state() {
    const result = layout.get();
    result.codexAvailable = canUseCodex();
    const current = codex.snapshot?.();
    const hasActiveCodex = current?.status === 'working' || !!current?.approvals?.length;
    // Preserve the saved seat and mode on disk so enabling Codex later can restore them.
    // A task already running retains its panel, approvals, and stop control until it settles.
    if (!canUseCodex() && !hasActiveCodex && (result.officeMode === 'codex' || result.seats.some(s => s.id === result.activeSeatId && s.provider === 'codex'))) {
      result.officeMode = 'dsh';
      result.activeSeatId = result.seats.find(s => s.provider === 'dsh')?.id || null;
    }
    return result;
  }
  return {
    catalog,
    state,
    update(patch) {
      if (!canUseCodex() && (patch?.officeMode === 'codex' || layout.get().seats.some(s => s.id === patch?.activeSeatId && s.provider === 'codex'))) throw Error(CODEX_TESTING_MESSAGE);
      const result = layout.update(patch);
      if ('codexEnabled' in patch) { cached = null; fetchedAt = 0; }
      return result;
    },
    updateSeat(id, patch) {
      const previous = layout.get().seats.find(s => s.id === id);
      if (!canUseCodex() && patch?.provider === 'codex' && previous?.provider !== 'codex') throw Error(CODEX_TESTING_MESSAGE);
      // Editing a disabled seat must not lose its existing project, which may be
      // absent from the DSH-only catalog while Codex is temporarily hidden.
      if (patch?.projectRoot && patch.projectRoot !== previous?.projectRoot && !knownProject(patch.projectRoot)) throw Error('请从已有项目选择工作范围');
      return layout.updateSeat(id, patch);
    },
    uploadSeat: (id, image) => layout.uploadSeat(id, image),
    codex,
  };
}
function companionSnapshot(state) {
  const main = state.actors?.find(a => a.id === 'main');
  const runtime = state.mainChat || {};
  const messages = (main?.messages || []).filter(m => ['user', 'assistant', 'error'].includes(m.role)).slice(-40).map((m, i) => ({ id: String(m.id || m.requestId || m.time || i), role: m.role, text: String(m.text || '').slice(0, 8000) }));
  const backend = main?.chatBackend || runtime.backend || 'chat-api';
  const chat = runtime.chat || {};
  const workbenchStatus = backend === 'deepseek-account' ? (state.connection === 'ready' ? 'ready' : state.connection === 'starting' ? 'starting' : 'unavailable') : null;
  const failed = ['chat-api', 'deepseek-account'].includes(backend) && chat.phase === 'error';
  const reply = main?.chatReply;
  if (reply?.text && !messages.some(m => m.role === 'assistant' && m.text === reply.text)) messages.push({ id: reply.id || 'stream', role: 'assistant', text: String(reply.text).slice(-16000), streaming: !!reply.streaming, partial: failed });
  return { name: main?.name || '主 agent', backend, workbenchStatus, ready: backend === 'neko' ? state.neko?.connection === 'ready' : backend === 'deepseek-account' ? !!runtime.ready && workbenchStatus === 'ready' : !!runtime.ready && !!runtime.hasKey && !!runtime.settings?.baseUrl && !!runtime.settings?.model,
    working: !!main?.active, messages,
    error: String((failed && chat.errorMessage) || runtime.error || (backend === 'neko' && state.neko?.error) || (workbenchStatus === 'starting' ? '工作台正在连接…' : workbenchStatus === 'unavailable' ? '工作台未连接，请重连后再聊天。' : '') || '').slice(0, 240),
    failedText: failed ? String(chat.lastUserMessage || '').slice(0, 8000) : '' };
}
module.exports = { createWorkspaceController, companionSnapshot };
