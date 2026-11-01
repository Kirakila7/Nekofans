'use strict';

// A narrow adapter to the *current* retained DSH session input shell. It never
// routes text through companion chat and never owns a second draft. All calls
// must be bound to the session and content revision the caller actually saw.
function createNativeComposerAdapter(options = {}) {
  let disposed = false, bound = null, unbindShell = null, unbindNotice = null, unbindSession = null, unbindTranscript = null, unbindSelection = null;
  const pendingSubmissions = new WeakMap();
  let scheduled = false;
  const selection = () => options.getSelection?.();
  const selectedId = value => value && !value.subagentAddress && typeof value.sessionId === 'string' && value.sessionId ? value.sessionId : null;
  const unavailable = reason => ({ available: false, reason, sessionId: null, revision: null, draft: '', phase: null, running: false, failed: false });
  function detach() {
    if (typeof unbindShell === 'function') { try { unbindShell(); } catch {} }
    if (typeof unbindNotice === 'function') { try { unbindNotice(); } catch {} }
    if (typeof unbindSession === 'function') { try { unbindSession(); } catch {} }
    if (typeof unbindTranscript === 'function') { try { unbindTranscript(); } catch {} }
    unbindTranscript = null;
    unbindShell = unbindNotice = unbindSession = null; bound = null;
  }
  function resolve() {
    if (disposed) return null;
    try {
      const id = selectedId(selection()), main = options.getMainSessionId?.();
      if (!id || id !== main) return null;
      const binding = options.getBinding?.(id);
      if (!binding || binding.sessionId !== id || binding.session?.sessionId !== id) return null;
      const shell = options.getShell?.(binding, id);
      if (!shell || typeof shell.state?.getSnapshot !== 'function' || typeof shell.state?.subscribe !== 'function' || typeof shell.actions?.setDraft !== 'function' || typeof shell.actions?.persistDraft !== 'function' || typeof shell.actions?.submit !== 'function') return null;
      // Selection can change during a service call. Never retain the old target.
      if (selectedId(selection()) !== id || options.getMainSessionId?.() !== id || options.getBinding?.(id) !== binding) return null;
      let transcript = null;
      try { transcript = options.getTranscript?.(binding, id) || null; } catch { /* Older hosts keep their normal input. */ }
      return { id, binding, shell, transcript };
    } catch { return null; }
  }
  function notify() {
    if (!disposed && typeof options.onChange === 'function') {
      try { options.onChange(snapshot()); } catch { /* Subscriber cannot break native state. */ }
    }
  }
  function refreshBinding() {
    const next = resolve();
    if (!next) { if (bound) detach(); return null; }
    if (!bound || bound.id !== next.id || bound.binding !== next.binding || bound.shell !== next.shell) {
      detach(); bound = next;
      try {
        unbindShell = next.shell.state.subscribe(notify);
        if (typeof next.shell.notices?.subscribe === 'function') unbindNotice = next.shell.notices.subscribe(notify);
        if (typeof next.binding.session?.subscribe === 'function') unbindSession = next.binding.session.subscribe(notify);
        if (typeof next.transcript?.subscribe === 'function') unbindTranscript = next.transcript.subscribe(notify);
      } catch { detach(); return null; }
    }
    return bound;
  }
  function readSnapshot(active) {
    try {
      const raw = active.shell.state.getSnapshot();
      if (!raw || typeof raw.draft !== 'string' || !Number.isSafeInteger(raw.draftRev) || raw.draftRev < 0 || typeof raw.phase !== 'string' || !Array.isArray(raw.occurrences) || !Array.isArray(raw.attachmentIds)) return unavailable('输入状态暂不可用');
      const session = active.binding.session?.getSnapshot?.(), notice = active.shell.notices?.getSnapshot?.();
      const rich = raw.occurrences.length > 0 || raw.attachmentIds.length > 0 || raw.claim != null;
      const reason = session?.removed === true ? '工作会话已不可用，请展开工作区选择会话' : rich ? '当前草稿包含引用、附件或指令，请展开工作区继续编辑' : raw.draft.length > 30000 ? '草稿较长，请展开工作区继续编辑' : raw.phase !== 'plain' ? '原生输入正在处理，请稍候' : '';
      const failed = !!(session?.promptError || session?.lastAgentError || notice?.level === 'error'), running = session?.running === true;
      const status = failed ? '工作会话出现错误，请展开工作区查看详情' : Array.isArray(session?.pendingSubmissions) && session.pendingSubmissions.length ? '正在交给工作区处理' : running ? '工作会话正在处理…' : '';
      const activity = readActivity(active, session);
      return { available: !reason, reason, status, sessionId: active.id, revision: raw.draftRev, draft: raw.draft, phase: raw.phase, ...activity, running, failed };
    } catch { return unavailable('输入状态暂不可用'); }
  }
  function readActivity(active, session) {
    // Consume the retained Conversation's public Chat target, never scrape the
    // hidden DOM or open another history stream. Exclude reasoning, tool args,
    // system context and raw errors from this small presentation surface.
    const rows = [], textBlocks = blocks => (Array.isArray(blocks) ? blocks : []).filter(b => b?.kind === 'text' || b?.type === 'text').map(b => typeof b.text === 'string' ? b.text : '').join('\n').slice(0, 6000);
    let transcript;
    try { transcript = active.transcript?.getSnapshot?.(); } catch {}
    const legacy = transcript?.legacy;
    for (const node of (Array.isArray(legacy?.nodes) ? legacy.nodes : []).slice(-100)) {
      let role, text;
      if (node?.kind === 'user' || node?.kind === 'steering') { role = 'user'; text = textBlocks(node.content); }
      else if (node?.kind === 'assistant') { role = 'assistant'; text = textBlocks(node.blocks); }
      else if (node?.kind === 'tool-result') { role = 'activity'; text = (node.isError ? '工具执行失败：' : '工具已返回：') + String(node.name || '工具').slice(0, 100); }
      else if (node?.kind === 'turn-error') { role = 'activity'; text = node.code === 'INTERRUPTED' ? '此轮任务已停止' : '此轮任务未完成，请展开工作区查看详情'; }
      if (text) rows.push({id:String(node.messageId || node.seq), role, text});
    }
    const partial = textBlocks(legacy?.partial?.blocks);
    if (partial) rows.push({id:'partial:' + legacy.partial.turn + ':' + legacy.partial.step, role:'assistant', text:partial, streaming:true});
    for (const pending of (Array.isArray(session?.pendingSubmissions) ? session.pendingSubmissions : []).slice(-10)) {
      if (typeof pending.text === 'string') rows.push({id:'pending:' + pending.requestId, role:'user', text:pending.text.slice(0,6000), pending:true});
    }
    const calls = Array.isArray(legacy?.runningCalls) ? legacy.runningCalls : [];
    const taskStatus = session?.removed ? '会话已不可用' : session?.openState === 'error' ? '会话读取失败，请展开工作区重试' : session?.promptError || session?.lastAgentError ? '任务出现错误，请展开工作区查看详情' : session?.running ? calls.length ? '正在执行：' + String(calls.at(-1)?.name || '工具').slice(0,100) : '任务运行中…' : session?.pendingSubmissions?.length || session?.awaitingFirstTurn ? '正在等待工作区接收…' : !legacy ? '任务记录暂不可用，请展开工作区查看' : session?.openState === 'loading' ? '正在读取会话…' : '当前没有运行中的任务';
    return { taskMessages:rows.slice(-40), taskStatus, taskRunning:session?.running === true };
  }
  function snapshot() {
    const active = refreshBinding();
    return active ? readSnapshot(active) : unavailable(disposed ? '输入已关闭' : '请先打开一个工作会话');
  }
  function verify(request) {
    const state = snapshot();
    if (request?.composing === true) return { ok:false, code:'composing', state };
    if (!state.available) return { ok:false, code:'unavailable', state };
    if (typeof request?.sessionId !== 'string' || request.sessionId !== state.sessionId) return { ok:false, code:'session_changed', state };
    if (!Number.isSafeInteger(request.revision) || request.revision !== state.revision) return { ok:false, code:'draft_changed', state };
    return { ok:true, state, active:bound };
  }
  function write(request) {
    const check = verify(request);
    if (!check.ok) return check;
    // DSH strips reference placeholder code points from plain-text setDraft;
    // reject instead of silently changing what the person typed.
    if (typeof request.text !== 'string' || request.text.length > 30000 || /[\uE100-\uE11D\uFFFC]/u.test(request.text)) return { ok:false, code:'invalid_text', state:check.state };
    if (request.text === check.state.draft) return { ok:true, code:'unchanged', state:check.state };
    try {
      check.active.shell.actions.setDraft(request.text);
      check.active.shell.actions.persistDraft();
      const state = snapshot();
      if (state.sessionId !== request.sessionId) return { ok:false, code:'session_changed', state };
      if (state.draft !== request.text) return { ok:false, code:'write_unconfirmed', state };
      return { ok:true, code:'updated', state };
    } catch { return { ok:false, code:'write_failed', state:snapshot() }; }
  }
  function submit(request) {
    const check = verify(request);
    if (!check.ok) return check;
    if (!check.state.draft.trim()) return { ok:false, code:'empty', state:check.state };
    if (pendingSubmissions.get(check.active.shell) === check.state.revision) return { ok:false, code:'already_submitted', state:check.state };
    // Mark first: native submit may synchronously notify subscribers or throw
    // after dispatch. Retrying the same revision could duplicate a message.
    pendingSubmissions.set(check.active.shell, check.state.revision);
    try {
      check.active.shell.actions.submit();
      return { ok:true, code:'submitted_to_native', state:snapshot() };
    } catch { return { ok:false, code:'submit_unknown', state:snapshot() }; }
  }
  function selectionChanged() {
    // Navigation publishes selection before the retained main reference moves.
    // Immediately invalidate old bindings, then retry after navigation settles.
    detach(); notify();
    if (!scheduled) {
      scheduled = true;
      Promise.resolve().then(() => { scheduled = false; notify(); });
    }
  }
  if (typeof options.subscribeSelection === 'function') {
    try { unbindSelection = options.subscribeSelection(selectionChanged); } catch { /* Feature detection remains fail-closed. */ }
  }
  return { snapshot, write, submit, dispose() { if (disposed) return; disposed = true; detach(); if (typeof unbindSelection === 'function') { try { unbindSelection(); } catch {} } unbindSelection = null; } };
}

if (typeof window === 'undefined' && typeof module !== 'undefined' && module.exports) module.exports = { createNativeComposerAdapter };
