'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path');
let JSDOM; try { ({JSDOM}=require(path.join(process.env.NEKO_DOM_DEPS || '/private/tmp/neko-sidebar-dom-20261026','node_modules/jsdom'))); } catch {}
const {createWorkspaceLayout}=require('../../apps/neko-workbench/workspace-layout.cjs');
const tick=()=>new Promise(resolve=>setTimeout(resolve,25));
test('fixed scene uses the real project chooser in the coding pane without closing video or drafts',{skip:!JSDOM},async t=>{
 const dom=new JSDOM('<body><aside data-neko-side-rail><div class="neko-side-rail__theme"></div></aside><aside data-slot="sidebar"><div data-slot="sidebar.workspaces"></div><div data-slot="settings.launcher"></div></aside><main data-neko-unified-coding data-neko-flex-coding><textarea>未发送的草稿</textarea></main></body>',{runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
 const w=dom.window,d=w.document,sidebar=d.querySelector('[data-slot="sidebar"]'),coding=d.querySelector('main');sidebar.getBoundingClientRect=()=>({left:64,top:0,right:304,bottom:800,width:240,height:800});coding.getBoundingClientRect=()=>({left:600,top:400,right:1024,bottom:800,width:424,height:400});
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'neko-fixed-project-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));const store=createWorkspaceLayout(path.join(temp,'layout.json'));let hidden=0;const opened=[];
 const bridge={action:async()=>({}),getState:async()=>({workspaceRoot:'/p',workspaceRevision:0,companion:{ready:true,messages:[]}}),companion:async()=>({}),workspace:async r=>r.action==='state'?{...store.get(),codexAvailable:false}:r.action==='update'?{...store.update(r.patch),codexAvailable:false}:r.action==='codex-state'?{items:[],approvals:[]}:r.action==='catalog'?{sessions:[{id:'one',provider:'dsh',cwd:'/p/fish',title:'已有会话'}],projects:[],providers:{dsh:'ready',codex:'testing'}}:null};
 w.eval(fs.readFileSync(path.join(__dirname,'../../apps/neko-workbench/embedded-dsh/workspace-shell-source.js'),'utf8')+'\nwindow.install=installWorkspaceShell');
 const stop=w.install({window:w,document:d,bridge,avatar:()=>'',locateSidebar:()=>({root:sidebar,slot:sidebar}),hideSocial:()=>hidden++,openDshSession:async id=>opened.push(id),openDshNew:async dir=>opened.push(dir)});t.after(stop);await tick();
 d.body.setAttribute('data-neko-unified-enabled','');d.body.setAttribute('data-neko-fixed-scene','');d.dispatchEvent(new w.Event('neko-fixed-scene-enter'));await tick();
 const picker=d.querySelector('.neko-startup'),button=d.querySelector('.neko-scene-projects');assert(!picker.hidden);assert.equal(picker.style.left,'600px');assert.equal(picker.style.top,'400px');assert.equal(picker.style.width,'424px');assert(!button.hidden);
 picker.querySelector('.neko-startup__session').click();await tick();assert.deepEqual(opened,['one']);assert.equal(hidden,0);assert(picker.hidden);assert.equal(coding.querySelector('textarea').value,'未发送的草稿');assert(d.body.hasAttribute('data-neko-fixed-scene'));
 button.click();await tick();assert(!picker.hidden);picker.querySelector('.neko-startup__project-new').click();await tick();assert.deepEqual(opened,['one','/p/fish']);assert.equal(hidden,0);assert(picker.hidden);assert.equal(coding.querySelector('textarea').value,'未发送的草稿');
 d.body.removeAttribute('data-neko-fixed-scene');d.dispatchEvent(new w.Event('neko-fixed-scene-exit'));await tick();assert(button.hidden);assert(picker.hidden);
});
