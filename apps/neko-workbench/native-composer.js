'use strict';
(() => {
  const api = window.nativeComposer, form = document.getElementById('composer'), message = document.getElementById('message'), send = document.getElementById('send'), expand = document.getElementById('expand'), files = document.getElementById('files'), copy = document.getElementById('copy'), status = document.getElementById('status'), target = document.getElementById('target');
  const copyShortcut = api.platform && api.platform !== 'darwin' ? 'Ctrl+C' : '⌘C';
  document.documentElement.dataset.platform = api.platform || '';
  copy.title = '选中草稿后按 ' + copyShortcut + ' 复制';
  let state = { value:'', enabled:false, busy:false, sessionToken:'', revision:0 }, composing = false, dirty = false, conflict = false, blockedDraft = false, submitUnknown = false;
  let pendingEdit = null, pendingSubmit = null, submitQueued = false, expandQueued = false, expandAction = 'expand', confirmExpand = false, expandTimer = null, editSequence = 0, submitSequence = 0;
  let draftOwner = '', recoveryOwner = '', storageFailed = false;
  let pendingModel = null, modelSequence = 0, modelUnknown = false, modelRefreshPending = false, unconfirmedModelId = null;
  let questionForm=null,questionSelectionSequence=0;
  const windowDrag = document.getElementById('window-drag');
  const detailsToggle = document.getElementById('details-toggle');
  let detailsGesture = null, suppressDetailsClick = 0;
  // The details arrow owns its own press: holding or dragging it resizes the
  // details instead of moving the window, and a resize never counts as a click.
  // Registered before hold-drag so its capture listener never sees this press.
  document.addEventListener('pointerdown', event => {
    if (!detailsToggle.contains(event.target) || event.button !== 0) return;
    event.stopImmediatePropagation(); finishDetailsGesture(true);
    const gesture = { pointerId:event.pointerId, y:event.screenY, startY:event.screenY, resizing:false };
    gesture.timer = window.setTimeout(() => { if (detailsGesture === gesture) startDetailsResize(gesture); }, 380);
    detailsGesture = gesture; suppressDetailsClick = 0;
    try { detailsToggle.setPointerCapture?.(event.pointerId); } catch {}
  }, true);
  function startDetailsResize(gesture) { gesture.resizing = true; detailsToggle.setAttribute('data-resizing', ''); }
  function finishDetailsGesture(cancelled = false) {
    const gesture = detailsGesture; detailsGesture = null; if (!gesture) return;
    window.clearTimeout(gesture.timer); detailsToggle.removeAttribute('data-resizing');
    if (gesture.resizing && !cancelled) suppressDetailsClick = Date.now();
    try { detailsToggle.releasePointerCapture?.(gesture.pointerId); } catch {}
  }
  detailsToggle.addEventListener('pointermove', event => {
    const gesture = detailsGesture; if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (!gesture.resizing && Math.abs(event.screenY - gesture.startY) > 4) startDetailsResize(gesture);
    if (!gesture.resizing) return;
    event.preventDefault();
    const delta = Math.round(gesture.y - event.screenY);
    if (delta) { gesture.y = event.screenY; api.send({type:'details-resize',delta:Math.max(-4000,Math.min(4000,delta))}); }
  });
  for (const type of ['pointerup','pointercancel','lostpointercapture']) detailsToggle.addEventListener(type, event => { if (detailsGesture && detailsGesture.pointerId === event.pointerId) finishDetailsGesture(false); });
  window.addEventListener('blur', () => finishDetailsGesture(false));
  window.installNekoHoldDrag?.(document,delta=>api.send({type:'move',...delta}));
  windowDrag?.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(event.key))return;event.preventDefault();const step=event.shiftKey?32:8;
    api.send(event.key==='Home'?{type:'move',reset:true}:{type:'move',dx:event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0,dy:event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0});
  });
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
    document.body.toggleAttribute('data-desktop',state.desktop === true);
    expand.hidden = files.hidden = state.chatOnly === true;
    message.disabled = !blockedDraft && (!state.enabled || !state.sessionToken);
    message.readOnly = blockedDraft || conflict || submitQueued || pendingSubmit !== null || recordOpenPending !== null || projectSelectPending !== null || pendingModel !== null || state.modelBusy === true || (expandQueued && !composing);
    message.placeholder = '创造台';
    copy.hidden = !(blockedDraft || conflict);
    files.disabled = message.disabled || conflict || blockedDraft || pendingSubmit !== null || submitQueued || expandQueued || recordOpenPending !== null;
    send.disabled = !!state.question || message.disabled || state.busy || conflict || blockedDraft || submitQueued || pendingSubmit !== null || recordOpenPending !== null || projectSelectPending !== null || pendingModel !== null || state.modelBusy === true || modelUnknown || !!state.modelError || (state.targetRequired === true && !state.targetLabel) || !message.value.trim();
    target.textContent = state.targetLabel ? '创造台：' + state.targetLabel : state.chatOnly ? '从项目记录选择会话' : '当前会话未确认，请展开工作区核对';
    target.title = target.textContent;
    target.hidden = true;
    renderModels(); renderProjects(); renderDetails();
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
    if (state.question || !submitQueued || pendingEdit !== null || dirty || conflict || blockedDraft || !state.enabled || !state.sessionToken || state.busy || state.modelBusy || pendingModel !== null || modelUnknown || state.modelError) return;
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
    if (state.chatOnly) return;
    if (action === 'files' && (blockedDraft || conflict || !state.enabled || !state.sessionToken)) return;
    if (recordOpenPending) { status.textContent = '正在切换会话，请稍候'; status.hidden = false; return; }
    if (recordOpenUnknown && !message.value) { api.send({type:'expand'}); return; }
    if (blockedDraft || conflict) {
      const saved = readRecovery(recoveryOwner || draftOwner);
      if (!saved || saved.value !== message.value) {
        status.textContent = '草稿副本暂未保存，请复制内容并保持窗口打开'; status.hidden = false; return;
      }
      if (!confirmExpand) { confirmExpand = true; status.textContent = submitUnknown ? '任务可能已发送；再点一次展开工作区核对，本机副本会保留' : '未同步草稿会保留在本机，再点一次展开工作区'; status.hidden = false; return; }
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
  const modelPanel = document.getElementById('model-panel'), modelToggle = document.getElementById('model-toggle'), modelSelect = document.getElementById('model-select'), reasoningSelect = document.getElementById('reasoning-select'), modelRefresh = document.getElementById('model-refresh'), modelStatus = document.getElementById('model-status');
  let modelOpen = false, modelDesired = null;
  const modelOptions = () => Array.isArray(state.modelOptions) ? state.modelOptions.filter(option => option && typeof option.id === 'string' && typeof option.label === 'string') : [];
  function fillSelect(select, options, selected, emptyLabel) {
    const key = JSON.stringify([options,selected]);
    if (select.dataset.optionsKey === key && select.value === (selected || '')) return;
    select.dataset.optionsKey = key;
    const rows = options.length && selected ? options : [{id:'',label:emptyLabel},...options];
    select.replaceChildren(...rows.map(row => { const option = document.createElement('option'); option.value = row.id; option.textContent = row.label; return option; }));
    select.value = rows.some(row => row.id === selected) ? selected : '';
    if (!select.value && selected) { const unavailable = document.createElement('option'); unavailable.value = selected; unavailable.textContent = '当前选择暂不可用'; unavailable.disabled = true; select.appendChild(unavailable); select.value = selected; }
  }
  function syncPanelAttr() { document.body.toggleAttribute('data-panel-open', modelOpen || recordsOpen || projectOpen || detailsOpen || questionForm?.isOpen()); }
  function renderModels() {
    modelPanel.hidden = !modelOpen; syncPanelAttr();
    modelPanel.setAttribute('aria-busy', String(state.modelBusy === true || pendingModel !== null));
    modelToggle.setAttribute('aria-expanded', String(modelOpen));
    modelToggle.title = [state.modelLabel,state.reasoningLabel].filter(Boolean).join(' · ') || '模型与推理等级';
    const options = modelOptions(), current = options.find(option => option.id === state.modelId);
    fillSelect(modelSelect, options, state.modelId || '', state.modelBusy ? '正在读取模型…' : '暂无可用模型');
    const reasoning = Array.isArray(current?.reasoningOptions) ? current.reasoningOptions.filter(option => option && typeof option.id === 'string' && typeof option.label === 'string') : [];
    fillSelect(reasoningSelect, reasoning, state.reasoningId || '', '使用模型默认值');
    const blocked = !canSwitch() || !state.enabled || !state.sessionToken || state.busy || state.modelBusy === true;
    modelSelect.disabled = blocked || !options.length;
    reasoningSelect.disabled = blocked || !reasoning.length;
    modelRefresh.disabled = state.modelBusy === true || pendingModel !== null;
    modelStatus.textContent = modelUnknown ? '模型设置结果未确认，请刷新模型后再发送' : state.modelError || (pendingModel !== null ? '正在应用模型设置…' : state.modelBusy ? '正在读取模型设置…' : '');
    modelStatus.hidden = !modelStatus.textContent;
  }
  modelToggle.addEventListener('click', () => {
    modelOpen = !modelOpen; modelDesired = modelOpen;
    if (modelOpen) { recordsOpen = false; recordsDesired = false; renderRecords(); closeLocalPanels(); }
    renderModels(); api.send({type:'model-toggle',open:modelOpen});
  });
  modelRefresh.addEventListener('click', () => { modelRefreshPending = true; api.send({type:'model-refresh',...(unconfirmedModelId ? {selectionId:unconfirmedModelId} : {})}); });
  function selectModel() {
    if (!canSwitch() || !state.enabled || !state.sessionToken || state.modelBusy || state.busy) { renderModels(); return; }
    const option = modelOptions().find(row => row.id === modelSelect.value);
    if (!option) return;
    const choices = option.reasoningOptions || [];
    const reasoningId = choices.some(row => row.id === reasoningSelect.value) ? reasoningSelect.value : choices.some(row => row.id === 'high') ? 'high' : choices[0]?.id || '';
    const request = {id:++modelSequence}; pendingModel = request;
    request.timer = setTimeout(() => { if (pendingModel !== request) return; pendingModel = null; unconfirmedModelId = request.id; modelUnknown = true; status.textContent = '模型设置结果未确认，请刷新模型后再发送'; status.hidden = false; refresh(); }, 10000);
    refresh();
    api.send({type:'model-select',modelId:option.id,reasoningId,sessionToken:state.sessionToken,revision:state.revision,selectionId:request.id});
  }
  modelSelect.addEventListener('change', selectModel);
  reasoningSelect.addEventListener('change', selectModel);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !(modelOpen || recordsOpen || projectOpen || detailsOpen)) return;
    event.preventDefault();
    if (recordsOpen) { closeRecords(); modelToggle.focus(); }
    else if (modelOpen) { modelOpen = false; modelDesired = false; renderModels(); api.send({type:'model-toggle',open:false}); modelToggle.focus(); }
    else if (projectOpen) { setProjectOpen(false); projectToggle.focus(); }
    else { setDetailsOpen(false); detailsToggle.focus(); }
  });
  recordsRefresh.addEventListener('click', () => api.send({type:'records-refresh'}));
  recordsMore.addEventListener('click', () => api.send({type:'records-more'}));
  function canSwitch() { return !composing && !dirty && pendingEdit === null && pendingSubmit === null && !submitQueued && !expandQueued && !blockedDraft && !conflict && recordOpenPending === null && projectSelectPending === null && pendingModel === null && state.modelBusy !== true && !modelUnknown; }
  function renderRecords() {
    records.hidden = !recordsOpen; syncPanelAttr(); recordsToggle.setAttribute('aria-expanded', String(recordsOpen));
    recordsToggle.setAttribute('aria-label', recordsOpen ? '收起项目记录' : '展开项目记录');
    recordsStatus.textContent = state.recordsStatus || ''; recordsMore.hidden = !state.recordsHasMore; recordsMore.disabled = state.recordsLoading === true; recordsRefresh.disabled = state.recordsLoading === true;
    const key = JSON.stringify(state.records || []); if (key === recordsRenderKey) return;
    recordsRenderKey = key; const scroll = recordsList.scrollTop, focused = document.activeElement?.dataset?.recordId;
    recordsList.replaceChildren();
    for (const item of state.records || []) {
      const row = document.createElement('button'); row.type = 'button'; row.textContent = item.project + ' · ' + item.title; row.dataset.recordId = item.id; row.disabled = item.enabled !== true;
      row.addEventListener('click', () => openRecord(item.id));
      recordsList.appendChild(row);
    }
    recordsList.scrollTop = scroll; if (focused) Array.from(recordsList.querySelectorAll('button')).find(row => row.dataset.recordId === focused)?.focus();
  }
  function openRecord(id) { if (!canSwitch()) { status.textContent = '请先等待草稿同步完成'; status.hidden = false; return; } recordOpenPending = {id:++recordOpenSequence}; const request = recordOpenPending; request.timer = setTimeout(() => { if (recordOpenPending !== request) return; recordOpenPending = null; conflict = true; recordOpenUnknown = true; status.textContent = '会话切换结果未确认，请展开工作区核对'; status.hidden = false; refresh(); }, 5000); refresh(); api.send({ type:'record-open', id, sessionToken:state.sessionToken, revision:state.revision, openId:request.id }); }
  recordsToggle.addEventListener('click', () => { recordsOpen = !recordsOpen; recordsDesired = recordsOpen; if (recordsOpen) { modelOpen = false; modelDesired = false; renderModels(); closeLocalPanels(); } renderRecords(); api.send({type:'records-toggle', open:recordsOpen}); });
  function closeRecords() { recordsOpen = false; recordsDesired = false; renderRecords(); api.send({type:'records-toggle',open:false}); }
  document.getElementById('records-close').addEventListener('click', closeRecords);
  // ---- workspace project chooser and current-project details ------------
  const projectToggle = document.getElementById('project-toggle'), projectPanel = document.getElementById('project-panel'), projectList = document.getElementById('project-list'), projectStatus = document.getElementById('project-status');
  const details = document.getElementById('details'), detailsName = document.getElementById('details-name'), detailsBadge = document.getElementById('details-badge'), detailsPath = document.getElementById('details-path'), detailsStatus = document.getElementById('details-status');
  let projectOpen = false, projectDesired = null, detailsOpen = false, detailsDesired = null, projectSelectPending = null, projectSelectSequence = 0, projectRenderKey = '', detailsRenderKey = '';
  const projects = () => Array.isArray(state.projects) ? state.projects.filter(row => row && typeof row.id === 'string' && typeof row.name === 'string') : [];
  function closeLocalPanels() {
    if (projectOpen) { projectOpen = false; projectDesired = false; }
    if (detailsOpen) { detailsOpen = false; detailsDesired = false; }
    renderProjects(); renderDetails();
  }
  function setProjectOpen(open) {
    projectOpen = open; projectDesired = open;
    if (open) { modelOpen = recordsOpen = detailsOpen = false; modelDesired = recordsDesired = detailsDesired = false; renderModels(); renderRecords(); renderDetails(); }
    renderProjects(); api.send({type:'project-toggle',open});
  }
  function setDetailsOpen(open) {
    detailsOpen = open; detailsDesired = open;
    if (open) { modelOpen = recordsOpen = projectOpen = false; modelDesired = recordsDesired = projectDesired = false; renderModels(); renderRecords(); renderProjects(); }
    renderDetails(); api.send({type:'details-toggle',open});
  }
  projectToggle.addEventListener('click', () => setProjectOpen(!projectOpen));
  document.getElementById('project-close').addEventListener('click', () => { setProjectOpen(false); projectToggle.focus(); });
  document.getElementById('project-refresh').addEventListener('click', () => api.send({type:'project-refresh'}));
  detailsToggle.addEventListener('click', event => {
    if (suppressDetailsClick && Date.now() - suppressDetailsClick < 800) { suppressDetailsClick = 0; event.preventDefault(); return; }
    suppressDetailsClick = 0; setDetailsOpen(!detailsOpen);
  });
  detailsToggle.addEventListener('keydown', event => { if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return; event.preventDefault(); api.send({type:'details-resize',delta:event.key === 'ArrowUp' ? 40 : -40}); });
  function selectProject(row) {
    if (row.current === true) { setProjectOpen(false); return; }
    // DSH only switches a clean session; say so here rather than after a round trip.
    if (message.value.trim() || !canSwitch()) { projectStatus.textContent = '请先发送或清空当前草稿，再切换项目'; return; }
    const request = {id:++projectSelectSequence}; projectSelectPending = request;
    request.timer = setTimeout(() => { if (projectSelectPending !== request) return; projectSelectPending = null; status.textContent = '项目切换结果未确认，请刷新项目后核对'; status.hidden = false; refresh(); }, 10000);
    projectStatus.textContent = '正在切换到 ' + row.name + '…'; refresh();
    api.send({type:'project-select',projectId:row.id,sessionToken:state.sessionToken,revision:state.revision,selectId:request.id});
  }
  function renderProjects() {
    projectPanel.hidden = !projectOpen; projectToggle.setAttribute('aria-expanded', String(projectOpen));
    const current = projects().find(row => row.current === true);
    projectToggle.title = current ? '工作区项目：' + current.name : '工作区项目';
    projectToggle.setAttribute('aria-label', current ? '选择工作区项目，当前 ' + current.name : '选择工作区项目');
    projectPanel.setAttribute('aria-busy', String(projectSelectPending !== null));
    if (projectSelectPending === null) projectStatus.textContent = typeof state.projectsStatus === 'string' ? state.projectsStatus : '';
    const locked = projectSelectPending !== null || !canSwitch();
    const key = JSON.stringify([projects(), locked]); if (key === projectRenderKey) return;
    projectRenderKey = key; const scroll = projectList.scrollTop, focused = document.activeElement?.dataset?.projectId;
    projectList.replaceChildren(...projects().map(row => {
      const item = document.createElement('button'); item.type = 'button'; item.dataset.projectId = row.id; item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(row.current === true)); if (row.current) item.setAttribute('aria-current', 'true');
      const name = document.createElement('strong'); name.textContent = row.name;
      const meta = document.createElement('span'); meta.textContent = (row.registered === false ? '历史项目 · ' : '') + (Number.isSafeInteger(row.sessions) ? row.sessions + ' 个会话' : '');
      item.append(name, meta); item.title = typeof row.path === 'string' ? row.path : row.name; item.disabled = locked && row.current !== true;
      item.addEventListener('click', () => selectProject(row)); return item;
    }));
    projectList.scrollTop = scroll; if (focused) Array.from(projectList.querySelectorAll('button')).find(item => item.dataset.projectId === focused)?.focus();
  }
  const relative = time => { if (!Number.isFinite(time) || time <= 0) return ''; const minutes = Math.max(0, Math.round((Date.now() - time) / 60000)); return minutes < 1 ? '刚刚' : minutes < 60 ? minutes + ' 分钟前' : minutes < 1440 ? Math.round(minutes / 60) + ' 小时前' : Math.round(minutes / 1440) + ' 天前'; };
  const detailsContent = document.getElementById('details-content');
  let contentRenderKey = '';
  // Real text of the current session as the official chat projection shows
  // it. A snapshot for another session is never displayed under this one.
  function renderWorkContent() {
    const work = state.workContent && typeof state.workContent === 'object' ? state.workContent : null;
    const current = !!work && !!state.sessionToken && work.sessionId === state.sessionToken;
    const items = current && Array.isArray(work.items) ? work.items.filter(row => row && typeof row.id === 'string' && typeof row.text === 'string' && (row.role === 'user' || row.role === 'assistant')) : [];
    const note = !state.sessionToken ? '尚未打开工作会话' : !current || work.status === 'loading' ? '正在读取当前会话内容…' : work.status === 'unavailable' ? '当前会话内容暂不可读取' : !items.length ? '当前会话还没有对话内容' : work.source === 'outline' ? '仅显示官方会话概要，内容已被截短' : work.truncated ? '仅显示最近的对话内容' : '';
    const key = JSON.stringify([items, note]); if (key === contentRenderKey) return; contentRenderKey = key;
    const atBottom = detailsContent.scrollHeight - detailsContent.scrollTop - detailsContent.clientHeight < 24;
    const rows = items.map(row => {
      const item = document.createElement('article'); item.className = 'work-item'; item.dataset.role = row.role;
      const who = document.createElement('small'); who.textContent = row.role === 'user' ? '我' : '工作 agent';
      const text = document.createElement('p'); text.textContent = row.text;
      item.append(who, text); return item;
    });
    if (note) { const info = document.createElement('p'); info.className = 'work-note'; info.textContent = note; rows.unshift(info); }
    detailsContent.replaceChildren(...rows);
    if (atBottom || !detailsContent.dataset.seen) { detailsContent.scrollTop = detailsContent.scrollHeight; detailsContent.dataset.seen = ''; }
  }
  function renderDetails() {
    details.hidden = !detailsOpen; syncPanelAttr();
    detailsToggle.setAttribute('aria-expanded', String(detailsOpen));
    detailsToggle.setAttribute('aria-label', detailsOpen ? '收起当前项目详情' : '展开当前项目详情');
    detailsToggle.title = (detailsOpen ? '收起当前项目详情' : '展开当前项目详情') + ' · 按住或拖动调整高度';
    const project = state.currentProject && typeof state.currentProject === 'object' ? state.currentProject : null;
    detailsStatus.textContent = state.targetLabel ? '当前：' + state.targetLabel : state.sessionToken ? '' : '尚未打开工作会话';
    if (detailsOpen) renderWorkContent();
    const key = JSON.stringify([project, canSwitch()]); if (key === detailsRenderKey) return; detailsRenderKey = key;
    detailsName.textContent = project ? project.name : '当前会话未关联已登记项目';
    detailsBadge.textContent = project ? project.registered === false ? '历史项目' : '已登记' : '';
    detailsPath.textContent = project?.path || ''; detailsPath.title = project?.path || '';
  }
  resizeHandle.addEventListener('pointerdown', event => { if (event.button !== 0) return; resizing = {pointerId:event.pointerId, y:event.screenY,x:event.screenX}; resizeHandle.setPointerCapture(event.pointerId); event.preventDefault(); });
  resizeHandle.addEventListener('pointermove', event => { if (!resizing || resizing.pointerId !== event.pointerId) return; const delta = resizing.y - event.screenY, dx = resizing.x - event.screenX; if (delta || dx) { resizing.y = event.screenY; resizing.x = event.screenX; api.send({type:'records-resize', delta:Math.max(-4000,Math.min(4000,delta)), dx:Math.max(-4000,Math.min(4000,dx))}); } });
  resizeHandle.addEventListener('pointerup', () => { resizing = null; }); resizeHandle.addEventListener('pointercancel', () => { resizing = null; });
  resizeHandle.addEventListener('keydown', event => { if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return; event.preventDefault(); api.send({type:'records-resize',delta:event.key === 'ArrowUp' ? 20 : -20}); });
  expand.addEventListener('click', () => requestExpand('expand'));
  files.addEventListener('click', () => requestExpand('files'));

  copy.addEventListener('click', () => { message.focus(); message.select(); status.textContent = '草稿已选中，请按 ' + copyShortcut + ' 复制'; status.hidden = false; });
  if(window.WorkbenchQuestions&&document.getElementById('question-panel'))questionForm=window.WorkbenchQuestions.mount({host:document.getElementById('question-panel'),toggleButton:document.getElementById('question-toggle'),
    onVisibility:(open,q)=>{document.body.toggleAttribute('data-question-open',open);api.send({type:'question-visibility',open,...(q?{sessionId:q.sessionId,key:q.key,revision:q.revision}:{})});syncPanelAttr();},
    onAction:action=>api.send({...action,type:'question-action',questionAction:action.type,...(action.type==='answer'?{questionSelectionId:++questionSelectionSequence}:{})})});
  for(const id of ['model-toggle','project-toggle'])document.getElementById(id)?.addEventListener('click',()=>questionForm?.hide(),true);
  api.onState(next => {
    if (!next || typeof next.value !== 'string' || typeof next.sessionToken !== 'string' || !Number.isSafeInteger(next.revision)) return;
    const changedSession = state.sessionToken !== next.sessionToken;
    if (changedSession) {
      if (pendingModel?.timer) clearTimeout(pendingModel.timer);
      pendingModel = null; modelUnknown = false; modelRefreshPending = false; unconfirmedModelId = null;
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
    state = next; if (recordOpenPending && next.settledRecordOpenId === recordOpenPending.id) { clearTimeout(recordOpenPending.timer); recordOpenPending = null; } if (recordsDesired !== null && recordsDesired === (next.recordsOpen === true)) recordsDesired = null; recordsOpen = recordsDesired === null ? next.recordsOpen === true : recordsDesired; renderRecords();
    if (modelDesired !== null && modelDesired === (next.modelOpen === true)) modelDesired = null;
    modelOpen = !recordsOpen && (modelDesired === null ? next.modelOpen === true : modelDesired);
    if (projectDesired !== null && projectDesired === (next.projectOpen === true)) projectDesired = null;
    if (detailsDesired !== null && detailsDesired === (next.detailsOpen === true)) detailsDesired = null;
    projectOpen = !recordsOpen && !modelOpen && (projectDesired === null ? next.projectOpen === true : projectDesired);
    detailsOpen = !recordsOpen && !modelOpen && !projectOpen && (detailsDesired === null ? next.detailsOpen === true : detailsDesired);
    if (projectSelectPending && next.settledProjectSelectId === projectSelectPending.id) { clearTimeout(projectSelectPending.timer); projectSelectPending = null; projectRenderKey = ''; }
    questionForm?.update(next.question?.sessionId===next.sessionToken?next.question:null);
    if (pendingModel && next.settledModelSelectionId === pendingModel.id) { clearTimeout(pendingModel.timer); pendingModel = null; modelUnknown = false; unconfirmedModelId = null; }
    if (modelRefreshPending && !next.modelBusy && next.modelId && modelOptions().some(option => option.id === next.modelId) && (!unconfirmedModelId || next.settledModelSelectionId === unconfirmedModelId)) { modelUnknown = false; modelRefreshPending = false; unconfirmedModelId = null; }
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
    if (pendingSubmit !== null && next.settledSubmitId === pendingSubmit.id) {
      const request = pendingSubmit; clearTimeout(request.timer); pendingSubmit = null;
      if (next.submitUnknown === true) {
        message.value = request.value; draftOwner = request.sessionToken;
        rememberRecovery('submit-unknown'); submitUnknown = true; conflict = true;
        submitQueued = false; expandQueued = false; confirmExpand = false;
        if (expandTimer !== null) clearTimeout(expandTimer); expandTimer = null;
      } else { clearRecovery(request.sessionToken, request.value); draftOwner = ''; }
    }
    if (!composing && !dirty && pendingEdit === null && pendingSubmit === null && !conflict && !blockedDraft) message.value = next.value;
    status.textContent = submitUnknown ? '发送结果未确认，可能已发送；请展开工作区核对，勿重复发送' : blockedDraft ? '会话已切换或发现未同步的本地草稿；请先复制再展开工作区处理' : conflict ? '原工作区草稿已变化；请先复制再展开工作区处理' : modelUnknown ? '模型设置结果未确认，请刷新模型后再发送' : storageFailed && (dirty || composing || pendingEdit !== null || pendingSubmit !== null) ? '未同步输入暂不能保存到本机，请保持窗口打开' : (next.status || next.modelError || '');
    status.hidden = !status.textContent;
    refresh();
    if (!changedSession && !conflict && !blockedDraft) { sendEdit(); sendSubmit(); refresh(); finishExpand(); }
  });
  refresh();
})();
