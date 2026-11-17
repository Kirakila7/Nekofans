'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {readDshWorkspaceCatalog}=require('../../apps/neko-workbench/dsh-workspace-catalog.cjs');
const {createWorkspaceController}=require('../../apps/neko-workbench/workspace-controller.cjs');
const {projectGroups}=require('../../apps/neko-workbench/workspace-layout.cjs');
const {workspaceProjectId,installedProjectId,historyProjectId}=require('../../apps/neko-workbench/dsh-project-discovery.cjs');
function temp(t){const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'neko-project-catalog-')));t.after(()=>{assert.equal(path.dirname(root),fs.realpathSync.native(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});return root;}
function fixture(t){const root=temp(t),current=path.join(root,'current'),external=path.join(root,'external');fs.mkdirSync(current);fs.mkdirSync(external);let rows=[{id:'registered',path:current,title:'Registry title',sessionIds:['s'],updatedAt:'2026-01-01T00:00:00Z'}];const calls=[];const ctx={workspaceRegistry:{list:()=>rows,create:async(cwd,title)=>{calls.push({cwd,title});const workspace={id:'new-id',path:cwd,title,sessionIds:[]};rows.push(workspace);return workspace;}},agents:new Map(),sessionQuery:{listSessions:async()=>[{header:{id:'s',cwd:current,createdAt:1}},{header:{id:'child',cwd:current,parentSession:'s'}}],observeSession:async()=>({projections:{values:{title:'Real session'}},[Symbol.dispose](){}})}};const dependencies={readInstalledProjects:async()=>({status:'ready',workspaces:[{id:installedProjectId('external'),provider:'dsh',workspaceId:null,cwd:external,name:'External empty project',source:'installed-dsh',needsRegistration:true,sessionIds:[],updatedAt:2}]})};return {root,current,external,ctx,calls,dependencies};}
function controller(readDsh,extra={}){return createWorkspaceController({layout:{get:()=>({seats:[]})},codex:{snapshot:()=>({})},codexAvailable:false,readDsh,...extra});}

test('catalog includes authoritative registry workspaces and external empty projects without creating or resuming anything',async t=>{
 const f=fixture(t),result=await readDshWorkspaceCatalog(f.ctx,{},f.dependencies);assert.equal(result.sessions.length,1);assert.equal(result.workspaces.length,2);assert.equal(result.workspaces[0].workspaceId,'registered');assert.equal(result.workspaces[0].name,'Registry title');assert.equal(result.workspaces[1].needsRegistration,true);assert.deepEqual(f.calls,[]);
 const groups=projectGroups(result.sessions,result.workspaces);assert.equal(groups.length,2);assert.equal(groups[0].sessions[0].id,'s');assert.equal(groups[1].sessions.length,0);assert.equal(groups[1].id,installedProjectId('external'));
});

test('registry membership attaches historical Windows path aliases to their real workspace instead of creating duplicate projects',()=>{
 const rows=[{id:'session',provider:'dsh',cwd:'C:\\LONGNA~1\\project',title:'Retained',updatedAt:1}],workspaces=[{id:'known',provider:'dsh',workspaceId:'native',cwd:'C:\\Long Name\\project',name:'Official title',source:'workbench',needsRegistration:false,sessionIds:['session']}];
 const groups=projectGroups(rows,workspaces);assert.equal(groups.length,1);assert.equal(groups[0].id,'known');assert.equal(groups[0].sessions[0].id,'session');
});

test('explicit resolution rechecks public registry and registers only the selected project through official API',async t=>{
 const f=fixture(t),requests=[];const deps={readInstalledProjects:async value=>{requests.push(value);return f.dependencies.readInstalledProjects();}};
 const selected=await readDshWorkspaceCatalog(f.ctx,{action:'resolve-project',projectId:installedProjectId('external'),path:f.root},deps);
 assert.equal(selected.workspaceId,'new-id');assert.equal(selected.path,fs.realpathSync(f.external));assert.deepEqual(f.calls,[{cwd:fs.realpathSync(f.external),title:'External empty project'}]);assert.deepEqual(requests,[{force:true}]);
 const same=await readDshWorkspaceCatalog(f.ctx,{action:'resolve-project',projectId:workspaceProjectId('new-id')},deps);assert.equal(same.workspaceId,'new-id');assert.equal(f.calls.length,1);
 await assert.rejects(readDshWorkspaceCatalog(f.ctx,{action:'resolve-project',projectId:'forged:'+f.root},deps),/项目已变化/);assert.equal(f.calls.length,1);
 await assert.rejects(readDshWorkspaceCatalog(f.ctx,{action:'resolve-project',projectId:installedProjectId('removed')},deps),/项目已变化/);
});

test('existing canonical path wins over an external registration and missing external data never becomes a new project',async t=>{
 const f=fixture(t),duplicate={readInstalledProjects:async()=>({status:'ready',workspaces:[{id:installedProjectId('duplicate'),provider:'dsh',workspaceId:null,cwd:f.current,name:'Foreign title',source:'installed-dsh',needsRegistration:true,sessionIds:[]}]})};
 const list=await readDshWorkspaceCatalog(f.ctx,{},duplicate);assert.equal(list.workspaces.length,1);assert.equal(list.workspaces[0].name,'Registry title');
 const result=await readDshWorkspaceCatalog(f.ctx,{action:'resolve-project',projectId:installedProjectId('duplicate')},duplicate);assert.equal(result.workspaceId,'registered');assert.equal(f.calls.length,0);
 await assert.rejects(readDshWorkspaceCatalog(f.ctx,{action:'resolve-project',projectId:installedProjectId('duplicate')},{readInstalledProjects:async()=>({status:'unavailable',workspaces:[]})}),/暂不可读取/);assert.equal(f.calls.length,0);
});

test('history-only projects resolve by a fresh known header, never by a renderer-supplied path',async t=>{
 const f=fixture(t);f.ctx.workspaceRegistry.list=()=>[];const result=await readDshWorkspaceCatalog(f.ctx,{action:'resolve-project',projectId:historyProjectId(f.current),path:f.external});assert.equal(result.path,fs.realpathSync(f.current));assert.equal(f.calls[0].cwd,fs.realpathSync(f.current));
 await assert.rejects(readDshWorkspaceCatalog(f.ctx,{action:'resolve-project',projectId:historyProjectId(f.external)}),/项目已变化/);
});

test('a registry path changed into a junction is refused before official registration',async t=>{
 const f=fixture(t),redirect=path.join(f.root,'redirect');fs.symlinkSync(f.external,redirect,process.platform==='win32'?'junction':'dir');
 await assert.rejects(readDshWorkspaceCatalog(f.ctx,{action:'resolve-project',projectId:installedProjectId('redirect')},{readInstalledProjects:async()=>({status:'ready',workspaces:[{id:installedProjectId('redirect'),cwd:redirect,name:'Redirect'}]})}),/目录不存在或已变化/);assert.equal(f.calls.length,0);
});

test('identical forced refreshes retain a stable revision while transient failures preserve rows and pagination',async()=>{
 let clock=10,fail=false,empty=false,calls=0;const read=async()=>{calls++;if(fail)throw Error('PRIVATE');return {status:'ready',sessions:empty?[]:[{id:'s',provider:'dsh',cwd:'/stable',title:'Task',updatedAt:1}],nextOffset:empty?null:80};};const c=controller(read,{now:()=>clock});
 const first=await c.catalog();clock=20;const same=await c.catalog({force:true});assert.deepEqual(first,same);assert.equal(same.revision,1);assert.equal(same.fetchedAt,10);
 same.sessions[0].title='tampered';assert.equal((await c.catalog()).sessions[0].title,'Task');assert.equal(calls,2);
 fail=true;clock=30;const failed=await c.catalog({force:true});assert.equal(failed.sessions.length,1);assert.equal(failed.nextDshOffset,80);assert.deepEqual(failed.staleProviders,['dsh']);assert.equal(failed.providers.dsh,'unavailable');assert(!JSON.stringify(failed).includes('PRIVATE'));
 fail=false;empty=true;const recovered=await c.catalog({force:true});assert.equal(recovered.sessions.length,0);assert.equal(recovered.nextDshOffset,null);assert.deepEqual(recovered.staleProviders,[]);
});

test('different catalog pages serialize and same-page requests join without wiping earlier pages',async()=>{
 const calls=[],resolvers=[];const c=controller(request=>new Promise(resolve=>{calls.push(request);resolvers.push(resolve);}));
 const first=c.catalog({force:true}),joined=c.catalog({force:true}),later=c.catalog({force:true,dshOffset:80});await new Promise(setImmediate);assert.equal(calls.length,1);assert.equal(calls[0].offset,0);
 resolvers[0]({status:'ready',sessions:[{id:'one',provider:'dsh',cwd:'/one'}],nextOffset:80});assert.equal((await first).sessions.length,1);assert.deepEqual(await joined,await first);await new Promise(setImmediate);assert.equal(calls.length,2);assert.equal(calls[1].offset,80);
 resolvers[1]({status:'ready',sessions:[{id:'two',provider:'dsh',cwd:'/two'}],nextOffset:null});assert.deepEqual((await later).sessions.map(row=>row.id),['one','two']);
});

test('controller resolves only advertised project identities and rejects a mismatched backend directory',async t=>{
 const f=fixture(t),requests=[];let mismatch=false;const c=controller(async request=>{requests.push(request);if(request.action==='resolve-project')return {projectId:installedProjectId('external'),workspaceId:'registered-now',path:mismatch?f.current:f.external,name:'Project'};return readDshWorkspaceCatalog(f.ctx,request,f.dependencies);});
 await c.catalog();await assert.rejects(c.resolveProject('arbitrary:'+f.current),/当前项目列表/);assert.equal(requests.length,1);
 const result=await c.resolveProject(installedProjectId('external'));assert.equal(result.path,f.external);assert.equal(requests.at(-1).projectId,installedProjectId('external'));
 mismatch=true;await assert.rejects(c.resolveProject(installedProjectId('external')),/未能确认/);
});
