'use strict';

const MENU_SHADOW_DIP=6;
const MENU_KEYS=new Set(['x','y','width','height']);
function menuRectangle(value){
 if(value===null)return null;
 if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).length!==4
  ||Reflect.ownKeys(value).some(key=>!MENU_KEYS.has(key))
  ||!['x','y','width','height'].every(key=>Number.isFinite(value[key])&&Math.abs(value[key])<100000)
  ||value.width<=0||value.height<=0)throw new TypeError('Invalid account menu rectangle');
 return {x:value.x,y:value.y,width:value.width,height:value.height};
}
const rectangle=value=>!!value&&['x','y','width','height'].every(key=>Number.isFinite(value[key]))&&value.width>0&&value.height>0;
const alive=window=>!!window&&window.isDestroyed?.()!==true;

// The account menu stays in its trusted owner renderer. A shaped desktop float
// leaves only its intersecting pixels/click region to the menu underneath.
function createFloatingMenuLayer({getWindow,getOwner,canShow,showWindow,platform=process.platform}={}){
 if(![getWindow,getOwner,canShow,showWindow].every(value=>typeof value==='function'))throw new TypeError('Floating menu layer callbacks are required');
 let menu=null,current=null,disposed=false,blocked=false,hiddenByLayer=false;
 let shapeKey=null,shapeResult=false,shapeFailed=false;
 const nativeShape=window=>['win32','linux'].includes(platform)&&typeof window?.setShape==='function';
 const permitted=()=>{try{return canShow()===true;}catch{return false;}};
 function applyShape(window,rectangles){
  if(!alive(window)||!nativeShape(window))return false;
  const key=JSON.stringify(rectangles);if(shapeKey===key)return shapeResult;
  shapeKey=key;
  try{window.setShape(rectangles);shapeResult=true;return true;}
  catch{shapeResult=false;shapeFailed=true;return false;}
 }
 function replaceWindow(window){
  if(current===window)return;
  if(alive(current))applyShape(current,[]);
  current=window;shapeKey=null;shapeResult=false;shapeFailed=false;
  blocked=false;hiddenByLayer=false;
 }
 function hideBlocked(window){
  blocked=true;
  // A window already hidden by its owner is never claimed by this helper.
  if(window.isVisible?.()!==false&&typeof window.hide==='function'){
   try{window.hide();hiddenByLayer=true;}catch{}
  }
  return false;
 }
 function reveal(window){
  blocked=false;
  if(!permitted())return false;
  if(hiddenByLayer){
   hiddenByLayer=false;
   try{Promise.resolve(showWindow(window)).catch(()=>{});}
   catch{hiddenByLayer=true;return false;}
  }
  return true;
 }
 function refresh(){
  if(disposed)return false;
  let window;try{window=getWindow();}catch{window=null;}
  if(!alive(window))window=null;
  replaceWindow(window);if(!window)return false;
  if(menu===null){if(nativeShape(window))applyShape(window,[]);return reveal(window);}
  let bounds,origin,zoom;
  try{
   const owner=getOwner();if(!alive(owner))return hideBlocked(window);
   bounds=window.getBounds();origin=owner.getContentBounds();zoom=owner.webContents?.getZoomFactor?.()??1;
   if(!rectangle(bounds)||!rectangle(origin)||!Number.isFinite(zoom)||zoom<=0)return hideBlocked(window);
  }catch{return hideBlocked(window);}
  // CSS -> screen DIP exactly once; shadow padding is already in DIP.
  const left=Math.max(0,Math.floor(origin.x+menu.x*zoom-MENU_SHADOW_DIP-bounds.x));
  const top=Math.max(0,Math.floor(origin.y+menu.y*zoom-MENU_SHADOW_DIP-bounds.y));
  const right=Math.min(bounds.width,Math.ceil(origin.x+(menu.x+menu.width)*zoom+MENU_SHADOW_DIP-bounds.x));
  const bottom=Math.min(bounds.height,Math.ceil(origin.y+(menu.y+menu.height)*zoom+MENU_SHADOW_DIP-bounds.y));
  if(right<=left||bottom<=top){if(nativeShape(window))applyShape(window,[]);return reveal(window);}
  if(left===0&&top===0&&right===bounds.width&&bottom===bounds.height)return hideBlocked(window);
  if(!nativeShape(window)||shapeFailed)return hideBlocked(window);
  const regions=[
   {x:0,y:0,width:bounds.width,height:top},
   {x:0,y:bottom,width:bounds.width,height:bounds.height-bottom},
   {x:0,y:top,width:left,height:bottom-top},
   {x:right,y:top,width:bounds.width-right,height:bottom-top},
  ].filter(rect=>rect.width>0&&rect.height>0);
  if(!applyShape(window,regions)){
   // A failing implementation may have retained an earlier partial region.
   applyShape(window,[]);return hideBlocked(window);
  }
  return reveal(window);
 }
 function setMenuRect(value){const next=menuRectangle(value);if(disposed)return false;menu=next;return refresh();}
 function dispose(){
  if(disposed)return;disposed=true;
  if(alive(current)&&nativeShape(current))applyShape(current,[]);
  current=null;menu=null;blocked=false;hiddenByLayer=false;
 }
 return Object.freeze({setMenuRect,refresh,isBlocked:()=>blocked,dispose});
}
module.exports={createFloatingMenuLayer};
