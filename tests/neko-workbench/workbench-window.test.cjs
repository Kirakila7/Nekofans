'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {workbenchWindowOptions,updateWorkbenchWindowTheme}=require('../../apps/neko-workbench/workbench-window.cjs');

test('Windows startup fits the selected display work area at any DPI and keeps native captions',()=>{
  for(const area of [{x:0,y:0,width:1366,height:728},{x:1536,y:-200,width:1280,height:680},{x:-1920,y:0,width:720,height:480}]){
    const r=workbenchWindowOptions('win32',area);
    assert(r.x>=area.x&&r.y>=area.y);assert(r.x+r.width<=area.x+area.width);assert(r.y+r.height<=area.y+area.height);
    assert(r.minWidth<=r.width&&r.minHeight<=r.height);assert.equal(r.frame,true);assert.equal(r.autoHideMenuBar,true);
    assert.equal(r.titleBarStyle,'hidden');assert.equal(r.titleBarOverlay.height,36);
  }
  assert.deepEqual(workbenchWindowOptions('darwin',{x:0,y:0,width:640,height:480}),{width:1100,height:780,minWidth:800,minHeight:560});
});

test('caption theme accepts only a boolean and leaves native controls in place',()=>{
  assert.throws(()=>updateWorkbenchWindowTheme(null,'dark'),TypeError);
  let overlay;const host={isDestroyed:()=>false,setTitleBarOverlay:value=>{overlay=value;}};
  updateWorkbenchWindowTheme(host,true);
  if(process.platform==='win32'){assert.equal(overlay.symbolColor,'#dce8f3');assert.equal(overlay.height,36);}
});
