'use strict';
(()=>{
 const api=window.videoFloat,button=document.getElementById('expand'),close=document.getElementById('close'),closing=new URLSearchParams(location.search).get('control')==='close';let state={};
 button.hidden=closing;close.hidden=!closing;
 const run=request=>Promise.resolve(api.action(request)).catch(()=>{document.getElementById('status').textContent='操作未完成，请重试';});
 function paint(next){state=next||{};button.setAttribute('aria-label',state.expanded?'收起视频浮窗':'展开视频浮窗');button.setAttribute('aria-expanded',String(!!state.expanded));document.getElementById('expand-shape').setAttribute('d',state.expanded?'M20 10h-6V4M14 10l7-7M4 14h6v6M10 14l-7 7':'M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7');}
 button.addEventListener('click',()=>void run({action:'toggle-expanded'}));close.addEventListener('click',()=>void run({action:'close'}));
 window.installNekoHoldDrag?.(document,delta=>void run({action:'move',...delta}));
 api.subscribe(paint);void api.action({action:'state'}).then(paint).catch(()=>{});
})();
