'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createFloatingMenuLayer}=require('../../apps/neko-workbench/floating-menu-layer.cjs');

function fixture({platform='win32',bounds={x:100,y:100,width:100,height:80},origin={x:100,y:100,width:1000,height:700},zoom=1,visible=true,shape=true,shapeError=false}={}){
 const shapes=[],hides=[],shows=[];let eligible=true,current,zoomReads=0;
 const owner={isDestroyed:()=>false,getContentBounds:()=>({...origin}),getBounds:()=>{throw Error('outer bounds must not replace the content origin');},webContents:{getZoomFactor:()=>{zoomReads++;return zoom;}}};
 const makeWindow=(rect=bounds)=>{
  const window={bounds:{...rect},visible,destroyed:false,isDestroyed(){return this.destroyed;},isVisible(){return this.visible;},getBounds(){return {...this.bounds};},
   hide(){this.visible=false;hides.push(this);},setBounds(){throw Error('menu layering must not change geometry');},focus(){throw Error('menu layering must not steal focus');}};
  if(shape)window.setShape=regions=>{shapes.push({window,regions:structuredClone(regions)});if(shapeError&&regions.length)throw Error('native shape unsupported');};
  return window;
 };
 current=makeWindow();
 const layer=createFloatingMenuLayer({getWindow:()=>current,getOwner:()=>owner,canShow:()=>eligible,
  showWindow:window=>{window.visible=true;shows.push(window);},platform});
 return {layer,owner,shapes,hides,shows,get window(){return current;},makeWindow,
  replace:window=>{current=window;},setEligible:value=>{eligible=value;},get zoomReads(){return zoomReads;}};
}
const menu={x:20,y:20,width:20,height:20};
function checkRegionCoverage(regions,{width,height},hole){
 assert(regions.length>0&&regions.length<=4);
 for(const region of regions){
  assert(['x','y','width','height'].every(key=>Number.isInteger(region[key])));
  assert(region.x>=0&&region.y>=0&&region.width>0&&region.height>0);
  assert(region.x+region.width<=width&&region.y+region.height<=height);
 }
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const count=regions.filter(r=>x>=r.x&&x<r.x+r.width&&y>=r.y&&y<r.y+r.height).length;
  const covered=x>=hole.left&&x<hole.right&&y>=hole.top&&y<hole.bottom;
  assert.equal(count,covered?0:1,'every retained pixel belongs to exactly one native click/visible region');
 }
}

test('Windows partial intersection keeps all other pixels clickable using at most four disjoint local regions',()=>{
 const f=fixture();assert.equal(f.layer.setMenuRect(menu),true);assert.equal(f.layer.isBlocked(),false);assert.equal(f.window.visible,true);assert.equal(f.hides.length,0);
 const regions=f.shapes.at(-1).regions;
 assert.deepEqual(regions,[{x:0,y:0,width:100,height:14},{x:0,y:46,width:100,height:34},{x:0,y:14,width:14,height:32},{x:46,y:14,width:54,height:32}]);
 checkRegionCoverage(regions,{width:100,height:80},{left:14,top:14,right:46,bottom:46});
 assert.deepEqual(f.window.getBounds(),{x:100,y:100,width:100,height:80});
 f.layer.dispose();
});

test('CSS zoom is applied once to menu coordinates, then 6 DIP padding rounds the hole outward',()=>{
 const f=fixture({bounds:{x:-1800,y:160,width:300,height:240},origin:{x:-1920,y:120,width:1200,height:900},zoom:1.5});
 f.layer.setMenuRect({x:100,y:40,width:80,height:80});
 assert.equal(f.zoomReads,1);assert.deepEqual(f.shapes.at(-1).regions,[
  {x:0,y:0,width:300,height:14},{x:0,y:146,width:300,height:94},{x:0,y:14,width:24,height:132},{x:156,y:14,width:144,height:132},
 ]);
 const g=fixture({bounds:{x:100,y:80,width:200,height:160},origin:{x:100,y:80,width:1000,height:700},zoom:1.25});
 g.layer.setMenuRect({x:20.4,y:10.2,width:25.2,height:20.2});
 checkRegionCoverage(g.shapes.at(-1).regions,{width:200,height:160},{left:19,top:6,right:63,bottom:44});
 f.layer.dispose();g.layer.dispose();
});

test('edge intersections clip regions to the floating window and do not leave an invisible clickable hole',()=>{
 const f=fixture();f.layer.setMenuRect({x:-20,y:10,width:40,height:20});
 checkRegionCoverage(f.shapes.at(-1).regions,{width:100,height:80},{left:0,top:4,right:26,bottom:36});
 assert.equal(f.layer.isBlocked(),false);f.layer.dispose();
});

test('full coverage hides instead of using an empty shape, then a partial overlap restores only the helper-hidden window',()=>{
 const f=fixture();assert.equal(f.layer.setMenuRect({x:-10,y:-10,width:120,height:100}),false);
 assert.equal(f.layer.isBlocked(),true);assert.equal(f.window.visible,false);assert.equal(f.hides.length,1);
 assert.equal(f.shapes.length,0,'setShape([]) restores a window and cannot represent full occlusion');
 f.layer.refresh();assert.equal(f.hides.length,1);
 assert.equal(f.layer.setMenuRect(menu),true);assert.equal(f.layer.isBlocked(),false);assert.equal(f.window.visible,true);assert.equal(f.shows.length,1);
 f.layer.setMenuRect(null);assert.deepEqual(f.shapes.at(-1).regions,[]);assert.equal(f.shows.length,1);f.layer.dispose();
});

test('no intersection and a closed menu restore native shape, with identical shapes cached',()=>{
 const f=fixture();f.layer.setMenuRect(menu);const first=f.shapes.length;
 f.layer.refresh();f.layer.setMenuRect({...menu});assert.equal(f.shapes.length,first);
 f.layer.setMenuRect({x:500,y:500,width:40,height:50});assert.deepEqual(f.shapes.at(-1).regions,[]);
 const restored=f.shapes.length;f.layer.refresh();f.layer.setMenuRect(null);assert.equal(f.shapes.length,restored);assert.equal(f.hides.length,0);
 f.layer.dispose();assert.equal(f.shapes.length,restored);
});

test('a shared menu rectangle is copied; subsequent window movement recomputes the intersection without changing bounds',()=>{
 const f=fixture(),input={...menu};f.layer.setMenuRect(input);const first=structuredClone(f.shapes.at(-1).regions);input.x=999;f.layer.refresh();assert.deepEqual(f.shapes.at(-1).regions,first);
 f.window.bounds.x=120;f.layer.refresh();assert.notDeepEqual(f.shapes.at(-1).regions,first);assert.equal(f.window.bounds.x,120);
 f.window.bounds.x=900;f.layer.refresh();assert.deepEqual(f.shapes.at(-1).regions,[]);f.layer.dispose();
});

test('macOS and platforms without native shape hide only during overlap and restore without geometry/focus changes',()=>{
 for(const options of [{platform:'darwin'},{shape:false},{platform:'freebsd'}]){
  const f=fixture(options);f.layer.setMenuRect({x:500,y:500,width:20,height:20});assert.equal(f.hides.length,0);
  f.layer.setMenuRect(menu);assert.equal(f.layer.isBlocked(),true);assert.equal(f.window.visible,false);assert.equal(f.shapes.length,0);
  assert.equal(f.layer.setMenuRect(null),true);assert.equal(f.window.visible,true);assert.equal(f.shows.length,1);assert.deepEqual(f.window.getBounds(),{x:100,y:100,width:100,height:80});f.layer.dispose();
 }
});

test('Linux native shape retains partial floats just like Windows',()=>{
 const f=fixture({platform:'linux'});f.layer.setMenuRect(menu);assert.equal(f.layer.isBlocked(),false);assert.equal(f.hides.length,0);assert.equal(f.shapes.at(-1).regions.length,4);f.layer.dispose();
});

test('a native shape error falls back to overlap hiding and repeated refreshes do not repeat failing shape calls',()=>{
 const f=fixture({shapeError:true});assert.doesNotThrow(()=>assert.equal(f.layer.setMenuRect(menu),false));
 assert.equal(f.layer.isBlocked(),true);assert.equal(f.window.visible,false);assert.deepEqual(f.shapes.at(-1).regions,[]);
 const count=f.shapes.length;f.layer.refresh();f.layer.setMenuRect({...menu,x:25});assert.equal(f.shapes.length,count);
 f.layer.setMenuRect(null);assert.equal(f.layer.isBlocked(),false);assert.equal(f.window.visible,true);assert.equal(f.shows.length,1);f.layer.dispose();
});

test('owner/office visibility gates prevent restoring a helper-hidden window until it is eligible again',()=>{
 const f=fixture({platform:'darwin'});f.layer.setMenuRect(menu);f.setEligible(false);
 assert.equal(f.layer.setMenuRect(null),false);assert.equal(f.layer.isBlocked(),false);assert.equal(f.window.visible,false);assert.equal(f.shows.length,0);
 f.setEligible(true);assert.equal(f.layer.refresh(),true);assert.equal(f.window.visible,true);assert.equal(f.shows.length,1);f.layer.refresh();assert.equal(f.shows.length,1);f.layer.dispose();
});

test('a window already hidden by its owner is never restored merely because the account menu closes',()=>{
 const f=fixture({platform:'darwin',visible:false});f.layer.setMenuRect(menu);assert.equal(f.layer.isBlocked(),true);assert.equal(f.hides.length,0);
 f.layer.setMenuRect(null);assert.equal(f.window.visible,false);assert.equal(f.shows.length,0);f.layer.dispose();
});

test('replacing the native window resets shape/cache/hidden ownership while preserving the shared menu geometry',()=>{
 const f=fixture();f.layer.setMenuRect(menu);const old=f.window,newWindow=f.makeWindow();f.replace(newWindow);f.layer.refresh();
 assert.deepEqual(f.shapes.filter(x=>x.window===old).at(-1).regions,[]);assert.equal(f.shapes.filter(x=>x.window===newWindow).length,1);assert.equal(f.layer.isBlocked(),false);
 f.layer.setMenuRect({x:-10,y:-10,width:120,height:100});assert.equal(newWindow.visible,false);f.replace(null);assert.equal(f.layer.refresh(),false);assert.equal(f.layer.isBlocked(),false);assert.equal(f.shows.length,0);f.layer.dispose();
});

test('disposal clears a native region but never restores a window or revives later menu messages',()=>{
 const f=fixture();f.layer.setMenuRect(menu);f.layer.setMenuRect({x:-10,y:-10,width:120,height:100});assert.equal(f.window.visible,false);
 f.layer.dispose();assert.deepEqual(f.shapes.at(-1).regions,[]);assert.equal(f.window.visible,false);assert.equal(f.shows.length,0);assert.equal(f.layer.isBlocked(),false);
 const count=f.shapes.length;assert.equal(f.layer.refresh(),false);assert.equal(f.layer.setMenuRect(null),false);assert.equal(f.shapes.length,count);
});

test('invalid or ambiguous CSS rectangles reject before any native side effect and leave the previous geometry intact',()=>{
 const f=fixture();f.layer.setMenuRect(menu);const first=structuredClone(f.shapes.at(-1).regions),count=f.shapes.length;
 for(const value of [undefined,{},[],{...menu,extra:1},{...menu,width:0},{...menu,height:-1},{...menu,x:Infinity},{...menu,y:NaN},{...menu,x:100000},{...menu,width:100000},{...menu,x:'20'},Object.assign({...menu},{[Symbol('extra')]:true})]){
  assert.throws(()=>f.layer.setMenuRect(value),TypeError);
 }
 assert.equal(f.shapes.length,count);assert.deepEqual(f.shapes.at(-1).regions,first);assert.equal(f.window.visible,true);f.layer.dispose();
});

test('unavailable window/owner and throwing callbacks are contained without falsely restoring inactive floats',()=>{
 const f=fixture();f.replace(null);assert.equal(f.layer.setMenuRect(menu),false);assert.equal(f.layer.isBlocked(),false);f.layer.dispose();
 const window={isDestroyed:()=>false,isVisible:()=>true,getBounds:()=>({x:0,y:0,width:100,height:80}),hide(){this.hidden=true;},setShape(){}};
 const layer=createFloatingMenuLayer({getWindow:()=>window,getOwner:()=>null,canShow:()=>false,showWindow:()=>{throw Error('must not restore');}});
 assert.equal(layer.setMenuRect(menu),false);assert.equal(layer.isBlocked(),true);assert.equal(window.hidden,true);assert.equal(layer.setMenuRect(null),false);layer.dispose();
});
