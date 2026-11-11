'use strict';
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const forms=require('./compact-questions.js');
function createPetQuestionController({BrowserWindow,screen,ipcMain,request,baseDir=__dirname}){
  const records=new Map(),url=pathToFileURL(path.join(baseDir,'pet-question.html')).href;
  function position(row){
    const p=row.parent.getBounds(),area=screen.getDisplayMatching?.(p)?.workArea||screen.getPrimaryDisplay().workArea,width=Math.min(300,area.width-16),height=Math.min(340,area.height-16);
    row.window.setBounds({x:Math.round(Math.max(area.x+8,Math.min(area.x+area.width-width-8,p.x+p.width/2-width/2))),y:Math.round(Math.max(area.y+8,Math.min(area.y+area.height-height-8,p.y+60-height))),width,height});
  }
  function show(row){
    if(row.window.isDestroyed()||row.parent.isDestroyed())return;
    position(row);if(row.ready){row.window.webContents.send('pet-question:state',{...row.question,reveal:row.forceReveal===true});row.forceReveal=false;}
    if(row.ready&&row.parent.isVisible()&&row.dismissed!==row.question?.key)row.window.showInactive();else row.window.hide();
  }
  function remove(id){const row=records.get(id);if(!row)return;records.delete(id);for(const [name,fn] of row.listeners)row.parent.removeListener?.(name,fn);if(!row.window.isDestroyed())row.window.destroy();}
  function sync(id,parent,value){
    const question=forms.normalize(value);if(!question||!parent||parent.isDestroyed()){remove(id);return;}
    let row=records.get(id);
    if(row&&row.parent!==parent){remove(id);row=null;}
    if(!row){
      const window=new BrowserWindow({width:300,height:340,show:false,frame:false,resizable:false,skipTaskbar:true,alwaysOnTop:true,parent,transparent:true,hasShadow:false,title:'任务选项',webPreferences:{preload:path.join(baseDir,'pet-question-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
      row={id,parent,window,question,ready:false,dismissed:null,forceReveal:true,listeners:[]};records.set(id,row);
      window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
      window.webContents.on('did-finish-load',()=>{if(records.get(id)===row){row.ready=true;show(row);}});
      window.on('close',event=>{event.preventDefault();row.dismissed=row.question?.key;window.hide();});
      for(const name of ['move','resize','show','hide']){const fn=()=>show(row);parent.on(name,fn);row.listeners.push([name,fn]);}
      const closed=()=>remove(id);parent.on('closed',closed);row.listeners.push(['closed',closed]);
      window.loadFile(path.join(baseDir,'pet-question.html'));
    }
    if(row.question?.key!==question.key||row.question?.revision!==question.revision){row.dismissed=null;row.forceReveal=true;}
    row.question=question;show(row);
  }
  const handle=async(event,input)=>{
    const row=[...records.values()].find(row=>row.window.webContents===event.sender);
    if(!row||event.senderFrame!==row.window.webContents.mainFrame||event.senderFrame?.url!==url)return {ok:false};
    const q=row.question;if(!q||input?.sessionId!==q.sessionId||input.key!==q.key||input.revision!==q.revision)return {ok:false};
    if(input?.type==='hide'){row.dismissed=row.question?.key;row.window.hide();return {ok:true};}
    return request(row.id,input);
  };
  ipcMain.handle('pet-question:action',handle);
  return {sync,reveal(id){const row=records.get(id);if(!row)return false;row.dismissed=null;row.forceReveal=true;show(row);return true;},isOpen(id){const row=records.get(id);return !!row&&!row.window.isDestroyed()&&row.window.isVisible();},dispose(){for(const id of [...records.keys()])remove(id);ipcMain.removeHandler('pet-question:action');}};
}
module.exports={createPetQuestionController};
