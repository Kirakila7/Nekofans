'use strict';

// These are the installed DSH client services, not a second session/model store.
// initializeDefault resolves the registry's durable defaultWorkspaceId; it must
// never be approximated by the first/recent project in a catalog.
function createNativeComposerDshBindings(ctx) {
  const ui = () => ctx.uiWorkspace;
  const workspaces = () => ctx.get?.('workspaces') || ui()?.workspaces;
  const sessions = () => ctx.get?.('sessions') || ui()?.sessions;
  let defaultWorkspaceId = null, defaultSessionId = null, defaultSessionIds = [];
  function cleanWorkspaceTarget() {
    const navigation=ui(),selection=navigation?.selection?.getSnapshot?.(),id=selection?.sessionId,main=navigation?.mainReference?.sessionId;
    const failure=()=>Object.assign(Error('当前工作输入已变化，请保留草稿后重新选择项目'),{code:'workspace_input_changed'});
    if(selection?.subagentAddress)throw failure();
    if(!id&&!main)return {navigation,id:null,revision:null,shell:null};
    if(typeof id!=='string'||id!==main)throw failure();
    const shell=ctx.get?.('conversation')?.input?.shell?.(id),state=shell?.state?.getSnapshot?.();
    if(!state||state.phase!=='plain'||state.draft!==''||!Number.isSafeInteger(state.draftRev)||state.claim!=null||!Array.isArray(state.attachmentIds)||state.attachmentIds.length||!Array.isArray(state.occurrences)||state.occurrences.length)throw failure();
    return {navigation,id,revision:state.draftRev,shell};
  }
  async function openWorkspace(workspaceId) {
    if(typeof workspaceId!=='string'||!workspaceId||workspaceId.length>512||typeof ui()?.openWorkspace!=='function')throw Error('请选择可用工作区');
    const before=cleanWorkspaceTarget(),current=()=>{try{const next=cleanWorkspaceTarget();return next.navigation===before.navigation&&next.id===before.id&&next.revision===before.revision&&next.shell===before.shell;}catch{return false;}};
    const registry=workspaces();
    const visible=()=>registry?.list?.getSnapshot?.()?.phase==='ready'&&registry.list.getSnapshot().items?.some(row=>row.workspaceId===workspaceId);
    if(!visible())await new Promise((resolve,reject)=>{
      let timer,stop,finished=false;const finish=error=>{if(finished)return;finished=true;clearTimeout(timer);if(typeof stop==='function')stop();error?reject(error):resolve();};
      const check=()=>{if(!current())finish(Error('当前工作输入已变化，未切换项目'));else if(visible())finish();};
      if(typeof registry?.list?.subscribe!=='function')return finish(Error('工作区列表尚未就绪，请刷新后重试'));
      timer=setTimeout(()=>finish(Error('工作区尚未同步，请刷新后重试')),3000);stop=registry.list.subscribe(check);if(finished&&typeof stop==='function')stop();check();
    });
    if(!current())throw Error('当前工作输入已变化，未切换项目');
    await before.navigation.openWorkspace(workspaceId,()=>{if(!current())throw Error('当前工作输入已变化，未切换项目');});
    return {workspaceId};
  }
  return {
    getSelection: () => ui()?.selection?.getSnapshot?.(),
    getMainSessionId: () => ui()?.mainReference?.sessionId,
    getBinding: id => ui()?.sessions?.binding?.(id),
    getShell: (_binding, id) => ctx.get?.('conversation')?.input?.shell?.(id),
    subscribeSelection: callback => ui()?.selection?.subscribe?.(callback),
    getWorkspacesSnapshot: () => workspaces()?.list?.getSnapshot?.(),
    subscribeWorkspaces: callback => workspaces()?.list?.subscribe?.(callback),
    openWorkspace,
    // Read-only official chat projection of one session (loaded window + live).
    getWorkContentTarget: id => ctx.get?.('uiConversation')?.binding?.(id)?.target?.('chat'),
    getQuestionStatusSource: () => ctx.get?.('uiSession')?.sessionStatus,
    getModelDirectory: id => ctx.get?.('modelDirectories')?.directoryFor?.(id),
    hasExplicitModelSelection: binding => binding.session?.projections?.faceOf?.('modelSelection')?.getSnapshot?.()?.next !== undefined,
    isDefaultSession: id => !!defaultWorkspaceId && (id===defaultSessionId || defaultSessionIds.includes(id) || workspaces()?.list?.getSnapshot?.()?.items?.some(row => row.workspaceId === defaultWorkspaceId && row.sessionIds?.includes(id))),
    defaultReady: () => workspaces()?.list?.getSnapshot?.()?.phase === 'ready' && sessions()?.list?.getSnapshot?.()?.phase === 'ready',
    subscribeReady(callback) {
      const off = [workspaces()?.list?.subscribe?.(callback), sessions()?.list?.subscribe?.(callback)];
      return () => { for (const stop of off) if (typeof stop === 'function') stop(); };
    },
    async ensureDefaultSession({ signal, stillUnbound, workspaceRoot }) {
      const registry = workspaces(), navigation = ui();
      const failure=(code,message)=>Object.assign(Error(message),{code});
      if (typeof registry?.initializeDefault !== 'function' || typeof navigation?.openWorkspace !== 'function') throw failure('default_service_unavailable','当前 DSH 版本暂不支持默认工作区');
      let workspace = await registry.initializeDefault(signal);
      // Workbench starts its own engine root before the UI connects. DSH's
      // first-use initializer then deliberately returns undefined. The trusted
      // host already publishes the actual configured default directory; resolve
      // that exact path through the public registry instead of choosing a project.
      if(!workspace){
        if(signal.aborted)return {skipped:true};
        if(typeof workspaceRoot!=='string'||workspaceRoot.length>4096||!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(workspaceRoot))throw failure('default_root_unavailable','默认工作区路径尚未就绪，请重试');
        if(typeof registry.create!=='function')throw failure('default_service_unavailable','当前 DSH 版本暂不支持默认工作区');
        // Registry create resolves an existing canonical path idempotently.
        // A first-start registration can fail transiently; retry only this
        // same trusted directory, never a task or a catalog-selected project.
        for(let attempt=0;attempt<3;attempt++){
          try{workspace=await registry.create({path:workspaceRoot});break;}
          catch{
            if(signal.aborted||!stillUnbound())return {skipped:true,sessionId:navigation.mainReference?.sessionId};
            if(attempt===2)throw failure('default_registration_failed','默认工作区登记失败，请在办公版检查工作区');
            await new Promise(resolve=>{let timer;const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};timer=setTimeout(finish,[200,500][attempt]);signal.addEventListener('abort',finish,{once:true});if(signal.aborted)finish();});
            if(signal.aborted||!stillUnbound())return {skipped:true,sessionId:navigation.mainReference?.sessionId};
          }
        }
      }
      if (!workspace || typeof workspace.workspaceId !== 'string' || !workspace.workspaceId) throw failure('default_workspace_invalid','默认工作区信息尚未就绪，请重试');
      defaultWorkspaceId = workspace.workspaceId;
      defaultSessionIds=Array.isArray(workspace.sessionIds)?workspace.sessionIds:[];
      if (signal.aborted || !stillUnbound()) return { skipped: true, sessionId:navigation.mainReference?.sessionId };
      try{await navigation.openWorkspace(workspace.workspaceId, id => {
        if (signal.aborted || !stillUnbound()) throw failure('default_navigation_changed','当前工作输入已变化，未切换默认工作区');
        defaultSessionId=id;
      });}catch(error){throw error?.code?error:failure('default_open_failed','默认工作区会话未能打开，请重试');}
      return { sessionId: navigation.mainReference?.sessionId, workspaceId: workspace.workspaceId };
    },
  };
}

// A narrow adapter to the *current* retained DSH session input shell. It never
// routes text through companion chat and never owns a second draft. All calls
// must be bound to the session and content revision the caller actually saw.
function createNativeComposerAdapter(options = {}) {
  let disposed = false, bound = null, unbindShell = null, unbindNotice = null, unbindSession = null, unbindSelection = null, unbindModel = null, unbindReady = null, unbindWorkspaces = null;
  const pendingSubmissions = new WeakMap();
  const initializedModels = new WeakSet(), defaultModelTargets = new WeakSet(), lifetime = new AbortController();
  let defaultOpening = null, defaultAttempted = false, defaultError = '', defaultErrorCode = '', modelOperation = null, modelError = '';
  let scheduled = false;
  const selection = () => options.getSelection?.();
  const selectedId = value => value && !value.subagentAddress && typeof value.sessionId === 'string' && value.sessionId ? value.sessionId : null;
  const unavailable = reason => ({ available: false, reason, sessionId: null, revision: null, draft: '', phase: null });
  function detach() {
    if (typeof unbindShell === 'function') { try { unbindShell(); } catch {} }
    if (typeof unbindNotice === 'function') { try { unbindNotice(); } catch {} }
    if (typeof unbindSession === 'function') { try { unbindSession(); } catch {} }
    if (typeof unbindModel === 'function') { try { unbindModel(); } catch {} }
    unbindShell = unbindNotice = unbindSession = unbindModel = null; bound = null;
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
      let directory;try{directory=options.getModelDirectory?.(id);}catch{}
      return { id, binding, shell, directory };
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
    if (!bound || bound.id !== next.id || bound.binding !== next.binding || bound.shell !== next.shell || bound.directory !== next.directory) {
      if(bound?.binding!==next.binding)modelError='';
      detach(); bound = next;
      try {
        unbindShell = next.shell.state.subscribe(notify);
        if (typeof next.shell.notices?.subscribe === 'function') unbindNotice = next.shell.notices.subscribe(notify);
        if (typeof next.binding.session?.subscribe === 'function') unbindSession = next.binding.session.subscribe(notify);
        if (typeof next.directory?.store?.subscribe === 'function') unbindModel = next.directory.store.subscribe(notify);
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
      const reason = session?.removed === true ? '会话已不可用，请展开工作区选择会话' : rich ? '当前草稿包含引用、附件或指令，请展开工作区继续编辑' : raw.draft.length > 30000 ? '草稿较长，请展开工作区继续编辑' : raw.phase !== 'plain' ? '原生输入正在处理，请稍候' : '';
      const status = session?.promptError || session?.lastAgentError || notice?.level === 'error' ? '工作会话出现错误，请展开工作区查看详情' : Array.isArray(session?.pendingSubmissions) && session.pendingSubmissions.length ? '正在交给工作区处理' : '';
      return { available: !reason, reason, status, sessionId: active.id, revision: raw.draftRev, draft: raw.draft, phase: raw.phase };
    } catch { return unavailable('输入状态暂不可用'); }
  }
  function snapshot() {
    const active = refreshBinding();
    syncWork(active);
    const state = active ? readSnapshot(active) : unavailable(disposed ? '输入已关闭' : defaultError || (typeof options.ensureDefaultSession==='function' ? '' : '请先选择一个会话'));
    const work = workWatch ? { workContent:readWork(active) } : {};
    return { ...state, defaultWorkspace:!!active && options.isDefaultSession?.(active.id)===true, defaultErrorCode, ...readModels(active), ...work };
  }
  // ---- read-only work content of the current session -------------------
  // Only while details are shown. One subscription, bound to one session id;
  // switching or closing releases it and a token drops late callbacks.
  let workWatch = false, workSession = null, workFace = null, workKind = '', unbindWork = null, workToken = 0;
  const WORK_ITEMS = 60, WORK_TEXT = 2000;
  function stopWork() {
    workToken++;
    if (typeof unbindWork === 'function') { try { unbindWork(); } catch {} }
    unbindWork = null; workFace = null; workKind = ''; workSession = null;
  }
  function syncWork(active) {
    const id = workWatch && !disposed ? active?.id || null : null;
    if (!id) { if (workSession !== null || unbindWork) stopWork(); return; }
    if (workSession === id) return;
    stopWork(); workSession = id; const token = workToken;
    const changed = () => { if (token === workToken) notify(); };
    let face; try { face = options.getWorkContentTarget?.(id); } catch {}
    if (face && typeof face.subscribe === 'function' && typeof face.getSnapshot === 'function') {
      // The official target is activated by subscribing, then read.
      workFace = face; workKind = 'chat';
      try { const stop = face.subscribe(changed); if (token === workToken) unbindWork = stop; else if (typeof stop === 'function') stop(); } catch { workFace = null; workKind = ''; }
      return;
    }
    let outline; try { outline = active.binding.session?.projections?.faceOf?.('turnOutline'); } catch {}
    if (outline && typeof outline.subscribe === 'function' && typeof outline.getSnapshot === 'function') {
      workFace = outline; workKind = 'outline';
      try { const stop = outline.subscribe(changed); if (token === workToken) unbindWork = stop; else if (typeof stop === 'function') stop(); } catch { workFace = null; workKind = ''; }
    }
  }
  const clip = text => text.length > WORK_TEXT ? text.slice(0, WORK_TEXT) + '…' : text;
  function chatItems(raw) {
    const order = Array.isArray(raw?.order) ? raw.order : [], nodes = raw?.nodes;
    const node = key => typeof nodes?.get === 'function' ? nodes.get(key) : nodes && typeof nodes === 'object' ? nodes[key] : undefined;
    const items = [];
    for (const key of order.slice(-400)) {
      if (typeof key !== 'string') continue;
      const value = node(key); let role = '', text = '';
      // Plain text only: no reasoning, tool arguments or other block kinds.
      if (value?.kind === 'user') { role = 'user'; text = (Array.isArray(value.data?.content) ? value.data.content : []).filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n'); }
      else if (value?.kind === 'assistant-step') { role = 'assistant'; text = (Array.isArray(value.data?.blocks) ? value.data.blocks : []).filter(block => block?.kind === 'text' && typeof block.text === 'string').map(block => block.text).join('\n'); }
      if (role && text.trim()) items.push({ id:key.slice(0, 200), role, text:clip(text) });
    }
    return items;
  }
  function outlineItems(raw) {
    const items = [];
    for (const turn of Array.isArray(raw) ? raw.slice(-WORK_ITEMS) : []) {
      const key = String(turn?.seq ?? turn?.turn ?? items.length).slice(0, 80);
      if (typeof turn?.prompt === 'string' && turn.prompt.trim()) items.push({ id:'o:' + key + ':p', role:'user', text:clip(turn.prompt) });
      if (typeof turn?.response === 'string' && turn.response.trim()) items.push({ id:'o:' + key + ':r', role:'assistant', text:clip(turn.response) });
    }
    return items;
  }
  function readWork(active) {
    const sessionId = active?.id || '';
    if (!active || workSession !== active.id || !workFace) return { sessionId, status:'unavailable', source:'', items:[], truncated:false };
    let raw; try { raw = workFace.getSnapshot(); } catch { return { sessionId, status:'unavailable', source:workKind, items:[], truncated:false }; }
    if (raw == null) return { sessionId, status:'loading', source:workKind, items:[], truncated:false };
    const all = workKind === 'chat' ? chatItems(raw) : outlineItems(raw);
    return { sessionId, status:all.length ? 'ready' : 'empty', source:workKind, items:all.slice(-WORK_ITEMS), truncated:all.length > WORK_ITEMS };
  }
  function watchWorkContent(open) {
    const next = open === true && !disposed;
    if (next === workWatch) return;
    workWatch = next; if (!next) stopWork();
    notify();
  }
  function modelRows(active) {
    const raw = active?.directory?.store?.getSnapshot?.();
    const rows = [];
    for (const group of Array.isArray(raw?.groups) ? raw.groups : []) {
      if (typeof group?.id !== 'string' || !group.id || group.id.length > 256) continue;
      for (const model of Array.isArray(group.models) ? group.models : []) {
        if (typeof model?.id !== 'string' || !model.id || model.id.length > 256 || typeof model.name !== 'string') continue;
        const reasoningOptions = (Array.isArray(model.reasoning?.efforts) ? model.reasoning.efforts : []).filter(e => typeof e?.id === 'string' && e.id && e.id.length <= 128 && typeof e.name === 'string').map(e => ({ id:e.id, label:e.name.slice(0,80) }));
        if (model.reasoning?.defaultEffort === undefined) reasoningOptions.unshift({id:'',label:'默认'});
        rows.push({ id:JSON.stringify([group.id,model.id]), label:model.name.slice(0,180), reasoningOptions, provider:group.id, model:model.id, defaultReasoning:model.reasoning?.defaultEffort, name:model.name });
      }
    }
    return { raw, rows };
  }
  function readModels(active) {
    let raw, rows=[];
    try { ({raw,rows}=modelRows(active)); } catch {}
    const current = raw?.current, row = rows.find(r => r.provider === current?.provider && r.model === current?.model);
    const reasoningId = current?.reasoningEffort ?? row?.defaultReasoning ?? '';
    const error = modelError || (!active ? defaultError : '') || (raw?.status === 'error' ? '模型目录读取失败，请重试' : !rows.length && raw?.status==='ready' ? '暂无可用模型，请先登录 DeepSeek 或配置模型后刷新' : current && !row && raw?.status === 'ready' ? '当前模型暂不可用，请选择目录中的模型' : '');
    return {modelOptions:rows.map(({id,label,reasoningOptions})=>({id,label,reasoningOptions})),modelId:row?.id||'',modelLabel:row?.label||'',reasoningId,reasoningLabel:row?.reasoningOptions.find(e=>e.id===reasoningId)?.label||'',modelBusy:!!modelOperation || !!defaultOpening || ['loading','selecting'].includes(raw?.status),modelError:error};
  }
  async function loadModels({ refresh = false, initializeDefault = true } = {}) {
    const active = refreshBinding();
    if (!active?.directory || typeof active.directory.load !== 'function') { modelError='此版本暂不支持创造台模型选择'; notify(); return {ok:false,code:'unavailable',state:snapshot()}; }
    try {
      if (refresh && typeof active.directory.catalog?.invalidate === 'function') active.directory.catalog.invalidate();
      await active.directory.load();
      if (disposed || refreshBinding()?.binding !== active.binding) return {ok:false,code:'session_changed',state:snapshot()};
      if(initializeDefault&&defaultModelTargets.has(active.binding)&&!initializedModels.has(active.binding)&&options.hasExplicitModelSelection?.(active.binding)===false)await initializeDefaultModel({loaded:true});
      else if(initializeDefault)modelError='';
      notify(); return {ok:true,state:snapshot()};
    } catch { modelError='模型目录读取失败，请检查 DSH 登录状态后重试'; notify(); return {ok:false,code:'catalog_failed',state:snapshot()}; }
  }
  async function selectModel(request) {
    const check = verify(request);
    if (!check.ok) return check;
    if (modelOperation) return {ok:false,code:'model_busy',state:snapshot()};
    const {active} = check;
    if (typeof active.directory?.select !== 'function') return {ok:false,code:'unavailable',state:snapshot()};
    const {raw,rows}=modelRows(active), row=rows.find(r=>r.id===request.modelId);
    if (raw?.status !== 'ready' || !row || typeof request.reasoningId !== 'string' || !row.reasoningOptions.some(e=>e.id===request.reasoningId)) { modelError='模型或推理选项已变化，请刷新后重试';notify();return {ok:false,code:'invalid_model',state:snapshot()}; }
    modelError='';
    const operation={};modelOperation=operation;notify();
    try {
      const result=await active.directory.select({provider:row.provider,model:row.model,...(request.reasoningId?{reasoningEffort:request.reasoningId}:{})});
      if (result?.ok !== true) { modelError='模型切换失败，请检查 DSH 账号和模型可用性'; return {ok:false,code:'model_failed',state:snapshot()}; }
      initializedModels.add(active.binding);
      return {ok:true,code:'model_selected',state:snapshot()};
    } catch { modelError='模型切换失败，请刷新后重试';return {ok:false,code:'model_failed',state:snapshot()}; }
    finally { if(modelOperation===operation)modelOperation=null;notify(); }
  }
  async function initializeDefaultModel({loaded=false}={}) {
    const active=refreshBinding();
    if (!active || initializedModels.has(active.binding) || active.binding.session?.getSnapshot?.()?.blank !== true || options.isDefaultSession?.(active.id)!==true || options.hasExplicitModelSelection?.(active.binding)!==false) return;
    defaultModelTargets.add(active.binding);
    if(!loaded){const result=await loadModels({initializeDefault:false});if(!result.ok)return;}
    if(disposed||refreshBinding()?.binding!==active.binding||options.hasExplicitModelSelection?.(active.binding)!==false)return;
    const {rows}=modelRows(active);
    const row=['deepseek-account','deepseek-official'].map(provider=>rows.find(r=>r.provider===provider&&r.model==='deepseek-flash'&&r.name==='DeepSeek-V4.1-Flash')).find(Boolean);
    const high=row?.reasoningOptions.find(e=>e.id.toLowerCase()==='high'||e.label.toLowerCase()==='high');
    if(!row||!high){modelError='当前模型目录未提供 DeepSeek-V4.1-Flash / High，请登录 DSH 后刷新选择';notify();return;}
    const state=snapshot();if(!state.available)return;
    await selectModel({sessionId:state.sessionId,revision:state.revision,modelId:row.id,reasoningId:high.id});
  }
  async function ensureDefaultSession({retry=false}={}) {
    if(disposed||typeof options.ensureDefaultSession!=='function')return {ok:false,code:'unavailable',state:snapshot()};
    if(defaultOpening)return defaultOpening;
    const existing=refreshBinding();
    if(selection()?.subagentAddress || (selectedId(selection())||options.getMainSessionId?.()) && (!existing || existing.binding.session?.getSnapshot?.()?.blank!==true || options.hasExplicitModelSelection?.(existing.binding)!==false))return {ok:true,code:'retained',state:snapshot()};
    if(options.defaultReady?.()===false)return {ok:false,code:'not_ready',state:snapshot()};
    const workspaceRoot=options.getDefaultWorkspaceRoot?.();
    if(typeof options.getDefaultWorkspaceRoot==='function'&&!workspaceRoot)return {ok:false,code:'not_ready',state:snapshot()};
    if(defaultAttempted&&!retry)return {ok:false,code:'already_attempted',state:snapshot()};
    defaultAttempted=true;defaultError='';defaultErrorCode='';
    const stillUnbound=()=>!disposed&&!selectedId(selection())&&!selection()?.subagentAddress&&!options.getMainSessionId?.();
    const operation=Promise.resolve().then(()=>options.ensureDefaultSession({signal:lifetime.signal,stillUnbound,workspaceRoot})).then(async result=>{
      if(disposed)return {ok:false,code:'session_changed',state:snapshot()};
      if(result?.skipped){await initializeDefaultModel();return {ok:true,code:'retained',state:snapshot()};}
      if(!refreshBinding())throw Object.assign(Error('默认工作区输入尚未就绪，请重试'),{code:'default_input_not_ready'});
      await initializeDefaultModel();return {ok:true,state:snapshot()};
    }).catch(error=>{const known=['default_service_unavailable','default_root_unavailable','default_registration_failed','default_workspace_invalid','default_navigation_changed','default_open_failed','default_input_not_ready'];defaultErrorCode=known.includes(error?.code)?error.code:'default_failed';defaultError=known.includes(error?.code)?error.message:'默认工作区暂不可用，请在办公版检查工作区后重试';return {ok:false,code:defaultErrorCode,state:snapshot()};}).finally(()=>{if(defaultOpening===operation)defaultOpening=null;notify();});
    defaultOpening=operation;notify();return operation;
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
    if (check.state.modelBusy || check.state.modelError) return {ok:false,code:'model_unconfirmed',state:check.state};
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
  function workspaces() { try { return options.getWorkspacesSnapshot?.() ?? null; } catch { return null; } }
  // Switch the creation desk to another verified workspace. Only a clean,
  // unchanged session (or no session at all) may move; the bindings re-check
  // draft, attachments, claim and revision against the official registry.
  async function openWorkspace(request) {
    if (disposed || typeof options.openWorkspace !== 'function') throw Error('当前 DSH 版本暂不支持切换项目');
    if (typeof request?.workspaceId !== 'string' || !request.workspaceId || request.workspaceId.length > 512) throw Error('请选择可用工作区');
    const state = snapshot();
    const unbound = !state.sessionId && !selection()?.sessionId && !selection()?.subagentAddress && request.sessionToken === '' && request.revision === 0;
    if (!unbound) {
      if (typeof request.sessionToken !== 'string' || request.sessionToken !== state.sessionId || request.revision !== state.revision) throw Error('当前会话或草稿已变化，未切换项目');
      if (!state.available) throw Error(state.reason || '当前会话暂不可切换项目');
      if (state.draft.trim() || state.phase !== 'plain') throw Error('请先发送或清空当前草稿，再切换项目');
      if (modelOperation || defaultOpening) throw Error('模型或默认工作区正在准备，请稍后再切换项目');
    }
    await options.openWorkspace(request.workspaceId);
    notify();
    return { ok:true, workspaceId:request.workspaceId };
  }
  if (typeof options.subscribeSelection === 'function') {
    try { unbindSelection = options.subscribeSelection(selectionChanged); } catch { /* Feature detection remains fail-closed. */ }
  }
  if (typeof options.subscribeWorkspaces === 'function') {
    try { unbindWorkspaces = options.subscribeWorkspaces(notify); } catch { /* Project labels fall back to the catalog. */ }
  }
  if(typeof options.subscribeReady==='function'){try{unbindReady=options.subscribeReady(()=>{notify();options.onReady?.();});}catch{}}
  return { snapshot, write, submit, loadModels, selectModel, ensureDefaultSession, workspaces, openWorkspace, watchWorkContent, dispose() { if (disposed) return; disposed = true; lifetime.abort(); stopWork(); workWatch = false; detach(); for(const stop of [unbindSelection,unbindReady,unbindWorkspaces])if(typeof stop==='function'){try{stop();}catch{}} unbindSelection=unbindReady=unbindWorkspaces=null; } };
}

if (typeof window === 'undefined' && typeof module !== 'undefined' && module.exports) module.exports = { createNativeComposerAdapter, createNativeComposerDshBindings };
