'use strict';
(() => {
  const api = window.nativeComposer, form = document.getElementById('composer'), message = document.getElementById('message'), send = document.getElementById('send'), expand = document.getElementById('expand'), files = document.getElementById('files'), copy = document.getElementById('copy'), status = document.getElementById('status');
  const copyShortcut = /Mac/i.test(window.navigator.platform) ? '⌘C' : 'Ctrl+C';
  copy.title = '选中草稿后按 ' + copyShortcut + ' 复制';
  expand.title = '展开工作区，查看任务进度与结果';
  let state = { value:'', enabled:false, busy:false, sessionToken:'', revision:0 }, composing = false, dirty = false, conflict = false, blockedDraft = false, submitUnknown = false;
  let pendingEdit = null, pendingSubmit = null, submitQueued = false, expandQueued = false, expandAction = 'expand', confirmExpand = false, expandTimer = null, editSequence = 0, submitSequence = 0;
  let draftOwner = '', recoveryOwner = '', storageFailed = false;
  const recoveryKey = token => 'neko.workspace.pending-draft.v1:' + encodeURIComponent(token);
  function readRecovery(token) {
    if (!token) return null;
    try {
      const value = JSON.parse(window.localStorage.getItem(recoveryKey(token)) || 'null');
      return value && value.sessionToken === token && typeof value.value === 'string' && value.value.length <= 30000 ? value : null;
    } catch { storageFailed = true; return null; }
  }
  function rememberRecovery(kind = 'draft') {
    const token = draftOwner || state.sessionToken;
    if (!token || blockedDraft) return;
    draftOwner = token;
    try {
      const value = JSON.stringify({sessionToken:token,value:message.value,revision:state.revision,kind});
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
    message.readOnly = blockedDraft || conflict || submitQueued || pendingSubmit !== null || recordOpenPending !== null || (expandQueued && !composing);
    message.placeholder = state.placeholder || '工作区未连接';
    copy.hidden = !(blockedDraft || conflict);
    files.disabled = message.disabled || conflict || blockedDraft || pendingSubmit !== null || submitQueued || expandQueued || recordOpenPending !== null;
    send.disabled = message.disabled || state.busy || conflict || blockedDraft || submitQueued || pendingSubmit !== null || recordOpenPending !== null || !message.value.trim();
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
    submitQueued = false;
    const request = { id:++submitSequence, value:message.value, sessionToken:state.sessionToken, revision:state.revision };
    pendingSubmit = request;
    // Keep a per-session recovery copy before dispatch, including if the app
    // exits or changes layout before the acknowledgment or its timeout.
    draftOwner = request.sessionToken; rememberRecovery('submit-unknown');
    // A view can be detached before the IPC reaches the host.  Absence of an
    // acknowledgement does not tell us whether the native session accepted it.
    request.timer = setTimeout(() => {
      if (pendingSubmit !== request) return;
      pendingSubmit = null; submitUnknown = true; conflict = true; expandQueued = false; confirmExpand = false;
      if (expandTimer !== null) clearTimeout(expandTimer); expandTimer = null;
      message.value = request.value; draftOwner = request.sessionToken; rememberRecovery('submit-unknown');
      status.textContent = '发送结果未确认，可能已发送；请展开工作区核对，勿重复发送'; status.hidden = false; refresh();
    }, 5000);
    refresh();
    api.send({ type:'submit', value:request.value, sessionToken:request.sessionToken, revision:request.revision, submissionId:request.id });
  }
  function finishExpand() {
    if (!expandQueued || recordOpenPending !== null || composing || dirty || pendingEdit !== null || pendingSubmit !== null || submitQueued || conflict || blockedDraft) return;
    expandQueued = false; if (expandTimer !== null) clearTimeout(expandTimer); expandTimer = null;
    api.send(expandAction === 'files' ? {type:'files',sessionToken:state.sessionToken,revision:state.revision} : {type:'expand'}); expandAction = 'expand';
  }
  function requestExpand(action = 'expand') {
    if (action === 'files' && (blockedDraft || conflict || !state.enabled || !state.sessionToken)) return;
    if (recordOpenPending) { status.textContent = '正在切换会话，请稍候'; status.hidden = false; return; }
    if (recordOpenUnknown && !message.value) { api.send({type:'expand'}); return; }
    if (blockedDraft || conflict) {
      const saved = readRecovery(recoveryOwner || draftOwner);
      if (!saved || saved.value !== message.value) {
        status.textContent = '草稿副本暂未保存，请复制内容并保持窗口打开'; status.hidden = false; return;
      }
      if (!confirmExpand) { confirmExpand = true; status.textContent = submitUnknown ? '任务可能已发送；核对后再点一次展开并清除本机副本' : '未同步草稿会保留在本机，再点一次展开工作区'; status.hidden = false; return; }
      if (submitUnknown) clearRecovery(recoveryOwner || draftOwner, message.value);
      // Expanding is not proof that copying succeeded: retain the recovery
      // record until the native draft is observed to contain the same text.
      api.send({type:'expand'}); return;
    }
    if (!composing && !dirty && pendingEdit === null && pendingSubmit === null && !submitQueued) { api.send(action === 'files' ? {type:'files',sessionToken:state.sessionToken,revision:state.revision} : {type:'expand'}); return; }
    expandAction = action; expandQueued = true; status.textContent = '正在保存输入，完成后展开工作区'; status.hidden = false;
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
  const records = document.getElementById('records'), recordsList = document.getElementById('records-list'), recordsToggle = document.getElementById('records-toggle'), resizeHandle = document.getElementById('records-resize'), recordsStatus = document.getElementById('records-status'), recordsMore = document.getElementById('records-more'), recordsRefresh = document.getElementById('records-refresh');
  let recordsOpen = false, recordsDesired = null, resizing = null, recordsRenderKey = '', recordOpenSequence = 0, recordOpenPending = null, recordOpenUnknown = false;
  recordsRefresh.addEventListener('click', () => api.send({type:'records-refresh'}));
  recordsMore.addEventListener('click', () => api.send({type:'records-more'}));
  function canSwitch() { return !composing && !dirty && pendingEdit === null && pendingSubmit === null && !submitQueued && !expandQueued && !blockedDraft && !conflict && recordOpenPending === null; }
  function renderRecords() {
    records.hidden = !recordsOpen; recordsToggle.setAttribute('aria-expanded', String(recordsOpen));
    recordsToggle.setAttribute('aria-label', recordsOpen ? '收起项目记录' : '展开项目记录');
    recordsStatus.textContent = state.recordsStatus || ''; recordsMore.hidden = !state.recordsHasMore; recordsMore.disabled = state.recordsLoading === true; recordsRefresh.disabled = state.recordsLoading === true;
    const key = JSON.stringify(state.records || []); if (key === recordsRenderKey) return;
    recordsRenderKey = key; const scroll = recordsList.scrollTop, focused = document.activeElement?.dataset?.recordId;
    recordsList.replaceChildren();
    for (const item of state.records || []) {
      const row = document.createElement('button'); row.type = 'button'; row.textContent = item.project + ' · ' + item.title; row.dataset.recordId = item.id; row.disabled = item.enabled !== true;
      row.addEventListener('click', () => { if (!canSwitch()) { status.textContent = '请先等待草稿同步完成'; status.hidden = false; return; } recordOpenPending = {id:++recordOpenSequence}; const request = recordOpenPending; request.timer = setTimeout(() => { if (recordOpenPending !== request) return; recordOpenPending = null; conflict = true; recordOpenUnknown = true; status.textContent = '会话切换结果未确认，请展开工作区核对'; status.hidden = false; refresh(); }, 5000); refresh(); api.send({ type:'record-open', id:item.id, sessionToken:state.sessionToken, revision:state.revision, openId:request.id }); });
      recordsList.appendChild(row);
    }
    recordsList.scrollTop = scroll; if (focused) Array.from(recordsList.querySelectorAll('button')).find(row => row.dataset.recordId === focused)?.focus();
  }
  const task = document.getElementById('task'), taskToggle = document.getElementById('task-toggle'), taskList = document.getElementById('task-list'), taskStatus = document.getElementById('task-status');
  let taskDesired = null, taskKey = '', taskSession = '';
  const taskScroll = new Map();
  function renderTask(changedSession) {
    const open = taskDesired === null ? state.taskOpen === true : taskDesired;
    task.hidden = !open;
    taskToggle.setAttribute('aria-expanded', String(open));
    taskToggle.title = open ? '收起任务记录' : '查看任务进度与回复';
    taskStatus.textContent = state.taskStatus || '任务记录暂不可用，请展开工作区查看';
    taskStatus.setAttribute('aria-busy', String(state.taskRunning === true));
    const rows = Array.isArray(state.taskMessages) ? state.taskMessages : [], key = JSON.stringify([state.sessionToken, rows]);
    if (key === taskKey) return;
    const previous = taskScroll.get(state.sessionToken);
    const follow = changedSession ? previous?.follow !== false : taskList.scrollHeight - taskList.clientHeight - taskList.scrollTop < 32;
    const scroll = changedSession ? previous?.top || 0 : taskList.scrollTop;
    taskKey = key; taskSession = state.sessionToken; taskList.replaceChildren();
    for (const row of rows) {
      const item = document.createElement('article'), label = document.createElement('strong'), text = document.createElement('div');
      item.dataset.role = row.role;
      label.textContent = row.role === 'user' ? row.pending ? '你 · 待接收' : '你' : row.role === 'assistant' ? row.streaming ? '助手 · 回复中' : '助手' : '任务动态';
      text.textContent = row.text; item.append(label,text); taskList.appendChild(item);
    }
    if (!rows.length) { const empty = document.createElement('p'); empty.textContent = '当前会话还没有可显示的消息'; taskList.appendChild(empty); }
    taskList.scrollTop = follow ? taskList.scrollHeight : scroll;
  }
  taskList.addEventListener('scroll', () => { if (!taskSession) return; taskScroll.set(taskSession,{top:taskList.scrollTop,follow:taskList.scrollHeight-taskList.clientHeight-taskList.scrollTop<32}); if (taskScroll.size > 100) taskScroll.delete(taskScroll.keys().next().value); });
  taskToggle.addEventListener('click', () => { taskDesired = task.hidden; if (taskDesired) { recordsOpen = false; recordsDesired = false; renderRecords(); } renderTask(false); api.send({type:'task-toggle',open:taskDesired}); });
  recordsToggle.addEventListener('click', () => { recordsOpen = !recordsOpen; recordsDesired = recordsOpen; if (recordsOpen) { taskDesired = false; renderTask(false); } renderRecords(); api.send({type:'records-toggle', open:recordsOpen}); });
  resizeHandle.addEventListener('pointerdown', event => { if (event.button !== 0) return; resizing = {pointerId:event.pointerId, y:event.screenY,x:event.screenX}; resizeHandle.setPointerCapture(event.pointerId); event.preventDefault(); });
  resizeHandle.addEventListener('pointermove', event => { if (!resizing || resizing.pointerId !== event.pointerId) return; const delta = resizing.y - event.screenY, dx = resizing.x - event.screenX; if (delta || dx) { resizing.y = event.screenY; resizing.x = event.screenX; api.send({type:'records-resize', delta:Math.max(-4000,Math.min(4000,delta)), dx:Math.max(-4000,Math.min(4000,dx))}); } });
  resizeHandle.addEventListener('pointerup', () => { resizing = null; }); resizeHandle.addEventListener('pointercancel', () => { resizing = null; });
  resizeHandle.addEventListener('keydown', event => { if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return; event.preventDefault(); api.send({type:'records-resize',delta:event.key === 'ArrowUp' ? 20 : -20}); });
  expand.addEventListener('click', () => requestExpand('expand'));
  files.addEventListener('click', () => requestExpand('files'));

  copy.addEventListener('click', () => { message.focus(); message.select(); status.textContent = '草稿已选中，请按 ' + copyShortcut + ' 复制'; status.hidden = false; });
  api.onState(next => {
    if (!next || typeof next.value !== 'string' || typeof next.sessionToken !== 'string' || !Number.isSafeInteger(next.revision)) return;
    const changedSession = state.sessionToken !== next.sessionToken;
    if (changedSession) {
      // An unacknowledged draft belongs to the previous session. Never write
      // it into the new one or destroy it; leave it selectable for copying.
      if (pendingSubmit !== null) {
        clearTimeout(pendingSubmit.timer); message.value = pendingSubmit.value;
        draftOwner = pendingSubmit.sessionToken; rememberRecovery('submit-unknown'); submitUnknown = true;
      }
      blockedDraft = blockedDraft || composing || dirty || pendingEdit !== null || pendingSubmit !== null;
      if (blockedDraft) recoveryOwner = draftOwner || state.sessionToken;
      if (!blockedDraft) { dirty = false; conflict = false; }
      if (pendingEdit?.timer) clearTimeout(pendingEdit.timer);
      pendingEdit = null; pendingSubmit = null; submitQueued = false;
      if (blockedDraft) { expandQueued = false; confirmExpand = false; if (expandTimer !== null) clearTimeout(expandTimer); expandTimer = null; }
    }
    const sessionLabel = document.getElementById('session-label');
    if (sessionLabel) { sessionLabel.textContent = next.sessionLabel || '未选择会话'; sessionLabel.title = next.sessionLabel || '请先选择工作会话'; }
    state = next; if (recordOpenPending && next.settledRecordOpenId === recordOpenPending.id) { clearTimeout(recordOpenPending.timer); recordOpenPending = null; } if (recordsDesired !== null && recordsDesired === (next.recordsOpen === true)) recordsDesired = null; recordsOpen = recordsDesired === null ? next.recordsOpen === true : recordsDesired; renderRecords();
    if (taskDesired !== null && taskDesired === (next.taskOpen === true)) taskDesired = null;
    renderTask(changedSession);
    if (changedSession && !blockedDraft && next.sessionToken) {
      const saved = readRecovery(next.sessionToken);
      if (saved?.kind === 'submit-unknown') { blockedDraft = true; submitUnknown = true; recoveryOwner = next.sessionToken; message.value = saved.value; }
      else if (saved && saved.value === next.value) clearRecovery(next.sessionToken, next.value);
      else if (saved) { blockedDraft = true; recoveryOwner = next.sessionToken; message.value = saved.value; }
    }
    if (!changedSession && pendingEdit !== null && next.settledEditId === pendingEdit.id) {
      if (pendingEdit.timer) clearTimeout(pendingEdit.timer);
      if (next.editConflict) { conflict = true; submitQueued = false; expandQueued = false; confirmExpand = false; if (expandTimer !== null) clearTimeout(expandTimer); expandTimer = null; }
      else { dirty = message.value !== pendingEdit.value; if (!dirty && !composing && next.value === pendingEdit.value) { clearRecovery(draftOwner, next.value); draftOwner = ''; } }
      pendingEdit = null;
    }
    if (pendingSubmit !== null && next.settledSubmitId === pendingSubmit.id) { clearTimeout(pendingSubmit.timer); clearRecovery(pendingSubmit.sessionToken, pendingSubmit.value); draftOwner = ''; pendingSubmit = null; }
    if (!composing && !dirty && pendingEdit === null && pendingSubmit === null && !conflict && !blockedDraft) message.value = next.value;
    status.textContent = submitUnknown ? '发送结果未确认，可能已发送；请展开工作区核对，勿重复发送' : blockedDraft ? '会话已切换或发现未同步的本地草稿；请先复制再展开工作区处理' : conflict ? '原工作区草稿已变化；请先复制再展开工作区处理' : storageFailed && (dirty || composing || pendingEdit !== null || pendingSubmit !== null) ? '未同步输入暂不能保存到本机，请保持窗口打开' : (next.status || '');
    status.hidden = !status.textContent;
    refresh();
    if (!changedSession && !conflict && !blockedDraft) { sendEdit(); sendSubmit(); refresh(); finishExpand(); }
  });
  refresh();
})();
