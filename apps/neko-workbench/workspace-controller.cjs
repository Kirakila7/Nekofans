'use strict';
const { projectGroups } = require('./workspace-layout.cjs');
const { CODEX_AVAILABLE, CODEX_TESTING_MESSAGE } = require('./codex-availability.cjs');
const {createHash}=require('node:crypto');
const {validRoot,rootKey}=require('./dsh-project-discovery.cjs');
function createWorkspaceController({ layout, codex, readDsh, now = Date.now, codexAvailable = CODEX_AVAILABLE } = {}) {
  let cached = null, checkedAt = 0, tail=Promise.resolve(),revision=0,contentKey='';
  const inFlight=new Map();
  async function catalog({ force = false, dshOffset = 0 } = {}) {
    if (!Number.isSafeInteger(dshOffset) || dshOffset < 0 || dshOffset > 100000) throw Error('会话分页无效');
    if (!force && !dshOffset && cached && now() - checkedAt < 20000) return structuredClone(cached);
    if(inFlight.has(dshOffset))return structuredClone(await inFlight.get(dshOffset));
    const operation=tail.then(async()=>{
      const results = await Promise.allSettled([readDsh({ offset: dshOffset, limit: 80,force:force===true }), codexAvailable ? codex.list() : Promise.resolve({ sessions: [], status: 'testing', more: false })]);
      const native = results[0].status === 'fulfilled' ? results[0].value : { sessions: [], status: 'unavailable', nextOffset: null };
      const cx = results[1].status === 'fulfilled' ? results[1].value : { sessions: [], status: 'unavailable', more: false };
      const dshReady=native?.status==='ready'&&Array.isArray(native.sessions),codexReady=Array.isArray(cx?.sessions)&&['ready','testing'].includes(cx.status);
      const previousDsh=cached?.sessions.filter(s=>s.provider==='dsh')||[],previousCodex=cached?.sessions.filter(s=>s.provider==='codex')||[];
      const dshRows=dshReady?[...(dshOffset?previousDsh:[]),...native.sessions]:previousDsh,codexRows=codexReady?cx.sessions:previousCodex;
      const sessions=[...new Map([...dshRows,...codexRows].map(row=>[row.provider+':'+row.id,row])).values()];
      const sources={workbench:native?.workspaceSources?.workbench||'unsupported','installed-dsh':native?.workspaceSources?.['installed-dsh']||'not-configured'};
      const workspaces=Array.isArray(native?.workspaces)?native.workspaces.filter(row=>sources[row.source]==='ready'):[];
      for(const row of cached?.workspaces||[])if(sources[row.source]==='unavailable'&&!workspaces.some(next=>next.id===row.id))workspaces.push(row);
      if(!dshReady&&results[0].status==='rejected'){for(const key of Object.keys(sources))sources[key]='unavailable';for(const row of cached?.workspaces||[])if(!workspaces.some(next=>next.id===row.id))workspaces.push(row);}
      const next={sessions,workspaces,projects:projectGroups(sessions,workspaces),providers:{dsh:dshReady?'ready':'unavailable',codex:codexReady?cx.status:'unavailable'},workspaceSources:sources,staleProviders:[...(!dshReady&&previousDsh.length?['dsh']:[]),...(!codexReady&&previousCodex.length?['codex']:[])],nextDshOffset:dshReady?native.nextOffset??null:cached?.nextDshOffset??null,codexMore:codexReady?!!cx.more:cached?.codexMore||false};
      const key=createHash('sha256').update(JSON.stringify(next)).digest('hex');
      checkedAt=now();if(key!==contentKey){contentKey=key;cached={...next,revision:++revision,fetchedAt:checkedAt};}
      return cached;
    });
    tail=operation.catch(()=>{});inFlight.set(dshOffset,operation);
    try{return structuredClone(await operation);}finally{if(inFlight.get(dshOffset)===operation)inFlight.delete(dshOffset);}
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
    async resolveProject(projectId){
      if(typeof projectId!=='string'||!projectId||projectId.length>2048)throw Error('请选择有效工作项目');
      if(!cached)await catalog();
      const project=cached.projects.find(project=>project.provider==='dsh'&&project.id===projectId&&project.cwd);if(!project)throw Error('请从当前项目列表选择工作区');
      const result=await readDsh({action:'resolve-project',projectId});
      if(!result||result.projectId!==projectId||typeof result.workspaceId!=='string'||!result.workspaceId||result.workspaceId.length>512||!validRoot(result.path)||rootKey(result.path)!==rootKey(project.cwd))throw Error('DSH 未能确认所选项目');
      checkedAt=-Infinity;return {projectId,workspaceId:result.workspaceId,path:result.path,name:typeof result.name==='string'?result.name.slice(0,160):''};
    },
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
  const messages = (main?.messages || []).filter(m => ['user', 'assistant', 'error'].includes(m.role)).slice(-40).map((m, i) => ({ id: String(m.id || m.requestId || m.time || i), role: m.role, text: String(m.text || '').slice(0, 8000),...(m.attachments?.length?{attachments:m.attachments.map(({id,name,mime,kind})=>({id,name,mime,kind}))}:{}) }));
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
