'use strict';
(() => {
  const api = window.nativeComposer, form = document.getElementById('composer'), message = document.getElementById('message'), send = document.getElementById('send'), expand = document.getElementById('expand'), copy = document.getElementById('copy'), status = document.getElementById('status');
  let state = { value:'', enabled:false, busy:false, sessionToken:'', revision:0 }, composing = false, dirty = false, conflict = false, blockedDraft = false;
  let pendingEdit = null, pendingSubmit = null, submitQueued = false, expandQueued = false, confirmExpand = false, expandTimer = null, editSequence = 0, submitSequence = 0;
  let draftOwner = '', recoveryOwner = '', storageFailed = false;
  const recoveryKey = token => 'neko.workspace.pending-draft.v1:' + encodeURIComponent(token);
  function readRecovery(token) {
    if (!token) return null;
    try {
      const value = JSON.parse(window.localStorage.getItem(recoveryKey(token)) || 'null');
      return value && value.sessionToken === token && typeof value.value === 'string' && value.value.length <= 30000 ? value : null;
    } catch { storageFailed = true; return null; }
  }
  function rememberRecovery() {
    const token = draftOwner || state.sessionToken;
    if (!token || blockedDraft) return;
    draftOwner = token;
    try {
      const value = JSON.stringify({sessionToken:token,value:message.value,revision:state.revision});
      window.localStorage.setItem(recoveryKey(token),value);
      if (window.localStorage.getItem(recoveryKey(token)) !== value) throw Error('save unavailable');
      storageFailed = false;
    } catch { storageFailed = true; status.textContent = '未同步输入暂不能保存到本机，请保持窗口打开'; status.hidden = false; }
  }
  function clearRecovery(token, expected) {
    if (!token) return;
    const saved = readRecovery(token);
    if (!saved || expected !== undefined && saved.value !== expected) return;
    try { window.localStorage.removeItem(recoveryKey(token)); } catch { storageFailed = true; }
  }
  function refresh() {
    message.disabled = !blockedDraft && (!state.enabled || !state.sessionToken);
    message.readOnly = blockedDraft || conflict || submitQueued || pendingSubmit !== null || (expandQueued && !composing);
    message.placeholder = state.placeholder || '工作区未连接';
    copy.hidden = !(blockedDraft || conflict);
    send.disabled = message.disabled || state.busy || conflict || blockedDraft || submitQueued || pendingSubmit !== null || !message.value.trim();
  }
  function sendEdit() {
    if (message.disabled || composing || conflict || blockedDraft || pendingEdit !== null || !dirty) return;
    pendingEdit = { id:++editSequence, value:message.value };
    const id = pendingEdit.id;
    pendingEdit.timer = setTimeout(() => {
      if (pendingEdit?.id !== id) return;
      pendingEdit = null; conflict = true; expandQueued = false; confirmExpand = false;
      if (expandTimer !== null) clearTimeout(expandTimer); expandTimer = null;
      status.textContent = '无法确认草稿是否同步，请先复制再展开工作区处理'; status.hidden = false; refresh();
    }, 5000);
    api.send({ type:'edit', value:pendingEdit.value, sessionToken:state.sessionToken, revision:state.revision, editId:pendingEdit.id });
  }
  function sendSubmit() {
    if (!submitQueued || pendingEdit !== null || dirty || conflict || blockedDraft || !state.enabled || !state.sessionToken || state.busy) return;
    submitQueued = false; pendingSubmit = ++submitSequence; refresh();
    api.send({ type:'submit', value:message.value, sessionToken:state.sessionToken, revision:state.revision, submissionId:pendingSubmit });
  }
  function finishExpand() {
    if (!expandQueued || composing || dirty || pendingEdit !== null || pendingSubmit !== null || submitQueued || conflict || blockedDraft) return;
    expandQueued = false; if (expandTimer !== null) clearTimeout(expandTimer); expandTimer = null;
    api.send({type:'expand'});
  }
  function requestExpand() {
    if (blockedDraft || conflict) {
      if (!confirmExpand) { confirmExpand = true; status.textContent = '请先复制未同步的草稿，再点一次展开工作区'; status.hidden = false; return; }
      // A second explicit click confirms the user has copied the protected text.
      clearRecovery(recoveryOwner || draftOwner, message.value);
      api.send({type:'expand'}); return;
    }
    if (!composing && !dirty && pendingEdit === null && pendingSubmit === null && !submitQueued) { api.send({type:'expand'}); return; }
    expandQueued = true; status.textContent = '正在保存输入，完成后展开工作区'; status.hidden = false;
    if (expandTimer !== null) clearTimeout(expandTimer);
    expandTimer = setTimeout(() => {
      if (!expandQueued) return;
      expandQueued = false; conflict = true; confirmExpand = false;
      status.textContent = '输入尚未同步，请先复制草稿再展开工作区'; status.hidden = false; refresh();
    }, 5000);
    sendEdit(); sendSubmit(); refresh(); finishExpand();
  }
  function edit() { if (blockedDraft || conflict) return; dirty = true; rememberRecovery(); refresh(); sendEdit(); }
  message.addEventListener('compositionstart', () => { composing = true; });
  message.addEventListener('compositionend', () => { composing = false; edit(); finishExpand(); });
  message.addEventListener('input', () => { if (composing) rememberRecovery(); else edit(); });
  message.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing) { event.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', event => {
    event.preventDefault(); if (composing || send.disabled) return;
    submitQueued = true; refresh(); sendEdit(); sendSubmit();
  });
  expand.addEventListener('click', requestExpand);
  copy.addEventListener('click', () => { message.focus(); message.select(); status.textContent = '草稿已选中，请按 ⌘C 复制'; status.hidden = false; });
  api.onState(next => {
    if (!next || typeof next.value !== 'string' || typeof next.sessionToken !== 'string' || !Number.isSafeInteger(next.revision)) return;
    const changedSession = state.sessionToken !== next.sessionToken;
    if (changedSession) {
      // An unacknowledged draft belongs to the previous session. Never write
      // it into the new one or destroy it; leave it selectable for copying.
      blockedDraft = blockedDraft || composing || dirty || pendingEdit !== null;
      if (blockedDraft) recoveryOwner = draftOwner || state.sessionToken;
      if (!blockedDraft) { dirty = false; conflict = false; }
      if (pendingEdit?.timer) clearTimeout(pendingEdit.timer);
      pendingEdit = null; pendingSubmit = null; submitQueued = false;
      if (blockedDraft) { expandQueued = false; confirmExpand = false; if (expandTimer !== null) clearTimeout(expandTimer); expandTimer = null; }
    }
    state = next;
    if (changedSession && !blockedDraft && next.sessionToken) {
      const saved = readRecovery(next.sessionToken);
      if (saved && saved.value === next.value) clearRecovery(next.sessionToken, next.value);
      else if (saved) { blockedDraft = true; recoveryOwner = next.sessionToken; message.value = saved.value; }
    }
    if (!changedSession && pendingEdit !== null && next.settledEditId === pendingEdit.id) {
      if (pendingEdit.timer) clearTimeout(pendingEdit.timer);
      if (next.editConflict) { conflict = true; submitQueued = false; expandQueued = false; confirmExpand = false; if (expandTimer !== null) clearTimeout(expandTimer); expandTimer = null; }
      else { dirty = message.value !== pendingEdit.value; if (!dirty && !composing && next.value === pendingEdit.value) { clearRecovery(draftOwner, next.value); draftOwner = ''; } }
      pendingEdit = null;
    }
    if (pendingSubmit !== null && next.settledSubmitId === pendingSubmit) pendingSubmit = null;
    if (!composing && !dirty && pendingEdit === null && !conflict && !blockedDraft) message.value = next.value;
    status.textContent = blockedDraft ? '会话已切换或发现未同步的本地草稿；请先复制再展开工作区处理' : conflict ? '原工作区草稿已变化；请先复制再展开工作区处理' : storageFailed && (dirty || composing || pendingEdit !== null) ? '未同步输入暂不能保存到本机，请保持窗口打开' : (next.status || '');
    status.hidden = !status.textContent;
    refresh();
    if (!changedSession && !conflict && !blockedDraft) { sendEdit(); sendSubmit(); refresh(); finishExpand(); }
  });
  refresh();
})();
