'use strict';
const path = require('node:path');
const { snapFloatingBounds } = require('./floating-window-snap.cjs');
const { createFloatingMenuLayer } = require('./floating-menu-layer.cjs');
const questionForms=require('./compact-questions.js');

// A trusted, isolated child view can be layered above site WebContentsViews.
// This controller never sends a task: the host must bind each event to a real
// DSH session and validate it before acting.
function createNativeComposerController({ WebContentsView, BrowserWindow, screen, ipcMain, baseDir = __dirname, platform = process.platform }) {
  const desktop = typeof BrowserWindow === 'function';
  let moved = false, applyingBounds = false, nativeMoving = false, lastApplied = null, relativePosition = null, lastHostOrigin = null, positionKey = 'default';
  const positions = new Map();
  let host = null, view = null, rect = null, enabled = false, attached = false, ready = false, pendingSubmit = null, pendingEdit = null, pendingModel = null, pendingProject = null;
  let menuLayer = null, nativeDismissed = false, deferredMenuShow = false;
  let state = { value: '', placeholder: '创造台未连接', enabled: false, busy: false, sessionToken: '', revision: 0 };
  let pendingQuestion=null;
  const listeners = [];
  function unlisten() { for (const [obj, event, fn] of listeners.splice(0)) obj.removeListener(event, fn); }
  function detach() { nativeMoving=false;deferredMenuShow=false; if (desktop) { if (view && !view.isDestroyed()) view.hide(); } else if (attached && host && !host.isDestroyed()) host.contentView.removeChildView(view); attached = false; }
  function close() {
    pendingQuestion=null;
    menuLayer?.dispose(); menuLayer=null;
    detach();
    if (view && !view.webContents.isDestroyed()) { if (desktop) view.destroy(); else view.webContents.close({ waitForBeforeUnload: false }); }
    view = null; ready = false; rect = null; enabled = false; pendingSubmit = null; pendingEdit = null; pendingModel=null; pendingProject=null; state = { value: '', placeholder: '创造台未连接', enabled: false, busy: false, sessionToken: '', revision: 0 };
    unlisten(); host = null; moved = false; nativeMoving = false; nativeDismissed = false; relativePosition = null; lastHostOrigin = null; lastApplied = null; positionKey = 'default'; positions.clear();
  }
  function wantsDesktopVisible() { return !!(desktop&&host&&!host.isDestroyed()&&view&&!view.isDestroyed()&&enabled&&ready&&rect&&!nativeDismissed&&host.isVisible?.()!==false&&host.isMinimized?.()!==true); }
  function refreshMenuLayer() {
    const displayAllowed=menuLayer?.refresh()!==false;
    if(deferredMenuShow&&displayAllowed&&wantsDesktopVisible()){deferredMenuShow=false;view.showInactive();}
    return displayAllowed;
  }
  function bind(window) {
    if (host === window) return;
    close(); host = window;
    if(desktop)menuLayer=createFloatingMenuLayer({getWindow:()=>view,getOwner:()=>host,canShow:wantsDesktopVisible,showWindow:()=>{if(wantsDesktopVisible()){deferredMenuShow=false;view.showInactive();}},platform});
    const on = (obj, event, fn) => { obj.on(event, fn); listeners.push([obj, event, fn]); };
    on(window, 'hide', detach); on(window, 'minimize', detach); on(window, 'show', refresh); on(window, 'restore', refresh);
    for(const name of ['resize','maximize','unmaximize','enter-full-screen','leave-full-screen'])on(window,name,refresh);
    on(window, 'closed', close);
    // Recompute from an owner-relative DIP offset, rather than adding a delta
    // to the child: some native owned windows have already followed the move.
    on(window, 'move', bounds);
    on(window.webContents, 'zoom-changed', bounds);
    on(window.webContents, 'will-navigate', close); on(window.webContents, 'destroyed', close); on(window.webContents, 'render-process-gone', close);
  }
  function bounds() {
    if (!host || !rect || !view || host.isDestroyed()) return;
    const zoom = host.webContents.getZoomFactor() || 1, [width, height] = host.getContentSize();
    if(view.webContents.getZoomFactor()!==zoom)view.webContents.setZoomFactor?.(zoom);
    if (desktop) {
      const parent = host.getContentBounds(), old = view.getBounds();
      lastHostOrigin = {x:parent.x,y:parent.y};
      // A moved desk keeps its bottom edge when a panel changes its height,
      // so closing the panel returns the input to where it was dragged.
      const height=Math.round(rect.height*zoom),anchored=moved&&relativePosition,lift=anchored&&Number.isFinite(relativePosition.cssHeight)?Math.round((relativePosition.cssHeight-rect.height)*zoom):0;
      const desired = { x:Math.round(parent.x + (anchored ? relativePosition.x : rect.x*zoom)), y:Math.round(parent.y + (anchored ? relativePosition.y+lift : rect.y*zoom)), width:Math.round(rect.width*zoom), height };
      if(lift<0)desired.y=Math.max(parent.y,desired.y);
      const area = screen?.getDisplayMatching?.(desired)?.workArea;
      if (area) { desired.width=Math.min(desired.width,area.width); desired.height=Math.min(desired.height,area.height); desired.x=Math.max(area.x,Math.min(area.x+area.width-desired.width,desired.x)); desired.y=Math.max(area.y,Math.min(area.y+area.height-desired.height,desired.y)); }
      lastApplied = {...desired};
      if (Object.keys(desired).some(key=>old[key]!==desired[key])) { applyingBounds=true; try { view.setBounds(desired); } finally { applyingBounds=false; } }
      refreshMenuLayer();
      return;
    }
    const x = Math.max(0, Math.min(width, Math.round(rect.x * zoom))), y = Math.max(0, Math.min(height, Math.round(rect.y * zoom)));
    const right = Math.max(x, Math.min(width, Math.round((rect.x + rect.width) * zoom))), bottom = Math.max(y, Math.min(height, Math.round((rect.y + rect.height) * zoom)));
    if (right <= x || bottom <= y) { detach(); return; }
    view.setBounds({ x, y, width: right - x, height: bottom - y });
  }
  function publish() { if (ready && view && !view.webContents.isDestroyed()) view.webContents.send('neko-composer-state', {...state,desktop}); }
  function rememberDesktopPosition() {
    const parent=host.getContentBounds(), actual=view.getBounds();
    moved=true;relativePosition={x:actual.x-parent.x,y:actual.y-parent.y,cssHeight:rect?.height};lastApplied={...actual};
    positions.set(positionKey,{moved:true,relativePosition:{...relativePosition}});
  }
  function finishDesktopDrag() {
    if(!desktop||!host||host.isDestroyed()||!view||view.isDestroyed()||!ready||!attached||!enabled||menuLayer?.isBlocked())return;
    const current=view.getBounds(),parent=host.getContentBounds();
    const snapped=snapFloatingBounds(current,{workArea:screen?.getDisplayMatching?.(current)?.workArea,ownerBounds:parent,threshold:20,gap:8});
    // Native screen coordinates are already DIPs. Do not scale the snap or
    // change the float's size; owner movement continues using this offset.
    if(snapped.x!==current.x||snapped.y!==current.y){
      lastApplied={...snapped};applyingBounds=true;
      try{view.setBounds(snapped);}finally{applyingBounds=false;}
    }
    rememberDesktopPosition();
    refreshMenuLayer();
  }
  function unavailable(child) {
    if (view !== child) return;
    detach(); view = null; ready = false;
    if (rect && host && !host.isDestroyed() && !host.webContents.isDestroyed()) host.webContents.send('workbench:native-composer-event', { type: 'unavailable' });
    if (!child.webContents.isDestroyed()) { if (desktop) child.destroy(); else child.webContents.close({ waitForBeforeUnload: false }); }
  }
  function refresh() {
    if (!host || host.isDestroyed() || !view || !ready || !enabled || !rect || nativeDismissed || host.isVisible?.() === false || host.isMinimized?.() === true) { detach(); return; }
    bounds();
    const displayAllowed=!desktop||refreshMenuLayer();
    if (!attached) { if (desktop) { deferredMenuShow=!displayAllowed;if(displayAllowed&&view.isVisible?.()!==true)view.showInactive(); } else host.contentView.addChildView(view); attached = true; }
    publish();
  }
  function make() {
    const webPreferences = { preload: path.join(baseDir, 'native-composer-preload.cjs'), partition: 'persist:neko-workspace-composer', sandbox: true, contextIsolation: true, nodeIntegration: false };
    const child = desktop ? new BrowserWindow({parent:host,title:'创造台',width:480,height:120,show:false,frame:false,transparent:true,hasShadow:false,resizable:false,maximizable:false,minimizable:false,fullscreenable:false,skipTaskbar:true,webPreferences}) : new WebContentsView({webPreferences});
    if (desktop) {
      child.setMenu?.(null);
      child.on('will-move',()=>{
        if(platform==='win32'&&!applyingBounds&&view===child&&!child.isDestroyed()&&host&&!host.isDestroyed()&&ready&&attached&&enabled&&!menuLayer?.isBlocked())nativeMoving=true;
      });
      child.on('move',()=>{
        if(applyingBounds||view!==child||child.isDestroyed()||!host||host.isDestroyed())return;
        const parent=host.getContentBounds(),b=child.getBounds();
        // A native child-move can precede its owner's move notification.
        // In that case preserve the offset and let bounds() reconcile once.
        if(lastHostOrigin&&(parent.x!==lastHostOrigin.x||parent.y!==lastHostOrigin.y)){bounds();return;}
        if(!lastApplied||b.x!==lastApplied.x||b.y!==lastApplied.y){moved=true;relativePosition={x:b.x-parent.x,y:b.y-parent.y};lastApplied={...b};bounds();rememberDesktopPosition();}
        refreshMenuLayer();
      });
      child.on('moved',()=>{
        // Only Windows has a distinct native drag-completion notification.
        // macOS aliases `moved` to `move`; rely on real pointerup IPC there.
        if(platform!=='win32'||!nativeMoving||applyingBounds||view!==child)return;
        nativeMoving=false;finishDesktopDrag();
      });
      child.on('resize',()=>{if(view===child&&!child.isDestroyed())refreshMenuLayer();});
      child.on('close',event=>{event.preventDefault();nativeDismissed=true;detach();});
    } else child.setBackgroundColor('#00000000');
    view = child; ready = false;
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
    const key=request.positionKey===undefined?'default':request.positionKey;
    if(!['default','lobby'].includes(key)||request.resetPosition!==undefined&&typeof request.resetPosition!=='boolean')throw Error('无效创造台位置模式');
    if(key!==positionKey){nativeMoving=false;positions.set(positionKey,{moved,relativePosition:relativePosition&&{...relativePosition}});positionKey=key;const saved=positions.get(key);moved=saved?.moved===true;relativePosition=saved?.relativePosition?{...saved.relativePosition}:null;lastApplied=null;}
    if(request.resetPosition===true){nativeMoving=false;moved=false;relativePosition=null;positions.set(positionKey,{moved:false,relativePosition:null});}
    nativeDismissed=false;rect = { ...r }; if (!view) make(); refresh(); return { ok: true };
  }
  function update(snapshot) {
    if (!snapshot || typeof snapshot.value !== 'string' || snapshot.value.length > 30000 || typeof snapshot.sessionToken !== 'string' || snapshot.sessionToken.length > 512 || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw Error('无效工作会话状态');
    if (snapshot.sessionToken !== state.sessionToken) { pendingSubmit = null; pendingEdit = null; pendingModel=null; pendingProject=null; pendingQuestion=null; }
    if(pendingQuestion&&snapshot.settledQuestionSelectionId===pendingQuestion.id&&snapshot.settledQuestionKey===pendingQuestion.key&&snapshot.settledQuestionRevision===pendingQuestion.revision)pendingQuestion=null;
    if (pendingSubmit !== null && snapshot.settledSubmitId === pendingSubmit) pendingSubmit = null;
    if (pendingEdit !== null && snapshot.settledEditId === pendingEdit) pendingEdit = null;
    if(pendingModel!==null&&snapshot.settledModelSelectionId===pendingModel)pendingModel=null;
    const records = Array.isArray(snapshot.records) ? snapshot.records.slice(0, 200).filter(item => item && typeof item.id === 'string' && item.id.length <= 512 && typeof item.title === 'string' && typeof item.project === 'string').map(item => ({id:item.id,title:item.title.slice(0,160),project:item.project.slice(0,120),enabled:item.enabled === true})) : [];
    const targetLabel = typeof snapshot.targetLabel === 'string' ? snapshot.targetLabel.trim().slice(0, 280) : '';
    state = { targetLabel, targetRequired:snapshot.targetRequired === true, submitUnknown:snapshot.submitUnknown === true, settledRecordOpenId:Number.isSafeInteger(snapshot.settledRecordOpenId) ? snapshot.settledRecordOpenId : null, records, recordsOpen:snapshot.recordsOpen === true, recordsHasMore:snapshot.recordsHasMore === true, recordsLoading:snapshot.recordsLoading === true, recordsStatus:typeof snapshot.recordsStatus === 'string' ? snapshot.recordsStatus.slice(0,160) : '', value: snapshot.value, settledEditId: Number.isSafeInteger(snapshot.settledEditId) ? snapshot.settledEditId : null, editConflict: snapshot.editConflict === true, status: typeof snapshot.status === 'string' ? snapshot.status.slice(0, 160) : '', settledSubmitId: Number.isSafeInteger(snapshot.settledSubmitId) ? snapshot.settledSubmitId : null, placeholder: typeof snapshot.placeholder === 'string' ? snapshot.placeholder.slice(0, 120) : '发消息或创建任务…', enabled: snapshot.enabled === true, busy: snapshot.busy === true, sessionToken: snapshot.sessionToken, revision: snapshot.revision };
    state.chatOnly = snapshot.chatOnly === true;
    state.question=questionForms.normalize(snapshot.question);if(state.question?.sessionId!==state.sessionToken)state.question=null;
    if(pendingQuestion&&(!state.question||pendingQuestion.key!==state.question.key||pendingQuestion.revision!==state.question.revision))pendingQuestion=null;
    const bounded=(value,length)=>typeof value==='string'?value.slice(0,length):'';
    state.modelOptions=(Array.isArray(snapshot.modelOptions)?snapshot.modelOptions:[]).slice(0,200).filter(row=>row&&typeof row.id==='string'&&row.id&&row.id.length<=1024&&typeof row.label==='string').map(row=>({id:row.id,label:bounded(row.label,180),reasoningOptions:(Array.isArray(row.reasoningOptions)?row.reasoningOptions:[]).slice(0,32).filter(e=>e&&typeof e.id==='string'&&e.id.length<=128&&typeof e.label==='string').map(e=>({id:e.id,label:bounded(e.label,80)}))}));
    for(const key of ['modelId','modelLabel','reasoningId','reasoningLabel','modelError'])state[key]=bounded(snapshot[key],key==='modelId'?1024:key==='modelError'?240:180);
    state.modelOpen=snapshot.modelOpen===true;state.modelBusy=snapshot.modelBusy===true;
    state.defaultErrorCode=bounded(snapshot.defaultErrorCode,80);
    state.settledModelSelectionId=Number.isSafeInteger(snapshot.settledModelSelectionId)&&snapshot.settledModelSelectionId>0?snapshot.settledModelSelectionId:null;
    // Project chooser/details are display data from the trusted catalog. The
    // child can only name an id from this list; the host re-verifies it.
    state.projects=(Array.isArray(snapshot.projects)?snapshot.projects:[]).slice(0,200).filter(row=>row&&typeof row.id==='string'&&row.id&&row.id.length<=2048&&typeof row.name==='string').map(row=>({id:row.id,name:bounded(row.name,120),path:bounded(row.path,1024),sessions:Number.isSafeInteger(row.sessions)&&row.sessions>=0?row.sessions:0,current:row.current===true,registered:row.registered!==false}));
    const project=snapshot.currentProject;
    state.currentProject=project&&typeof project==='object'&&typeof project.id==='string'&&project.id.length<=2048&&typeof project.name==='string'?{id:project.id,name:bounded(project.name,120),path:bounded(project.path,1024),registered:project.registered!==false,sessions:(Array.isArray(project.sessions)?project.sessions:[]).slice(0,100).filter(row=>row&&typeof row.id==='string'&&row.id.length<=512&&typeof row.title==='string').map(row=>({id:row.id,title:bounded(row.title,160),updatedAt:Number.isFinite(row.updatedAt)?row.updatedAt:0,active:row.active===true,current:row.current===true}))}:null;
    state.projectsStatus=bounded(snapshot.projectsStatus,160);state.projectOpen=snapshot.projectOpen===true;state.detailsOpen=snapshot.detailsOpen===true;
    // Read-only plain text of the current session for the details panel:
    // bounded count and length, roles limited to user/assistant.
    const work=snapshot.workContent;
    state.workContent=work&&typeof work==='object'&&typeof work.sessionId==='string'&&work.sessionId.length<=512?{sessionId:work.sessionId,status:['ready','empty','loading','unavailable'].includes(work.status)?work.status:'unavailable',source:['chat','outline'].includes(work.source)?work.source:'',truncated:work.truncated===true,items:(Array.isArray(work.items)?work.items:[]).slice(-60).filter(row=>row&&typeof row.id==='string'&&row.id.length<=200&&['user','assistant'].includes(row.role)&&typeof row.text==='string').map(row=>({id:row.id,role:row.role,text:row.text.length>2001?row.text.slice(0,2000)+'…':row.text}))}:null;
    state.settledProjectSelectId=Number.isSafeInteger(snapshot.settledProjectSelectId)&&snapshot.settledProjectSelectId>0?snapshot.settledProjectSelectId:null;
    if(pendingProject!==null&&state.settledProjectSelectId===pendingProject)pendingProject=null;
    publish(); return { ok: true };
  }
  function input(event, message) {
    if (!host || host.isDestroyed() || !view || !ready || !attached || !enabled || event.sender !== view.webContents || event.senderFrame !== view.webContents.mainFrame || !message || !['move', 'edit', 'submit', 'expand', 'files', 'records-toggle', 'records-resize', 'records-refresh', 'records-more', 'record-open','model-toggle','model-refresh','model-select','project-toggle','project-refresh','project-select','details-toggle','details-resize','question-action','question-visibility'].includes(message.type)) return;
    if(message.type==='question-visibility'){const q=state.question;if(typeof message.open==='boolean'&&(q?message.sessionId===q.sessionId&&message.key===q.key&&message.revision===q.revision:message.open===false))host.webContents.send('workbench:native-composer-event',{type:message.type,open:message.open,...(q?{sessionId:q.sessionId,key:q.key,revision:q.revision}:{})});return;}
    if(message.type==='question-action'){
      const q=state.question,type=message.questionAction;
      if(!q||q.sessionId!==message.sessionId||q.key!==message.key||q.revision!==message.revision||!['answer','focus','blur','engage','open'].includes(type))return;
      const answers=type==='answer'?questionForms.answersFor(q,message.answers):null;
      if(type==='answer'){
        if(pendingQuestion||!q.canAnswer||q.submitted||q.submitting||!answers||!Number.isSafeInteger(message.questionSelectionId)||message.questionSelectionId<=0)return;
        pendingQuestion={id:message.questionSelectionId,key:q.key,revision:q.revision};view.webContents.send('neko-composer-state',{...state,question:{...q,submitting:true}});
      }
      host.webContents.send('workbench:native-composer-event',{type:'question-action',questionAction:type,sessionId:q.sessionId,key:q.key,revision:q.revision,...(answers?{answers,questionSelectionId:message.questionSelectionId}:{})});return;
    }
    if (message.type === 'move') {
      if(Object.hasOwn(message,'finished')&&typeof message.finished!=='boolean')return;
      if (desktop) {
        if(menuLayer?.isBlocked())return;
        if (message.reset === true) { nativeMoving=false;moved=false;relativePosition=null;positions.set(positionKey,{moved:false,relativePosition:null});bounds(); }
        else if ([message.dx,message.dy].every(n=>Number.isFinite(n)&&Math.abs(n)<=4000)) {
          nativeMoving=false;
          if(message.dx||message.dy){const b=view.getBounds(),parent=host.getContentBounds();moved=true;relativePosition={x:b.x+message.dx-parent.x,y:b.y+message.dy-parent.y};bounds();rememberDesktopPosition();}
          if(message.finished===true)finishDesktopDrag();
        }
        return;
      }
      if (message.reset === true) host.webContents.send('workbench:native-composer-event',{type:'move',reset:true});
      else if ([message.dx,message.dy].every(n=>Number.isFinite(n)&&Math.abs(n)<=4000))host.webContents.send('workbench:native-composer-event',{type:'move',dx:message.dx,dy:message.dy,...(message.finished===undefined?{}:{finished:message.finished})});
      return;
    }
    if (state.chatOnly && ['expand','files'].includes(message.type)) return;
    if(message.type==='model-toggle'){if(typeof message.open==='boolean')host.webContents.send('workbench:native-composer-event',{type:'model-toggle',open:message.open});return;}
    if(message.type==='model-refresh'){const id=pendingModel??message.selectionId;host.webContents.send('workbench:native-composer-event',{type:'model-refresh',...(Number.isSafeInteger(id)&&id>0?{selectionId:id}:{})});return;}
    if(message.type==='model-select'){
      if(!Number.isSafeInteger(message.selectionId)||message.selectionId<=0)return;
      const row=state.modelOptions?.find(r=>r.id===message.modelId);
      if(!state.enabled||state.busy||state.modelBusy||pendingModel!==null||pendingEdit!==null||pendingSubmit!==null||message.sessionToken!==state.sessionToken||message.revision!==state.revision||typeof message.modelId!=='string'||!row||typeof message.reasoningId!=='string'||!row.reasoningOptions.some(e=>e.id===message.reasoningId)){
        view.webContents.send('neko-composer-state',{...state,settledModelSelectionId:message.selectionId,modelError:'会话、草稿或模型选项已变化，请刷新后重试'});return;
      }
      pendingModel=message.selectionId;
      host.webContents.send('workbench:native-composer-event',{type:'model-select',selectionId:message.selectionId,modelId:message.modelId,reasoningId:message.reasoningId,sessionToken:state.sessionToken,revision:state.revision});return;
    }
    if (message.type === 'files') {
      if (!state.enabled || !state.sessionToken || message.sessionToken !== state.sessionToken || message.revision !== state.revision || pendingEdit !== null || pendingSubmit !== null || pendingModel!==null) { view.webContents.send('neko-composer-state', { ...state, status:'当前会话或草稿已变化，请展开工作区重试' }); return; }
      host.webContents.send('workbench:native-composer-event', {type:'files',sessionToken:state.sessionToken,revision:state.revision}); return;
    }
    if (message.type === 'records-refresh' || message.type === 'records-more') { if (!state.recordsLoading && (message.type !== 'records-more' || state.recordsHasMore)) host.webContents.send('workbench:native-composer-event', {type:message.type}); return; }
    if (message.type === 'records-toggle') { if (typeof message.open === 'boolean') host.webContents.send('workbench:native-composer-event', {type:'records-toggle',open:message.open}); return; }
    if (message.type === 'records-resize') { if (Number.isFinite(message.delta) && Math.abs(message.delta) <= 4000 && (message.dx === undefined || Number.isFinite(message.dx) && Math.abs(message.dx) <= 4000)) host.webContents.send('workbench:native-composer-event', {type:'records-resize',delta:message.delta,dx:message.dx || 0}); return; }
    if (message.type === 'project-toggle' || message.type === 'details-toggle') { if (typeof message.open === 'boolean') host.webContents.send('workbench:native-composer-event', {type:message.type,open:message.open}); return; }
    if (message.type === 'project-refresh') { host.webContents.send('workbench:native-composer-event', {type:'project-refresh'}); return; }
    if (message.type === 'details-resize') { if (Number.isFinite(message.delta) && Math.abs(message.delta) <= 4000) host.webContents.send('workbench:native-composer-event', {type:'details-resize',delta:message.delta}); return; }
    if (message.type === 'project-select') {
      if (!Number.isSafeInteger(message.selectId) || message.selectId <= 0) return;
      // Switching projects never carries text: a draft, pending edit/send or
      // model change keeps the current session. The host re-checks revision.
      if (pendingProject !== null || pendingEdit !== null || pendingSubmit !== null || pendingModel !== null || state.modelBusy || state.busy || state.value.trim() || message.sessionToken !== state.sessionToken || message.revision !== state.revision || typeof message.projectId !== 'string' || !state.projects?.some(row => row.id === message.projectId)) { view.webContents.send('neko-composer-state', {...state,settledProjectSelectId:message.selectId,status:state.value.trim()?'请先发送或清空当前草稿，再切换项目':'当前会话或项目已变化，请检查后重试'}); return; }
      pendingProject = message.selectId;
      host.webContents.send('workbench:native-composer-event', {type:'project-select',projectId:message.projectId,sessionToken:state.sessionToken,revision:state.revision,selectId:message.selectId}); return;
    }
    if (message.type === 'record-open') {
      if (!Number.isSafeInteger(message.openId) || message.openId <= 0) return;
      const known = typeof message.id === 'string' && (state.records?.some(row => row.id === message.id && row.enabled) || state.currentProject?.sessions.some(row => row.id === message.id && !row.current));
      if (pendingEdit !== null || pendingSubmit !== null || pendingModel!==null || pendingProject!==null || state.modelBusy || message.sessionToken !== state.sessionToken || message.revision !== state.revision || !known) { view.webContents.send('neko-composer-state', {...state,settledRecordOpenId:message.openId,status:'当前会话已变化，请检查后重试'}); return; }
      host.webContents.send('workbench:native-composer-event', {type:'record-open',id:message.id,sessionToken:state.sessionToken,revision:state.revision,openId:message.openId}); return;
    }
    if (message.type !== 'expand') {
      if(message.type==='submit'&&state.question)return;
      const invalid = !state.enabled || !state.sessionToken || message.sessionToken !== state.sessionToken || message.revision !== state.revision || typeof message.value !== 'string' || message.value.length > 30000 || (message.type === 'edit' && (pendingEdit !== null || !Number.isSafeInteger(message.editId) || message.editId <= 0)) || (message.type === 'submit' && (state.targetRequired && !state.targetLabel || state.busy || state.modelBusy || !!state.modelError || pendingModel!==null || pendingSubmit !== null || !Number.isSafeInteger(message.submissionId) || message.submissionId <= 0 || !message.value.trim()));
      if (invalid) {
        // Never strand the user's draft when a session/revision changes before
        // a send reaches us. An in-flight send cannot be acknowledged here.
        if (message.type === 'edit' && pendingEdit === null && Number.isSafeInteger(message.editId) && message.editId > 0) view.webContents.send('neko-composer-state', { ...state, settledEditId: message.editId, editConflict: true, status: '原工作区草稿已变化，请展开工作区处理' });
        if (message.type === 'submit' && pendingSubmit === null && Number.isSafeInteger(message.submissionId) && message.submissionId > 0) view.webContents.send('neko-composer-state', { ...state, settledSubmitId: message.submissionId, status: '当前会话已变化，请检查后重试' });
        return;
      }
    }
    if (message.type === 'submit') pendingSubmit = message.submissionId;
    if (message.type === 'edit') pendingEdit = message.editId;
    if (!host.webContents.isDestroyed()) host.webContents.send('workbench:native-composer-event', message.type === 'expand' ? { type: 'expand' } : { type: message.type, value: message.value, sessionToken: state.sessionToken, revision: state.revision, ...(message.type === 'submit' ? {submissionId:message.submissionId} : {editId:message.editId}) });
  }
  ipcMain.on('neko-composer-input', input);
  return Object.freeze({ bind, place, update, setAccountMenuRect(value) { menuLayer?.setMenuRect(value); refresh(); return {ok:true}; }, setEnabled(value) { enabled = value === true; refresh(); }, raise() { if (attached&&!menuLayer?.isBlocked()) { if (desktop) view.moveTop?.(); else host.contentView.addChildView(view) } }, dispose() { close(); ipcMain.removeListener('neko-composer-input', input); } });
}
module.exports = { createNativeComposerController };
