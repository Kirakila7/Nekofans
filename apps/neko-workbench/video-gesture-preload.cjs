'use strict';
const {ipcRenderer}=require('electron');
{const module={exports:{}};
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory;else root.installNekoHoldDrag=factory;})(typeof globalThis==='object'?globalThis:this,function installNekoHoldDrag(doc,send,{delay=380,trustedOnly=false}={}){
  let pending=null,suppress=false;const win=doc.defaultView;
  function finish(complete=false){const p=pending;pending=null;if(!p)return;win.clearTimeout(p.timer);doc.documentElement.removeAttribute('data-hold-dragging');if(p.active){suppress=true;try{p.target.releasePointerCapture?.(p.id);}catch{}if(complete===true&&p.moved)send({dx:0,dy:0,finished:true});}}
  function down(e){if(e.button!==0||e.isPrimary===false||trustedOnly&&!e.isTrusted)return;finish();suppress=false;const p={id:e.pointerId,target:e.target,x:e.screenX,y:e.screenY,startX:e.screenX,startY:e.screenY,active:false};pending=p;p.timer=win.setTimeout(()=>{if(pending!==p)return;p.active=true;doc.documentElement.setAttribute('data-hold-dragging','');try{p.target.setPointerCapture?.(p.id);}catch{}},delay);}
  function move(e){const p=pending;if(!p||p.id!==e.pointerId||trustedOnly&&!e.isTrusted)return;if(!p.active){if(Math.hypot(e.screenX-p.startX,e.screenY-p.startY)>6)finish();return;}e.preventDefault();e.stopImmediatePropagation();const dx=e.screenX-p.x,dy=e.screenY-p.y;p.x=e.screenX;p.y=e.screenY;if(dx||dy){p.moved=true;send({dx,dy});}}
  function up(e){if(!pending||pending.id!==e.pointerId||trustedOnly&&!e.isTrusted)return;if(pending.active){e.preventDefault();e.stopImmediatePropagation();}finish(e.type==='pointerup');}
  function click(e){if(!suppress)return;suppress=false;e.preventDefault();e.stopImmediatePropagation();}
  function key(e){if(e.key==='Escape')finish();}
  doc.addEventListener('pointerdown',down,true);doc.addEventListener('pointermove',move,{capture:true,passive:false});for(const type of ['pointerup','pointercancel'])doc.addEventListener(type,up,true);doc.addEventListener('click',click,true);doc.addEventListener('keydown',key,true);win.addEventListener('blur',finish);
  return()=>{finish();doc.removeEventListener('pointerdown',down,true);doc.removeEventListener('pointermove',move,true);for(const type of ['pointerup','pointercancel'])doc.removeEventListener(type,up,true);doc.removeEventListener('click',click,true);doc.removeEventListener('keydown',key,true);win.removeEventListener('blur',finish);};
});

if(process.isMainFrame)window.addEventListener('DOMContentLoaded',()=>{module.exports(document,delta=>ipcRenderer.send('neko-video-site-drag',delta),{trustedOnly:true});const style=document.createElement('style');style.textContent='html[data-hold-dragging],html[data-hold-dragging] *{cursor:grabbing!important;user-select:none!important}';document.head.append(style);});
}
