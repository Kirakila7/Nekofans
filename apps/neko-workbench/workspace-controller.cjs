'use strict';
const { projectGroups } = require('./workspace-layout.cjs');
const { CODEX_AVAILABLE, CODEX_TESTING_MESSAGE } = require('./codex-availability.cjs');
function createWorkspaceController({ layout, codex, readDsh, now = Date.now, codexAvailable = CODEX_AVAILABLE } = {}) {
  let cached = null, fetchedAt = 0, pending = null;
  async function catalog({ force = false, dshOffset = 0 } = {}) {
    if (!Number.isSafeInteger(dshOffset) || dshOffset < 0 || dshOffset > 100000) throw Error('会话分页无效');
    if (!force && !dshOffset && cached && now() - fetchedAt < 20000) return structuredClone(cached);
    if (pending) { await pending; if (!dshOffset && cached) return structuredClone(cached); }
    pending = (async () => {
      const results = await Promise.allSettled([readDsh({ offset: dshOffset, limit: 80 }), codexAvailable ? codex.list() : Promise.resolve({ sessions: [], status: 'testing', more: false })]);
      const native = results[0].status === 'fulfilled' ? results[0].value : { sessions: [], status: 'unavailable', nextOffset: null };
      const cx = results[1].status === 'fulfilled' ? results[1].value : { sessions: [], status: 'unavailable', more: false };
      const oldDsh = dshOffset ? cached?.sessions.filter(s => s.provider === 'dsh') || [] : [];
      const sessions = [...new Map([...oldDsh, ...native.sessions, ...cx.sessions].map(row => [row.provider + ':' + row.id, row])).values()];
      cached = { sessions, projects: projectGroups(sessions), providers: { dsh: native.status, codex: cx.status }, nextDshOffset: native.nextOffset ?? null, codexMore: !!cx.more, fetchedAt: now() };
      fetchedAt = now();
    })();
    try { await pending; } finally { pending = null; }
    return structuredClone(cached);
  }
  function knownProject(root) { return root === null || cached?.projects.some(p => p.cwd === root); }
  function state() {
    const result = layout.get();
    result.codexAvailable = codexAvailable;
    const current = codex.snapshot?.();
    const hasActiveCodex = current?.status === 'working' || !!current?.approvals?.length;
    // Preserve the saved seat and mode on disk so enabling Codex later can restore them.
    // A task already running retains its panel, approvals, and stop control until it settles.
    if (!codexAvailable && !hasActiveCodex && (result.officeMode === 'codex' || result.seats.some(s => s.id === result.activeSeatId && s.provider === 'codex'))) {
      result.officeMode = 'dsh';
      result.activeSeatId = result.seats.find(s => s.provider === 'dsh')?.id || null;
    }
    return result;
  }
  return {
    catalog,
    state,
    update(patch) {
      if (!codexAvailable && (patch?.officeMode === 'codex' || layout.get().seats.some(s => s.id === patch?.activeSeatId && s.provider === 'codex'))) throw Error(CODEX_TESTING_MESSAGE);
      return layout.update(patch);
    },
    updateSeat(id, patch) {
      const previous = layout.get().seats.find(s => s.id === id);
      if (!codexAvailable && patch?.provider === 'codex' && previous?.provider !== 'codex') throw Error(CODEX_TESTING_MESSAGE);
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
  const reply = main?.chatReply;
  if (reply?.text && !messages.some(m => m.role === 'assistant' && m.text === reply.text)) messages.push({ id: reply.id || 'stream', role: 'assistant', text: String(reply.text).slice(-16000), streaming: !!reply.streaming });
  const backend = main?.chatBackend || runtime.backend || 'chat-api';
  return { name: main?.name || '主 agent', backend, ready: backend === 'neko' ? state.neko?.connection === 'ready' : !!runtime.ready && !!runtime.hasKey && !!runtime.settings?.baseUrl && !!runtime.settings?.model,
    working: !!main?.active, messages, error: String(runtime.error || state.neko?.error || '').slice(0, 240) };
}
module.exports = { createWorkspaceController, companionSnapshot };
