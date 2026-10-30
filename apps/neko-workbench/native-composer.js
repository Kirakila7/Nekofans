'use strict';
(() => {
  const api = window.nativeComposer, form = document.getElementById('composer'), message = document.getElementById('message'), send = document.getElementById('send'), expand = document.getElementById('expand'), status = document.getElementById('status');
  let state = { value:'', enabled:false, busy:false, sessionToken:'', revision:0 }, composing = false, dirty = false, conflict = false, blockedDraft = false;
  let pendingEdit = null, pendingSubmit = null, submitQueued = false, expandQueued = false, confirmExpand = false, expandTimer = null, editSequence = 0, submitSequence = 0;
  function refresh() {
    message.disabled = !blockedDraft && (!state.enabled || !state.sessionToken);
    message.readOnly = blockedDraft || submitQueued || pendingSubmit !== null || (expandQueued && !composing);
    message.placeholder = state.placeholder || '工作区未连接';
    send.disabled = message.disabled || state.busy || conflict || blockedDraft || submitQueued || pendingSubmit !== null || !message.value.trim();
  }
  function sendEdit() {
    if (message.disabled || composing || conflict || blockedDraft || pendingEdit !== null || !dirty) return;
    pendingEdit = { id:++editSequence, value:message.value };
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
  function edit() { dirty = true; refresh(); sendEdit(); }
  message.addEventListener('compositionstart', () => { composing = true; });
  message.addEventListener('compositionend', () => { composing = false; edit(); finishExpand(); });
  message.addEventListener('input', () => { if (!composing) edit(); });
  message.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing) { event.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', event => {
    event.preventDefault(); if (composing || send.disabled) return;
    submitQueued = true; refresh(); sendEdit(); sendSubmit();
  });
  expand.addEventListener('click', requestExpand);
  api.onState(next => {
    if (!next || typeof next.value !== 'string' || typeof next.sessionToken !== 'string' || !Number.isSafeInteger(next.revision)) return;
    const changedSession = state.sessionToken !== next.sessionToken;
    if (changedSession) {
      // An unacknowledged draft belongs to the previous session. Never write
      // it into the new one or destroy it; leave it selectable for copying.
      blockedDraft = blockedDraft || composing || dirty || pendingEdit !== null;
      if (!blockedDraft) { dirty = false; conflict = false; }
      pendingEdit = null; pendingSubmit = null; submitQueued = false;
      if (blockedDraft) { expandQueued = false; confirmExpand = false; if (expandTimer !== null) clearTimeout(expandTimer); expandTimer = null; }
    }
    state = next;
    if (!changedSession && pendingEdit !== null && next.settledEditId === pendingEdit.id) {
      if (next.editConflict) { conflict = true; submitQueued = false; expandQueued = false; confirmExpand = false; if (expandTimer !== null) clearTimeout(expandTimer); expandTimer = null; }
      else { dirty = message.value !== pendingEdit.value; }
      pendingEdit = null;
    }
    if (pendingSubmit !== null && next.settledSubmitId === pendingSubmit) pendingSubmit = null;
    if (!composing && !dirty && pendingEdit === null && !conflict && !blockedDraft) message.value = next.value;
    status.textContent = blockedDraft ? '会话已切换，草稿未同步；请先复制再展开工作区处理' : conflict ? '原工作区草稿已变化；请先复制再展开工作区处理' : (next.status || '');
    status.hidden = !status.textContent;
    refresh();
    if (!changedSession && !conflict && !blockedDraft) { sendEdit(); sendSubmit(); refresh(); finishExpand(); }
  });
  refresh();
})();
