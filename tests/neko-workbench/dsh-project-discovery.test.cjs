'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createDshProjectDiscovery,projectRegistryRows}=require('../../apps/neko-workbench/dsh-project-discovery.cjs');
function temp(t){const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'neko-project-discovery-')));t.after(()=>{assert.equal(path.dirname(root),fs.realpathSync.native(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});return root;}
function document(rows){return {unit:{name:'workspace',version:2},global:{initialized:true,workspaceIds:rows.map(r=>r.id)},tables:{workspaces:Object.fromEntries(rows.map(({id,...r})=>[id,r]))}};}
const row=(id,cwd,title=id)=>({id,path:cwd,title,sessionIds:['EXTERNAL-SESSION-NOT-RESUMABLE'],createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-02T00:00:00Z'});
function write(home,value){fs.mkdirSync(path.join(home,'storages'),{recursive:true});fs.writeFileSync(path.join(home,'storages/workspace.json'),JSON.stringify(value));}

test('official public workspace domain preserves empty projects and order without returning external sessions or extra data',t=>{
 const root=temp(t),value=document([row('two',path.join(root,'second'),'Named project'),row('one',path.join(root,'first'),'First')]);value.tables.credentials={secret:'DO-NOT-RETURN'};
 const projects=projectRegistryRows(value);assert.deepEqual(projects.map(p=>p.name),['Named project','First']);assert.equal(projects[0].workspaceId,null);assert.equal(projects[0].source,'installed-dsh');assert(projects.every(p=>p.needsRegistration&&p.sessionIds.length===0));
 assert(!JSON.stringify(projects).includes('EXTERNAL-SESSION'));assert(!JSON.stringify(projects).includes('DO-NOT-RETURN'));
 assert.deepEqual(projectRegistryRows(document([])),[]);
});

test('discovery reads only the declared public registry, caches clones and explicitly refreshes',async t=>{
 const root=temp(t),home=path.join(root,'dsh');write(home,document([row('one',root,'Original')]));fs.writeFileSync(path.join(home,'.credentials.yaml'),'not even YAML: [PRIVATE]');
 let clock=1;const discovery=createDshProjectDiscovery({dshHome:home,now:()=>clock});const first=await discovery.list();assert.equal(first.status,'ready');first.workspaces[0].name='tampered';
 write(home,document([row('one',root,'Renamed')]));assert.equal((await discovery.list()).workspaces[0].name,'Original');assert.equal((await discovery.list({force:true})).workspaces[0].name,'Renamed');
 clock+=20001;write(home,document([]));assert.deepEqual((await discovery.list()).workspaces,[]);
});

test('missing, malformed, oversized, foreign and incomplete registries remain read-only and fail closed',async t=>{
 const root=temp(t),home=path.join(root,'missing'),discovery=createDshProjectDiscovery({dshHome:home});assert.equal((await discovery.list()).status,'not-found');assert(!fs.existsSync(home),'discovery must never initialize another DSH home');
 for(const value of [{unit:{name:'credentials',version:2}}, {...document([row('x',root)]),global:{initialized:true,workspaceIds:['x'],pendingMutation:{operation:'create',workspaceId:'later'}}}, {...document([]),unit:{name:'workspace',version:99}}, {...document([]),global:{initialized:false,workspaceIds:[]}}]){write(home,value);assert.equal((await discovery.list({force:true})).status,'unavailable');}
 fs.writeFileSync(path.join(home,'storages/workspace.json'),'x'.repeat(4*1024*1024+1));assert.equal((await discovery.list({force:true})).status,'unavailable');
});

test('a redirected storage directory cannot turn discovery into an arbitrary-file reader',async t=>{
 const root=temp(t),home=path.join(root,'home'),outside=path.join(root,'outside');fs.mkdirSync(home);write(outside,document([row('outside',root)]));
 fs.symlinkSync(path.join(outside,'storages'),path.join(home,'storages'),process.platform==='win32'?'junction':'dir');
 assert.equal((await createDshProjectDiscovery({dshHome:home}).list()).status,'unavailable');
});

test('Windows public registry rejects drive-relative, duplicate and control-character roots',()=>{
 assert.throws(()=>projectRegistryRows(document([row('bad','C:relative')]),{platform:'win32'}));
 assert.throws(()=>projectRegistryRows(document([row('bad','C:\\project\u0000')]),{platform:'win32'}));
 assert.throws(()=>projectRegistryRows(document([row('one','C:\\Project'),row('two','c:/project')]),{platform:'win32'}));
 const valid=projectRegistryRows(document([row('network','\\\\server\\share\\project')]),{platform:'win32'});assert.equal(valid.length,1);
});
