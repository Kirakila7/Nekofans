'use strict';
// Local, sandboxed divider surface. It receives no workbench data or arbitrary IPC.
const {ipcRenderer}=require('electron');
let active=false,token=0,lastClick=0,lastPosition=0,downPosition=0,pointerId=null,orientation='vertical';
window.addEventListener('DOMContentLoaded',()=>{
  const target=document.getElementById('divider');
  const axis=()=>orientation==='horizontal'?'y':'x';
  const position=e=>orientation==='horizontal'?e.screenY:e.screenX;
  const release=()=>{if(pointerId!==null){try{target.releasePointerCapture(pointerId);}catch{}pointerId=null;}};
  ipcRenderer.on('neko-divider-reset',()=>{active=false;lastClick=0;release();});
  ipcRenderer.on('neko-divider-orientation',(_event,value)=>{if(!['horizontal','vertical'].includes(value))return;orientation=value;lastClick=0;document.documentElement.dataset.orientation=value;});
  target.addEventListener('pointerdown',e=>{if(e.button!==0)return;const now=Date.now(),point=position(e);if(now-lastClick<450&&Math.abs(point-lastPosition)<6){lastClick=0;ipcRenderer.send('neko-divider-input',{type:'reset'});e.preventDefault();return;}active=true;downPosition=point;token++;pointerId=e.pointerId;target.setPointerCapture(e.pointerId);ipcRenderer.send('neko-divider-input',{type:'start',token});e.preventDefault();});
  target.addEventListener('pointermove',e=>{if(active&&(e.buttons&1))ipcRenderer.send('neko-divider-input',{type:'move',[axis()]:position(e),token});});
  const end=e=>{if(!active)return;active=false;pointerId=null;const point=position(e),click=e.type==='pointerup'&&Math.abs(point-downPosition)<5;if(click){lastClick=Date.now();lastPosition=downPosition;}else lastClick=0;ipcRenderer.send('neko-divider-input',{type:e.type==='pointerup'?'end':'cancel',[axis()]:click?downPosition:point,click,token});};
  target.addEventListener('pointerup',end);target.addEventListener('pointercancel',end);target.addEventListener('mouseup',e=>end({type:'pointerup',screenX:e.screenX,screenY:e.screenY}));
  target.addEventListener('keydown',e=>{if(e.key==='Escape'&&active){active=false;release();ipcRenderer.send('neko-divider-input',{type:'cancel',token});e.preventDefault();}else if((orientation==='horizontal'?['ArrowUp','ArrowDown','Home','End']:['ArrowLeft','ArrowRight','Home','End']).includes(e.key)){ipcRenderer.send('neko-divider-input',{type:'key',key:e.key,shift:e.shiftKey});e.preventDefault();}});
});
