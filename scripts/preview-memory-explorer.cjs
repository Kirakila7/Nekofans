'use strict';
// Isolated visual fixture. Never opens a real profile or contacts a model.
const {createServer}=require('node:http');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const root=join(__dirname,'..');
function fixture(){
  const texts=['你说喜欢安静的晚上，我们约好下次一起听雨。','一起讨论了窗边的小书桌，想放一盆绿植。','你喜欢茉莉花茶，温热一点，不加糖。','今天把桌面整理好了，留了一个位置给大肥鱼。','我们约好忙完工作后一起看星星。','你希望提醒简短一些，专注工作时少打扰。','一起聊了最近读的书，记下了喜欢的句子。','你提到周末想去公园，记得带上相机。'];
  const kinds=['episode','fact','episode','preference','episode','summary'];
  const rows=Array.from({length:220},(_,i)=>{const at=new Date(Date.UTC(2026,8,1)+i*6*3600000).toISOString(),kind=kinds[i%kinds.length],value={kind,text:texts[i%texts.length]+'（合成记忆 '+(i+1)+'）',visibility:'private',certainty:i%9===0?'candidate':i%4===0?'user-confirmed':'inferred',priority:i%13===0?85+i%16:30+i%45,pinned:i%31===0,evidenceRefs:[i%7===0?'channel:qq:synthetic-'+i:'synthetic-message-'+i]};const event={eventId:'preview-event-'+i,itemId:'preview-memory-'+i,personaId:'bigfish',origin:'user',operation:'upsert',parents:[],occurredAt:at,value};return {itemId:event.itemId,createdAt:at,heads:[event],value,deleted:false,conflict:false};});
  const characters=[{id:'bigfish',name:'大肥鱼',avatar:'assets/icons/bigfish.webp',readOnly:false},{id:'yui',name:'Yui',avatar:'assets/memory-characters/yui.webp',readOnly:true},{id:'claude',name:'Claude小姐',avatar:'assets/memory-characters/claude.webp',readOnly:true}];
  return {character:characters[0],characters,readOnly:false,items:[],summaries:[],memoryModel:{useChatApi:true,hasKey:false},replication:{mode:'neko',autoSync:true,configured:true,pending:0,conflicts:0,providerStates:{neko:'合成预览'},error:'',records:rows}};
}
function browserFixture(state){
  let listener;window.previewCalls=[];
  const archives={yui:[],claude:state.replication.records.slice(0,6).map((r,i)=>{const value={...r.value,text:'Claude小姐的独立合成记忆 '+(i+1)+'：一起讨论了读书计划。',evidenceRefs:['claude-fixture-'+i]};return {...r,itemId:'claude-memory-'+i,value,heads:[{...r.heads[0],personaId:'claude',itemId:'claude-memory-'+i,value}]};})};
  const pet={onState(fn){listener=fn;return()=>{listener=null;};},async call(method,input){
    const id=input?.personaId||'bigfish',character=state.characters.find(c=>c.id===id);if(!character)throw Error('unknown preview character');
    if(method==='chat-memory-read')return structuredClone(id==='bigfish'?state:{...state,character,readOnly:true,memoryModel:null,viewMessage:'合成预览：此人物独立存档，仅供查看。',replication:{...state.replication,mode:'archive',records:archives[id]||[]}});
    if(method==='chat-history')return [];
    if(method!=='chat-memory-action')throw Error('unsupported preview action');
    if(id!=='bigfish')throw Error('read-only character archive');
    window.previewCalls.push(structuredClone(input));
    if(input.action==='sync')return {ok:true};
    if(input.action==='configure-neko')return {ok:false,message:'合成预览不连接模型；实际应用中可保存设置'};
    const row=state.replication.records.find(r=>r.itemId===input.id);if(!row)return {ok:false};
    if(JSON.stringify(row.heads.map(e=>e.eventId))!==JSON.stringify(input.revisionIds))return {ok:false,message:'记忆已有新修订，请刷新'};
    if(input.action==='event-priority'){
      if(!Number.isInteger(input.priority)||input.priority<0||input.priority>100||typeof input.pinned!=='boolean')return {ok:false};
      row.value={...row.value,priority:input.priority,pinned:input.pinned};
    }else if(input.action==='event-update'){row.value={...row.value,text:input.text,certainty:'user-confirmed'};}
    else if(input.action==='event-confirm'){row.value={...row.value,certainty:'user-confirmed'};}
    else if(input.action==='event-delete'){row.deleted=true;row.previousValue=row.value;row.value=null;}
    else if(input.action==='event-restore'){row.deleted=false;row.value=row.previousValue;}
    else return {ok:false};
    row.heads=[{...row.heads[0],eventId:'preview-edit-'+window.previewCalls.length,parents:input.revisionIds,operation:row.deleted?'delete':'upsert',value:row.value,occurredAt:new Date().toISOString()}];
    return {ok:true};
  }};
  window.disposeMemoryPreview=window.WorkbenchChatUI.mountMemory(document.getElementById('root'),pet);
}
function createPreviewServer(){
  return createServer((req,res)=>{
    const routes={'/style.css':['text/css','apps/neko-workbench/style.css'],'/main-chat-ui.js':['text/javascript','apps/neko-workbench/main-chat-ui.js']};
    routes['/assets/icons/bigfish.webp']=['image/webp','apps/neko-workbench/assets/icons/bigfish.webp'];
    for(const character of ['yui','claude'])routes['/assets/memory-characters/'+character+'.webp']=['image/webp','apps/neko-workbench/assets/memory-characters/'+character+'.webp'];
    for(const icon of ['plus','minus','refresh-cw'])routes['/assets/memory-icons/'+icon+'.svg']=['image/svg+xml','apps/neko-workbench/assets/memory-icons/'+icon+'.svg'];
    if(req.url==='/workbench'){
      const bundle=readFileSync(join(root,'apps/neko-workbench/embedded-dsh/b0-skin/packages/dsh-client-ui-white-label/lib/client.js'),'utf8');
      const railCss=JSON.parse(bundle.match(/const SIDE_RAIL_CSS = ("(?:[^"\\]|\\.)*");/)[1]);
      const shell=readFileSync(join(root,'apps/neko-workbench/embedded-dsh/workspace-shell-source.js'),'utf8');
      const start=shell.indexOf('  const communityButton ='),end=shell.indexOf('  // Lobby (频道)',start);
      res.setHeader('content-type','text/html; charset=utf-8');return res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>鱼的记忆 · 入口预览</title><style>'+railCss+readFileSync(join(root,'apps/neko-workbench/embedded-dsh/workspace-shell-source.css'),'utf8')+'body{margin:0;font:14px system-ui;background:#f2f7fb;color:#36556c}main{margin-left:88px;padding:32px}h1{font-size:22px}</style><aside data-neko-side-rail class="neko-side-rail"><div id="rail-controls" class="neko-workspace-rail-controls"></div></aside><main><h1>鱼的记忆</h1><p>点击左侧社区下方的记忆按钮，打开星图。</p><p>预览使用合成记忆。</p><p id="status" role="status"></p></main><script>const doc=document,railTop=doc.getElementById("rail-controls"),disposed=false,lobby=null;const el=(tag,cls,text)=>{const n=doc.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};const button=(label,cls,click)=>{const n=el("button",cls,label);n.type="button";n.addEventListener("click",click);return n;};function closeSettings(){}function showError(error){doc.getElementById("status").textContent=error.message;}const options={openCommunity:()=>{doc.getElementById("status").textContent="社区入口";}},bridge={action:async name=>{if(name==="chat-memory")location.assign("/");}};'+shell.slice(start,end)+'</script></html>');
    }
    if(req.url==='/'){res.setHeader('content-type','text/html; charset=utf-8');return res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>鱼的记忆 · 合成数据预览</title><link rel="stylesheet" href="/style.css"><div id="root" style="height:100vh"></div><script src="/main-chat-ui.js"></script><script src="/fixture.js"></script></html>');}
    if(req.url==='/fixture.js'){res.setHeader('content-type','text/javascript; charset=utf-8');return res.end('('+browserFixture.toString()+')('+JSON.stringify(fixture())+');');}
    const route=routes[req.url];if(!route){res.writeHead(404);return res.end();}res.setHeader('content-type',route[0]+'; charset=utf-8');res.end(readFileSync(join(root,route[1])));
  });
}
module.exports={createPreviewServer,fixture,browserFixture};
if(require.main===module){const server=createPreviewServer();server.listen(Number(process.argv[2]||0),'127.0.0.1',()=>console.log('MEMORY_PREVIEW http://127.0.0.1:'+server.address().port+' PID '+process.pid));}
