'use strict';
const fs=require('node:fs/promises');
const {workspaceProjectId,historyProjectId,validRoot,rootKey,projectName,timestamp}=require('./dsh-project-discovery.cjs');

function currentWorkspaces(ctx){
 try{
  const registry=ctx.workspaceRegistry||ctx.get?.('workspaceRegistry');
  if(typeof registry?.list!=='function')return {status:'unsupported',workspaces:[],registry};
  const rows=registry.list();if(!Array.isArray(rows))throw Error();
  const workspaces=rows.slice(0,5000).map(row=>{
   const id=row?.id??row?.workspaceId;
   if(typeof id!=='string'||!id||id.length>512||!validRoot(row.path)||!Array.isArray(row.sessionIds))throw Error();
   return {id:workspaceProjectId(id),provider:'dsh',workspaceId:id,cwd:row.path,name:projectName(row.title,row.path),source:'workbench',needsRegistration:false,sessionIds:row.sessionIds.filter(id=>typeof id==='string'&&id.length<=512).slice(0,100000),updatedAt:timestamp(row.updatedAt)};
  });
  return {status:'ready',workspaces,registry};
 }catch{return {status:'unavailable',workspaces:[]};}
}
async function workspaceSources(ctx,{readInstalledProjects}={},force=false){
 const current=currentWorkspaces(ctx);let installed={status:'not-configured',workspaces:[]};
 if(typeof readInstalledProjects==='function'){try{installed=await readInstalledProjects({force});}catch{installed={status:'unavailable',workspaces:[]};}}
 const paths=new Set(current.workspaces.map(row=>rootKey(row.cwd)));
 return {current,workspaces:[...current.workspaces,...(Array.isArray(installed?.workspaces)?installed.workspaces:[]).filter(row=>validRoot(row?.cwd)&&!paths.has(rootKey(row.cwd)))],workspaceSources:{workbench:current.status,'installed-dsh':installed?.status||'unavailable'}};
}
async function resolveDshWorkspaceProject(ctx,{projectId},{readInstalledProjects}={}){
 if(typeof projectId!=='string'||!projectId||projectId.length>2048)throw Error('请选择有效工作项目');
 const current=currentWorkspaces(ctx),registry=current.registry;
 if(current.status!=='ready'||typeof registry?.create!=='function')throw Error('DSH 工作区服务尚未就绪');
 let row=current.workspaces.find(row=>row.id===projectId);
 if(!row&&projectId.startsWith('installed-dsh:')&&typeof readInstalledProjects==='function'){
  let result;try{result=await readInstalledProjects({force:true});}catch{}
  if(result?.status!=='ready')throw Error('本机 DSH 项目暂不可读取，请刷新重试');
  row=result.workspaces?.find(row=>row.id===projectId);
 }
 if(!row&&projectId.startsWith('dsh-history:')){
  const records=await ctx.sessionQuery.listSessions();
  const header=records.find(record=>!record?.header?.parentSession&&validRoot(record?.header?.cwd)&&historyProjectId(record.header.cwd)===projectId)?.header;
  if(header)row={id:projectId,cwd:header.cwd,name:projectName('',header.cwd)};
 }
 if(!row||!validRoot(row.cwd))throw Error('工作项目已变化，请刷新后重新选择');
 let actual;
 try{actual=await fs.realpath(row.cwd);if(rootKey(actual)!==rootKey(row.cwd)||!(await fs.stat(actual)).isDirectory())throw Error();}catch{throw Error('项目目录不存在或已变化，原会话已保留');}
 const existing=current.workspaces.find(value=>rootKey(value.cwd)===rootKey(actual));
 let workspace;
 try{workspace=existing?{id:existing.workspaceId,path:existing.cwd,title:existing.name}:await registry.create(actual,row.name);}catch{throw Error('DSH 未能登记所选项目，原会话已保留');}
 const id=workspace?.id??workspace?.workspaceId;
 if(typeof id!=='string'||!id||!validRoot(workspace.path)||rootKey(workspace.path)!==rootKey(actual))throw Error('DSH 未能确认所选项目，原会话已保留');
 return {projectId,workspaceId:id,path:workspace.path,name:projectName(workspace.title,workspace.path)};
}
// Read the native logical corpus. Never parse another profile's files or
// create/resume an agent merely to populate a sidebar.
async function readDshWorkspaceCatalog(ctx, { offset = 0, limit = 80, action, projectId,force=false } = {}, dependencies = {}) {
  if(action==='resolve-project')return resolveDshWorkspaceProject(ctx,{projectId},dependencies);
  if(action!==undefined)throw Error('工作区操作无效');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error('会话分页无效');
  const source=await workspaceSources(ctx,dependencies,force===true);
  let records;
  try{records=(await ctx.sessionQuery.listSessions()).filter(row=>row?.header?.id&&!row.header.parentSession);}catch{return {workspaces:source.workspaces,workspaceSources:source.workspaceSources,sessions:[],nextOffset:null,status:'unavailable'};}
  const page = records.slice(offset, offset + limit), sessions = new Array(page.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, page.length) }, async () => {
    while (cursor < page.length) {
      const index = cursor++, header = page[index].header;
      let title = '', updatedAt = Number(header.createdAt) || 0, observation;
      try {
        observation = await ctx.sessionQuery.observeSession(String(header.id));
        title = String(observation.projections?.values?.title || '');
        const last = observation.events?.at(-1);
        updatedAt = Number(last?.timestamp || last?.createdAt) || updatedAt;
      } catch { /* Keep an unavailable record visible rather than inventing text. */ }
      finally { observation?.[Symbol.dispose]?.(); }
      sessions[index] = { id: String(header.id), provider: 'dsh', title: title.slice(0, 160) || 'DSH 会话 ' + String(header.id).slice(0, 8),
        cwd: typeof header.cwd === 'string' ? header.cwd.slice(0, 4096) : '', updatedAt, status: ctx.agents.get(String(header.id))?.status === 'running' ? 'active' : 'idle' };
    }
  }));
  return { sessions, workspaces:source.workspaces,workspaceSources:source.workspaceSources,nextOffset: offset + limit < records.length ? offset + limit : null, status: 'ready' };
}
module.exports = { readDshWorkspaceCatalog,resolveDshWorkspaceProject };
