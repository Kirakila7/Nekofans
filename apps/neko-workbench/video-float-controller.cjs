'use strict';
const path=require('node:path');
const {createSocialController}=require('./community-config.cjs');
const {snapFloatingBounds}=require('./floating-window-snap.cjs');
const {createFloatingMenuLayer}=require('./floating-menu-layer.cjs');
const COMPACT={width:480,height:336};
function createVideoFloatController({BrowserWindow,WebContentsView,ipcMain,screen,shell,clipboard,platform=process.platform,baseDir=__dirname,createSocial=createSocialController}){
 let owner=null,window=null,controls=null,closeControls=null,social=null,wanted=false,suspended=false,expanded=false,site='bilibili',loaded=false,disposed=false,revision=0,lastLayout='',pageState={},making=null,expandedSize={width:960,height:640};
 const releases=[];let programmaticBounds=0,nativeUserMove=false,deferredMenuShow=false;
 const valid=()=>window&&!window.isDestroyed();
 const menuLayer=createFloatingMenuLayer({getWindow:()=>window,getOwner:()=>owner,platform,canShow:()=>!disposed&&valid()&&loaded&&wanted&&!suspended&&owner&&!owner.isDestroyed()&&owner.isVisible?.()!==false&&owner.isMinimized?.()!==true,showWindow:()=>{deferredMenuShow=false;window.showInactive?.();void reopen();}});
 function refreshMenuLayer(rect,update=false){const allowed=update?menuLayer.setMenuRect(rect):menuLayer.refresh();if(allowed&&deferredMenuShow){deferredMenuShow=false;if(window.isVisible?.()!==true){window.showInactive?.();void reopen();}}return allowed;}
 const movementEnabled=()=>valid()&&loaded&&wanted&&!suspended&&window.isVisible?.()!==false&&owner?.isMinimized?.()!==true;
 function snapshot(){return {open:wanted&&!suspended,expanded,site,...pageState};}
 function publish(){const state=snapshot();for(const view of [controls,closeControls])if(view&&loaded&&!view.webContents.isDestroyed())view.webContents.send('neko-video-float-state',state);if(owner&&!owner.isDestroyed()&&!owner.webContents.isDestroyed())owner.webContents.send('workbench:video-window-state',state);}
 function raiseControls(){if(!controls||!valid())return;const [width,height]=window.getContentSize();controls.setBounds({x:width-40,y:height-40,width:40,height:40});window.contentView.addChildView(controls);if(closeControls){closeControls.setBounds({x:0,y:0,width:40,height:40});window.contentView.addChildView(closeControls);}}
 function area(bounds=valid()?window.getBounds():owner?.getBounds?.()||{x:0,y:0,width:1200,height:800}){return screen.getDisplayMatching?.(bounds)?.workArea||screen.getPrimaryDisplay().workArea;}
 function setBounds(bounds){nativeUserMove=false;programmaticBounds++;try{window.setBounds(bounds);}finally{programmaticBounds--;}refreshMenuLayer();}
 function snap(){if(!valid())return;const bounds=window.getBounds(),next=snapFloatingBounds(bounds,{workArea:area(bounds),ownerBounds:owner&&!owner.isDestroyed()?(owner.getContentBounds?.()||owner.getBounds?.()):undefined});if(next.x!==bounds.x||next.y!==bounds.y)setBounds({...bounds,x:next.x,y:next.y});}
 function validMove(value){return !!value&&typeof value==='object'&&!Array.isArray(value)&&[value.dx,value.dy].every(n=>Number.isFinite(n)&&Math.abs(n)<=4000)&&(!Object.hasOwn(value,'finished')||typeof value.finished==='boolean');}
 function move(delta){nativeUserMove=false;const bounds=window.getBounds(),next={...bounds,x:bounds.x+delta.dx,y:bounds.y+delta.dy},a=area(next);next.x=Math.max(a.x+8,Math.min(a.x+a.width-bounds.width-8,next.x));next.y=Math.max(a.y+8,Math.min(a.y+a.height-bounds.height-8,next.y));if(next.x!==bounds.x||next.y!==bounds.y)setBounds(next);if(delta.finished===true)snap();}
 function fit(size){const a=area();return {width:Math.min(size.width,Math.max(280,a.width-24)),height:Math.min(size.height,Math.max(250,a.height-24))};}
 function setSize(size){const a=area(),s=fit(size),old=window.getBounds();setBounds({x:Math.max(a.x+8,Math.min(a.x+a.width-s.width-8,old.x)),y:Math.max(a.y+8,Math.min(a.y+a.height-s.height-8,old.y)),...s});}
 function viewport(){const [width,height]=window.getContentSize();return {x:0,y:0,width,height};}
 async function layout(){if(!valid()||!loaded||!wanted||suspended)return;const bounds=viewport(),key=JSON.stringify(bounds);raiseControls();if(lastLayout===key)return;lastLayout=key;await social.action(window,{action:'layout',slot:'left',bounds});raiseControls();}
 function hide(){wanted=false;nativeUserMove=false;deferredMenuShow=false;revision++;if(valid())window.hide();if(social&&valid())void social.action(window,{action:'hide',slot:'left'}).catch(()=>{});publish();}
 function bind(host){if(owner===host)return;if(owner)throw Error('视频浮窗已绑定工作台');owner=host;const on=(name,fn)=>{host.on(name,fn);releases.push(()=>host.removeListener(name,fn));};on('hide',()=>{deferredMenuShow=false;if(valid())window.hide();});on('minimize',()=>{deferredMenuShow=false;if(valid())window.hide();});const restore=()=>{if(!wanted||suspended||!valid())return;if(refreshMenuLayer()){if(window.isVisible?.()!==true){window.showInactive?.();void reopen();}}else deferredMenuShow=menuLayer.isBlocked();};on('show',restore);on('restore',restore);for(const name of ['move','resize'])on(name,()=>refreshMenuLayer());const zoom=()=>refreshMenuLayer();host.webContents.on('zoom-changed',zoom);releases.push(()=>host.webContents.removeListener('zoom-changed',zoom));on('closed',dispose);}
 async function make(){
  const a=area(),size=fit(COMPACT),parent=owner.getBounds?.()||a;
  window=new BrowserWindow({parent:owner,title:'视频浮窗',...size,x:Math.max(a.x+8,parent.x+parent.width-size.width-32),y:Math.max(a.y+8,parent.y+76),show:false,frame:false,hasShadow:false,resizable:false,maximizable:false,fullscreenable:false,skipTaskbar:true,roundedCorners:false,backgroundColor:'#00000000',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  window.setMenu?.(null);window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
  controls=new WebContentsView({webPreferences:{preload:path.join(baseDir,'video-float-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});controls.setBackgroundColor('#00000000');controls.webContents.setWindowOpenHandler(()=>({action:'deny'}));controls.webContents.on('will-navigate',event=>event.preventDefault());
  closeControls=new WebContentsView({webPreferences:{preload:path.join(baseDir,'video-float-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});closeControls.setBackgroundColor('#00000000');closeControls.webContents.setWindowOpenHandler(()=>({action:'deny'}));closeControls.webContents.on('will-navigate',event=>event.preventDefault());
  social=createSocial({WebContentsView,adaptiveVideoViewport:true,openExternal:url=>shell.openExternal(url),copyText:text=>clipboard.writeText(text),onState:(_host,state)=>{pageState={status:state.status,canGoBack:state.canGoBack,canShare:state.canShare,canPlayOfficial:state.canPlayOfficial,isOfficialPlayer:state.isOfficialPlayer};raiseControls();publish();}});social.bindHost(window);
  window.on('close',event=>{if(!disposed){event.preventDefault();hide();}});
  window.on('move',()=>refreshMenuLayer());
  // Only Windows reports native moved as a completed drag. macOS aliases it
  // to continuous move; its real pointerup completion still uses the IPC path.
  if(platform==='win32'){
   window.on('will-move',()=>{if(!programmaticBounds&&movementEnabled())nativeUserMove=true;});
   window.on('moved',()=>{const finished=nativeUserMove;nativeUserMove=false;if(finished&&!programmaticBounds&&movementEnabled())snap();});
  }
  window.on('resize',()=>{if(expanded){const b=window.getBounds();expandedSize={width:b.width,height:b.height};}refreshMenuLayer();void layout().catch(()=>{});publish();});
  window.on('hide',()=>{nativeUserMove=false;if(social&&valid())void social.action(window,{action:'hide',slot:'left'}).catch(()=>{});});
  await Promise.all([controls.webContents.loadFile(path.join(baseDir,'video-float.html')),closeControls.webContents.loadFile(path.join(baseDir,'video-float.html'),{query:{control:'close'}})]);loaded=true;raiseControls();publish();
 }
 async function reopen(){if(!valid()||!loaded||!wanted||suspended)return;const ticket=++revision;lastLayout=JSON.stringify(viewport());try{await social.action(window,{action:'open',site,slot:'left',bounds:viewport(),requestId:ticket});}catch(error){if(ticket===revision){pageState={status:'error'};publish();}}}
 async function action(host,request){
  if(disposed||!request||!['open','hide','suspend','resume','state'].includes(request.action))throw Error('无效视频浮窗操作');bind(host);
  if(request.action==='state')return snapshot();
  if(request.action==='hide'){hide();return snapshot();}
  if(request.action==='suspend'){suspended=true;nativeUserMove=false;deferredMenuShow=false;revision++;if(valid())window.hide();publish();return snapshot();}
  if(request.action==='resume'){suspended=false;if(wanted&&valid()){if(refreshMenuLayer()){if(window.isVisible?.()!==true){window.show();void reopen();}}else deferredMenuShow=menuLayer.isBlocked();}publish();return snapshot();}
  if(!['bilibili','youtube'].includes(request.site))throw Error('请选择 B 站或 YouTube');
  const ticket=++revision;if(site!==request.site){site=request.site;lastLayout='';pageState={};}wanted=true;suspended=false;
  if(!valid())making=make();if(making){const pending=making;await pending;if(making===pending)making=null;}
  if(disposed||!wanted||suspended||ticket!==revision)return snapshot();
  window.setTitle(site==='youtube'?'YouTube · 视频浮窗':'B站 · 视频浮窗');if(refreshMenuLayer()){window.show();window.focus();}else deferredMenuShow=menuLayer.isBlocked();await reopen();publish();return snapshot();
 }
 function setExpanded(value){if(!valid())return;const desired=value?{...expandedSize}:COMPACT;expanded=value;window.setResizable(value);window.setMinimumSize(...(value?[480,400]:[280,250]));setSize(desired);lastLayout='';void layout().catch(()=>{});publish();}
 async function input(event,request){
  if(!valid()||!controls||![controls,closeControls].some(view=>view&&event.sender===view.webContents&&event.senderFrame===view.webContents.mainFrame)||!request||typeof request.action!=='string')throw Error('请从视频浮窗操作');
  if(request.action==='state')return snapshot();
  if(request.action==='close'){hide();return snapshot();}
  if(request.action==='toggle-expanded'){setExpanded(!expanded);return snapshot();}
  if(request.action==='move'){if(!validMove(request))throw Error('视频浮窗移动参数无效');if(movementEnabled())move(request);return snapshot();}
  if(request.action==='resize'){
   if(expanded&&[request.dx,request.dy].every(n=>Number.isFinite(n)&&Math.abs(n)<=4000)){const b=window.getBounds();setSize({width:Math.max(480,b.width+request.dx),height:Math.max(400,b.height+request.dy)});}return snapshot();
  }
  if(!wanted||suspended)throw Error('请先打开视频浮窗');
  if(!['back','reload','play-official','copy-video-link','open-youtube-video','open-youtube-shorts'].includes(request.action))throw Error('视频操作无效');
  return social.action(window,{action:request.action,slot:'left',...(request.action==='open-youtube-video'?{videoUrl:request.videoUrl}:{})});
 }
 function dispose(){if(disposed)return;disposed=true;revision++;menuLayer.dispose();for(const release of releases.splice(0))release();social?.dispose();if(controls&&!controls.webContents.isDestroyed())controls.webContents.close({waitForBeforeUnload:false});if(closeControls&&!closeControls.webContents.isDestroyed())closeControls.webContents.close({waitForBeforeUnload:false});controls=null;closeControls=null;if(valid())window.destroy();window=null;owner=null;ipcMain.removeHandler('neko-video-float');ipcMain.removeListener('neko-video-site-drag',siteDrag);}
 function siteDrag(event,delta){const content=social?.view?.webContents;if(!movementEnabled()||!content||event.sender!==content||event.senderFrame!==content.mainFrame||!validMove(delta))return;move(delta);}
 ipcMain.on('neko-video-site-drag',siteDrag);
 ipcMain.handle('neko-video-float',input);
 return {action,dispose,snapshot,setAccountMenuRect:rect=>refreshMenuLayer(rect,true)};
}
module.exports={createVideoFloatController,COMPACT};
