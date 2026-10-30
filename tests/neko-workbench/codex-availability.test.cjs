'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createWorkspaceLayout}=require('../../apps/neko-workbench/workspace-layout.cjs');
const {createWorkspaceController}=require('../../apps/neko-workbench/workspace-controller.cjs');
const {CODEX_AVAILABLE,assertCodexActionAllowed}=require('../../apps/neko-workbench/codex-availability.cjs');

test('testing mode blocks fresh Codex work but permits state, stop and approval',()=>{
 assert.equal(CODEX_AVAILABLE,false);
 for(const action of ['codex-read','codex-send','codex-model-choice','choose-project']) assert.throws(()=>assertCodexActionAllowed(action),/测试中/);
 for(const action of ['codex-state','codex-stop','codex-approve','catalog','state','update','update-seat','upload-seat']) assert.doesNotThrow(()=>assertCodexActionAllowed(action));
 assert.doesNotThrow(()=>assertCodexActionAllowed('codex-send',true));
});
test('testing mode hides Codex sessions, does not connect, and preserves selected Codex seat on disk',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'neko-codex-disabled-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'layout.json'),layout=createWorkspaceLayout(file);
 layout.update({officeMode:'codex',activeSeatId:'seat-2'});
 const saved=fs.readFileSync(file,'utf8'); let calls=0;
 const controller=createWorkspaceController({layout,codex:{list:async()=>{calls++;throw Error('must not connect');}},readDsh:async()=>({status:'ready',sessions:[{provider:'dsh',id:'d',cwd:'/work'}]})});
 const visible=controller.state();
 assert.equal(visible.codexAvailable,false);assert.equal(visible.officeMode,'dsh');assert.equal(visible.activeSeatId,'seat-1');
 const rows=await controller.catalog({force:true});
 assert.equal(calls,0);assert.equal(rows.providers.codex,'testing');assert.deepEqual(rows.sessions.map(s=>s.provider),['dsh']);
 assert.throws(()=>controller.update({officeMode:'codex'}),/测试中/);
 assert.throws(()=>controller.update({activeSeatId:'seat-2'}),/测试中/);
 assert.throws(()=>controller.updateSeat('seat-3',{provider:'codex'}),/测试中/);
 assert.equal(fs.readFileSync(file,'utf8'),saved);
 assert.equal(createWorkspaceLayout(file).get().officeMode,'codex');
 const reenabled=createWorkspaceController({layout,codexAvailable:true,codex:{list:async()=>({status:'ready',sessions:[]})},readDsh:async()=>({status:'ready',sessions:[]})});
 assert.equal(reenabled.state().officeMode,'codex');assert.equal(reenabled.state().activeSeatId,'seat-2');
});
test('existing running Codex work remains visible until it finishes, and DSH remains selectable',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'neko-codex-active-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const layout=createWorkspaceLayout(path.join(dir,'layout.json'));layout.update({officeMode:'codex',activeSeatId:'seat-2'});
 let view={status:'working',approvals:[]};
 const controller=createWorkspaceController({layout,codex:{snapshot:()=>view,list:()=>{throw Error('should not connect');}},readDsh:async()=>({status:'ready',sessions:[{id:'dsh-1',provider:'dsh',cwd:'/work'}]})});
 assert.equal(controller.state().officeMode,'codex');
 view={status:'idle',approvals:[{key:'approval-1'}]};assert.equal(controller.state().officeMode,'codex');
 view={status:'idle',approvals:[]};assert.equal(controller.state().officeMode,'dsh');
 const catalog=await controller.catalog();assert.equal(catalog.sessions[0].id,'dsh-1');
 controller.update({officeMode:'dsh',activeSeatId:'seat-1'});assert.equal(controller.state().officeMode,'dsh');
});
test('existing Codex seat metadata remains editable without creating a new binding',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'neko-codex-seat-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const layout=createWorkspaceLayout(path.join(dir,'layout.json'));
 layout.updateSeat('seat-2',{projectRoot:'/old-codex-project'});
 const controller=createWorkspaceController({layout,codex:{},readDsh:async()=>({status:'ready',sessions:[]})});
 controller.updateSeat('seat-2',{name:'开发喵',avatarId:'gemini',provider:'codex',projectRoot:'/old-codex-project'});
 const saved=layout.get().seats.find(s=>s.id==='seat-2');
 assert.equal(saved.name,'开发喵');assert.equal(saved.avatarId,'gemini');assert.equal(saved.provider,'codex');assert.equal(saved.projectRoot,'/old-codex-project');
 assert.throws(()=>controller.updateSeat('seat-3',{provider:'codex'}),/测试中/);
 assert.throws(()=>controller.updateSeat('seat-2',{provider:'codex',projectRoot:'/different-unknown'}),/已有项目/);
 assert.throws(()=>assertCodexActionAllowed('codex-send'),/测试中/);
});
