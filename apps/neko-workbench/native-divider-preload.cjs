'use strict';
// Local, sandboxed divider surface. It receives no workbench data or arbitrary IPC.
const {ipcRenderer}=require('electron');
let active=false,token=0,lastClick=0,lastX=0,downX=0,moved=false,pointerId=null;
window.addEventListener('DOMContentLoaded',()=>{
  const target=document.getElementById('divider');
  ipcRenderer.on('neko-divider-reset',()=>{active=false;lastClick=0;if(pointerId!==null){try{target.releasePointerCapture(pointerId);}catch{}pointerId=null;}});
  target.addEventListener('pointerdown',e=>{if(e.button!==0)return;const now=Date.now();if(now-lastClick<450&&Math.abs(e.screenX-lastX)<6){lastClick=0;ipcRenderer.send('neko-divider-input',{type:'reset'});e.preventDefault();return;}active=true;downX=e.screenX;moved=false;token++;pointerId=e.pointerId;target.setPointerCapture(e.pointerId);ipcRenderer.send('neko-divider-input',{type:'start',token});e.preventDefault();});
  target.addEventListener('pointermove',e=>{if(active&&(e.buttons&1)){if(Math.abs(e.screenX-downX)>4)moved=true;ipcRenderer.send('neko-divider-input',{type:'move',x:e.screenX,token});}});
  const end=e=>{if(!active)return;active=false;pointerId=null;const click=e.type==='pointerup'&&Math.abs(e.screenX-downX)<5;if(click){lastClick=Date.now();lastX=downX;}else lastClick=0;ipcRenderer.send('neko-divider-input',{type:click||e.type==='pointerup'?'end':'cancel',x:click?downX:e.screenX,click,token});};
  target.addEventListener('pointerup',end);target.addEventListener('pointercancel',end);target.addEventListener('mouseup',e=>end({type:'pointerup',screenX:e.screenX}));
  target.addEventListener('keydown',e=>{if(e.key==='Escape'&&active){active=false;ipcRenderer.send('neko-divider-input',{type:'cancel',token});e.preventDefault();}else if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){ipcRenderer.send('neko-divider-input',{type:'key',key:e.key,shift:e.shiftKey});e.preventDefault();}});
});
