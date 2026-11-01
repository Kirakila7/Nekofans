'use strict';
const path = require('node:path');

// A trusted, isolated child view can be layered above site WebContentsViews.
// This controller never sends a task: the host must bind each event to a real
// DSH session and validate it before acting.
function createNativeComposerController({ WebContentsView, ipcMain, baseDir = __dirname, getOverlayParent = () => null }) {
  let host = null, view = null, rect = null, enabled = false, attached = false, parent = null, ready = false, pendingSubmit = null, pendingEdit = null;
  let state = { value: '', placeholder: '工作区未连接', enabled: false, busy: false, sessionToken: '', revision: 0 };
  const listeners = [];
  function unlisten() { for (const [obj, event, fn] of listeners.splice(0)) obj.removeListener(event, fn); }
  function detach() { if (attached && parent && !parent.isDestroyed()) parent.contentView.removeChildView(view); attached = false; parent = null; }
  function close() {
    detach();
    if (view && !view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    view = null; ready = false; rect = null; enabled = false; pendingSubmit = null; pendingEdit = null; state = { value: '', placeholder: '工作区未连接', enabled: false, busy: false, sessionToken: '', revision: 0 };
    unlisten(); host = null;
  }
  function bind(window) {
    if (host === window) return;
    close(); host = window;
    const on = (obj, event, fn) => { obj.on(event, fn); listeners.push([obj, event, fn]); };
    on(window, 'hide', detach); on(window, 'minimize', detach); on(window, 'show', refresh); on(window, 'restore', refresh);
    on(window, 'resize', refresh); on(window, 'move', refresh); on(window, 'closed', close);
    on(window.webContents, 'will-navigate', close); on(window.webContents, 'destroyed', close); on(window.webContents, 'render-process-gone', close);
  }
  function bounds() {
    if (!host || !rect || !view || host.isDestroyed()) return;
    const zoom = host.webContents.getZoomFactor() || 1, [width, height] = host.getContentSize();
    const x = Math.max(0, Math.min(width, Math.round(rect.x * zoom))), y = Math.max(0, Math.min(height, Math.round(rect.y * zoom)));
    const right = Math.max(x, Math.min(width, Math.round((rect.x + rect.width) * zoom))), bottom = Math.max(y, Math.min(height, Math.round((rect.y + rect.height) * zoom)));
    if (right <= x || bottom <= y) { detach(); return; }
    // An owned video window is above every view in the root workbench. Put
    // this trusted input after the video in that same native content view.
    let target = host, offsetX = 0, offsetY = 0;
    const overlay = getOverlayParent();
    if (overlay && !overlay.isDestroyed() && overlay.isVisible() && typeof host.getContentBounds === 'function') {
      const root = host.getContentBounds(), area = overlay.getContentBounds();
      const localX = root.x + x - area.x, localY = root.y + y - area.y;
      if (localX >= 0 && localY >= 0 && localX + right - x <= area.width && localY + bottom - y <= area.height) {
        target = overlay; offsetX = area.x - root.x; offsetY = area.y - root.y;
      }
    }
    if (!attached || parent !== target) { detach(); target.contentView.addChildView(view); attached = true; parent = target; }
    view.setBounds({ x:x-offsetX, y:y-offsetY, width:right-x, height:bottom-y });
  }
  function publish() { if (ready && view && !view.webContents.isDestroyed()) view.webContents.send('neko-composer-state', state); }
  function unavailable(child) {
    if (view !== child) return;
    detach(); view = null; ready = false;
    if (rect && host && !host.isDestroyed() && !host.webContents.isDestroyed()) host.webContents.send('workbench:native-composer-event', { type: 'unavailable' });
    if (!child.webContents.isDestroyed()) child.webContents.close({ waitForBeforeUnload: false });
  }
  function refresh() {
    if (!host || host.isDestroyed() || !view || !ready || !enabled || !rect || host.isVisible?.() === false || host.isMinimized?.() === true) { detach(); return; }
    bounds(); publish();
  }
  function make() {
    const child = new WebContentsView({ webPreferences: { preload: path.join(baseDir, 'native-composer-preload.cjs'), partition: 'persist:neko-workspace-composer', sandbox: true, contextIsolation: true, nodeIntegration: false } });
    child.setBackgroundColor('#00000000'); view = child; ready = false;
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.webContents.on('will-navigate', event => event.preventDefault());
    child.webContents.on('render-process-gone', () => unavailable(child));
    void child.webContents.loadFile(path.join(baseDir, 'native-composer.html')).then(() => { if (view !== child) return; ready = true; refresh(); }).catch(() => unavailable(child));
  }
  function place(window, request) {
    if (!request || !['place', 'remove'].includes(request.action)) throw Error('无效悬浮输入操作');
    bind(window);
    if (request.action === 'remove') { rect = null; detach(); return { ok: true }; }
    const r = request.rect;
    if (!r || Object.keys(r).sort().join(',') !== 'height,width,x,y' || !Object.values(r).every(n => Number.isFinite(n) && Math.abs(n) < 100000) || r.width < 100 || r.width > 1200 || r.height < 32 || r.height > 1000) throw Error('无效悬浮输入位置');
    rect = { ...r }; if (!view) make(); refresh(); return { ok: true };
  }
  function update(snapshot) {
    if (!snapshot || typeof snapshot.value !== 'string' || snapshot.value.length > 30000 || typeof snapshot.sessionToken !== 'string' || snapshot.sessionToken.length > 512 || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw Error('无效工作会话状态');
    if (snapshot.sessionToken !== state.sessionToken) { pendingSubmit = null; pendingEdit = null; }
    if (pendingSubmit !== null && snapshot.settledSubmitId === pendingSubmit) pendingSubmit = null;
    if (pendingEdit !== null && snapshot.settledEditId === pendingEdit) pendingEdit = null;
    const records = Array.isArray(snapshot.records) ? snapshot.records.slice(0, 200).filter(item => item && typeof item.id === 'string' && item.id.length <= 512 && typeof item.title === 'string' && typeof item.project === 'string').map(item => ({id:item.id,title:item.title.slice(0,160),project:item.project.slice(0,120),enabled:item.enabled === true})) : [];
    state = { settledRecordOpenId:Number.isSafeInteger(snapshot.settledRecordOpenId) ? snapshot.settledRecordOpenId : null, records, recordsOpen:snapshot.recordsOpen === true, recordsHasMore:snapshot.recordsHasMore === true, recordsLoading:snapshot.recordsLoading === true, recordsStatus:typeof snapshot.recordsStatus === 'string' ? snapshot.recordsStatus.slice(0,160) : '', value: snapshot.value, settledEditId: Number.isSafeInteger(snapshot.settledEditId) ? snapshot.settledEditId : null, editConflict: snapshot.editConflict === true, status: typeof snapshot.status === 'string' ? snapshot.status.slice(0, 160) : '', settledSubmitId: Number.isSafeInteger(snapshot.settledSubmitId) ? snapshot.settledSubmitId : null, placeholder: typeof snapshot.placeholder === 'string' ? snapshot.placeholder.slice(0, 120) : '发消息或创建任务…', enabled: snapshot.enabled === true, busy: snapshot.busy === true, sessionToken: snapshot.sessionToken, revision: snapshot.revision };
    state.sessionLabel = typeof snapshot.sessionLabel === 'string' ? snapshot.sessionLabel.slice(0,240) : '';
    state.taskOpen = snapshot.taskOpen === true;
    state.taskStatus = typeof snapshot.taskStatus === 'string' ? snapshot.taskStatus.slice(0,160) : '';
    state.taskRunning = snapshot.taskRunning === true;
    state.taskMessages = Array.isArray(snapshot.taskMessages) ? snapshot.taskMessages.slice(-40).filter(row => row && typeof row.id === 'string' && ['user','assistant','activity'].includes(row.role) && typeof row.text === 'string').map(row => ({id:row.id.slice(0,512),role:row.role,text:row.text.slice(0,6000),streaming:row.streaming === true,pending:row.pending === true})) : [];
    publish(); return { ok: true };
  }
  function input(event, message) {
    if (!host || host.isDestroyed() || !view || !ready || !attached || !enabled || event.sender !== view.webContents || event.senderFrame !== view.webContents.mainFrame || !message || !['edit', 'submit', 'expand', 'files', 'task-toggle', 'records-toggle', 'records-resize', 'records-refresh', 'records-more', 'record-open'].includes(message.type)) return;
    if (message.type === 'files') {
      if (!state.enabled || !state.sessionToken || message.sessionToken !== state.sessionToken || message.revision !== state.revision || pendingEdit !== null || pendingSubmit !== null) { view.webContents.send('neko-composer-state', { ...state, status:'工作会话或草稿已变化，请展开工作区重试' }); return; }
      host.webContents.send('workbench:native-composer-event', {type:'files',sessionToken:state.sessionToken,revision:state.revision}); return;
    }
    if (message.type === 'records-refresh' || message.type === 'records-more') { if (!state.recordsLoading && (message.type !== 'records-more' || state.recordsHasMore)) host.webContents.send('workbench:native-composer-event', {type:message.type}); return; }
    if (message.type === 'records-toggle' || message.type === 'task-toggle') { if (typeof message.open === 'boolean') host.webContents.send('workbench:native-composer-event', {type:message.type,open:message.open}); return; }
    if (message.type === 'records-resize') { if (Number.isFinite(message.delta) && Math.abs(message.delta) <= 4000 && (message.dx === undefined || Number.isFinite(message.dx) && Math.abs(message.dx) <= 4000)) host.webContents.send('workbench:native-composer-event', {type:'records-resize',delta:message.delta,dx:message.dx || 0}); return; }
    if (message.type === 'record-open') {
      if (!Number.isSafeInteger(message.openId) || message.openId <= 0) return;
      if (pendingEdit !== null || pendingSubmit !== null || message.sessionToken !== state.sessionToken || message.revision !== state.revision || typeof message.id !== 'string' || !state.records?.some(row => row.id === message.id && row.enabled)) { view.webContents.send('neko-composer-state', {...state,settledRecordOpenId:message.openId,status:'工作会话已变化，请检查后重试'}); return; }
      host.webContents.send('workbench:native-composer-event', {type:'record-open',id:message.id,sessionToken:state.sessionToken,revision:state.revision,openId:message.openId}); return;
    }
    if (message.type !== 'expand') {
      const invalid = !state.enabled || !state.sessionToken || message.sessionToken !== state.sessionToken || message.revision !== state.revision || typeof message.value !== 'string' || message.value.length > 30000 || (message.type === 'edit' && (pendingEdit !== null || !Number.isSafeInteger(message.editId) || message.editId <= 0)) || (message.type === 'submit' && (state.busy || pendingSubmit !== null || !Number.isSafeInteger(message.submissionId) || message.submissionId <= 0 || !message.value.trim()));
      if (invalid) {
        // Never strand the user's draft when a session/revision changes before
        // a send reaches us. An in-flight send cannot be acknowledged here.
        if (message.type === 'edit' && pendingEdit === null && Number.isSafeInteger(message.editId) && message.editId > 0) view.webContents.send('neko-composer-state', { ...state, settledEditId: message.editId, editConflict: true, status: '原工作区草稿已变化，请展开工作区处理' });
        if (message.type === 'submit' && pendingSubmit === null && Number.isSafeInteger(message.submissionId) && message.submissionId > 0) view.webContents.send('neko-composer-state', { ...state, settledSubmitId: message.submissionId, status: '工作会话已变化，请检查后重试' });
        return;
      }
    }
    if (message.type === 'submit') pendingSubmit = message.submissionId;
    if (message.type === 'edit') pendingEdit = message.editId;
    if (!host.webContents.isDestroyed()) host.webContents.send('workbench:native-composer-event', message.type === 'expand' ? { type: 'expand' } : { type: message.type, value: message.value, sessionToken: state.sessionToken, revision: state.revision, ...(message.type === 'submit' ? {submissionId:message.submissionId} : {editId:message.editId}) });
  }
  ipcMain.on('neko-composer-input', input);
  return Object.freeze({ bind, place, update, setEnabled(value) { enabled = value === true; refresh(); }, raise() { if (rect) { detach(); refresh(); } }, releaseParent(window) { if (parent === window) detach(); }, dispose() { close(); ipcMain.removeListener('neko-composer-input', input); } });
}
module.exports = { createNativeComposerController };
