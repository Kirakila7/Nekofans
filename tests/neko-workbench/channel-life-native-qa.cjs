'use strict';
if(process.env.NEKO_CHANNEL_NATIVE_QA!=='1')throw Error('Set NEKO_CHANNEL_NATIVE_QA=1 for isolated QA');
const {app,BrowserWindow,Menu,dialog}=require('electron'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict');
const out=process.env.NEKO_CHANNEL_QA_DIR;if(!out||!path.isAbsolute(out))throw Error('Set an absolute NEKO_CHANNEL_QA_DIR');fs.mkdirSync(out,{recursive:true});
Object.assign(process.env,{NEKO_WORKBENCH_DATA_DIR:path.join(out,'data'),NEKO_WORKBENCH_WORKSPACE:path.join(out,'workspace'),NEKO_WORKBENCH_ELECTRON_USER_DATA:path.join(out,'electron'),NEKO_WORKBENCH_DSH_CLI:path.join(out,'missing-dsh'),NEKO_WORKBENCH_DSH_MODULES:path.join(out,'missing-modules'),PET_WORKBENCH_ONLY:'0',PET_OPEN_WORKBENCH:'0'});
let menuTemplate,modelRequests=0;const errors=[],build=Menu.buildFromTemplate;
Menu.buildFromTemplate=function(template){if(template.some(row=>row.label==='养鱼'))menuTemplate=template;const menu=build.call(this,template);menu.popup=()=>{};return menu;};dialog.showErrorBox=()=>{};
process.on('unhandledRejection',e=>errors.push(String(e)));process.on('uncaughtException',e=>{fs.writeFileSync(path.join(out,'error.txt'),e.stack);app.exit(1);});
const original=Module._load;Module._load=function(name,...args){const loaded=original.call(this,name,...args);if(name==='./main-chat-runtime.cjs')return {...loaded,WorkbenchMainChat:class extends loaded.WorkbenchMainChat{constructor(options){super({...options,memoryWorker:{request:async()=>{throw Error('synthetic offline');},close:async()=>{},stop:async()=>{}}});}async generateProactive(){modelRequests++;throw Error('No real model in QA');}}};return loaded;};
require(path.resolve(__dirname,'../../apps/neko-workbench/main.cjs'));Module._load=original;
app.whenReady().then(()=>setTimeout(async()=>{try{
  const pet=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='大肥鱼');assert(pet?.isVisible());await pet.webContents.executeJavaScript("window.pet.call('menu')");
  const menu=menuTemplate.find(r=>r.label==='养鱼').submenu.find(r=>r.label==='渠道经历与主动搭话').submenu;assert.equal(menu[0].checked,true);assert.equal(menu[1].checked,false);
  menu[1].click({checked:true});let saved=JSON.parse(fs.readFileSync(path.join(out,'data/channel-life.json'),'utf8'));assert.equal(saved.proactiveEnabled,true);
  menu[1].click({checked:false});saved=JSON.parse(fs.readFileSync(path.join(out,'data/channel-life.json'),'utf8'));assert.equal(saved.proactiveEnabled,false);assert.equal(modelRequests,0);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({petVisible:true,memoryDefaultOn:true,proactiveDefaultOff:true,menuTogglePersisted:true,modelRequests,errors},null,2));app.quit();
}catch(e){fs.writeFileSync(path.join(out,'error.txt'),e.stack);app.exit(1);}},2500));
