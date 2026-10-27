(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PetAppearance=api;})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  const ORIGINAL='dsh-original',CAT='neko-cat',CLAUDE='claude-girl',GEMINI='gemini-cat',CLAUDE_PIXEL='claude-pixel',GEMINI_PIXEL='gemini-pixel',CUSTOM='custom';
  const MAX_CUSTOM_BYTES=4*1024*1024;
  // Common visible bounds across all upstream frames; clip only transparent
  // margins while keeping each animation on the same scale and ground line.
  const pixelFrames=Object.freeze({[CLAUDE_PIXEL]:Object.freeze({x:43,y:35,width:170,height:187,tops:Object.freeze({idle:57,think:62,search:66,read:98,type:81,check:52,success:35,failed:61,'walk-left':57})}),[GEMINI_PIXEL]:Object.freeze({x:48,y:57,width:164,height:165,tops:Object.freeze({idle:62,think:61,search:61,read:97,type:81,check:57,success:58,failed:59,'walk-left':63})})});
  const choices=Object.freeze([{id:ORIGINAL,label:'大肥鱼 · 原有角色'},{id:CAT,label:'N.E.K.O. 跑动小猫'},{id:CLAUDE,label:'Claude 娘'},{id:GEMINI,label:'Gemini 小猫'},{id:CLAUDE_PIXEL,label:'Claude 娘 · 像素 Q 版'},{id:GEMINI_PIXEL,label:'Gemini 小猫 · 像素 Q 版'}].map(Object.freeze));
  const normalizeId=id=>({'crosspet-claude':CLAUDE,'crosspet-gemini':GEMINI})[id]||id;
  const valid=id=>choices.some(choice=>choice.id===normalizeId(id));
  const kind=actor=>actor?.id==='main'?'main':actor?.kind==='task'?'task':'subagent';
  const preferenceKey=tier=>({main:'mainAppearance',task:'taskAppearance',subagent:'subagentAppearance'})[tier]||null;
  function normalizePreferences(preferences={}){
    const next={...preferences};for(const tier of ['main','task','subagent']){const key=preferenceKey(tier);next[key]=valid(next[key])?normalizeId(next[key]):ORIGINAL;}return next;
  }
  function validImageDataUrl(value){
    const url=value?.dataUrl;if(typeof url!=='string'||url.length>Math.ceil(MAX_CUSTOM_BYTES/3)*4+40)return false;
    const match=/^data:image\/(png|gif|webp|jpeg);base64,/.exec(url);if(!match)return false;
    const body=url.slice(match[0].length);if(!body||body.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(body)||body.length/4*3-(body.endsWith('==')?2:body.endsWith('=')?1:0)>MAX_CUSTOM_BYTES)return false;
    let header;try{header=atob(body.slice(0,Math.min(64,body.length)));}catch{return false;}
    return match[1]==='png'?header.startsWith('\x89PNG\r\n\x1a\n'):match[1]==='gif'?/^GIF8[79]a/.test(header):match[1]==='webp'?header.startsWith('RIFF')&&header.slice(8,12)==='WEBP':header.startsWith('\xff\xd8\xff');
  }
  function validCustom(value){return value?.animated===true&&Number.isInteger(value.frameCount)&&value.frameCount>1&&value.frameCount<=10000&&/^data:image\/(gif|webp);base64,/.test(value.dataUrl||'')&&validImageDataUrl(value);}
  function explicit(actor){return valid(actor?.appearanceId)||(actor?.appearanceId===CUSTOM&&validCustom(actor.customAppearance));}
  function selected(state,actor){if(explicit(actor))return normalizeId(actor.appearanceId);const key=preferenceKey(kind(actor));return valid(state?.preferences?.[key])?normalizeId(state.preferences[key]):ORIGINAL;}
  function setDefault(state,tier,id){const key=preferenceKey(tier);if(!key||!valid(id))return false;state.preferences=normalizePreferences(state.preferences);state.preferences[key]=id;return true;}
  function setActor(actor,id){if(!actor||(id!==null&&!valid(id)&&!(id===CUSTOM&&validCustom(actor.customAppearance))))return false;if(id===null)delete actor.appearanceId;else actor.appearanceId=normalizeId(id);return true;}
  function setCustom(actor,value){if(!actor||!validCustom(value))return false;actor.customAppearance={name:String(value.name||'我的形象').replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,48)||'我的形象',dataUrl:value.dataUrl,animated:true,frameCount:value.frameCount};if(value.stillDataUrl?.startsWith('data:image/png;base64,')&&validImageDataUrl({dataUrl:value.stillDataUrl}))actor.customAppearance.stillDataUrl=value.stillDataUrl;actor.appearanceId=CUSTOM;return true;}
  function scaleFor(state,actor){return Number.isFinite(actor?.appearanceScale)&&actor.appearanceScale>=.4&&actor.appearanceScale<=1?actor.appearanceScale:selected(state,actor)===CAT?.65:1;}
  function setScale(actor,value){if(!actor)return false;if(value===null){delete actor.appearanceScale;return true;}if(!Number.isFinite(value)||value<.4||value>1)return false;actor.appearanceScale=value;return true;}
  function frameAspect(state,actor){const id=selected(state,actor),frame=pixelFrames[id];return frame?frame.width/frame.height:id===ORIGINAL?16/9:id===CLAUDE||id===GEMINI?192/208:1;}
  function insetFor(id,actor,{dragging=false,reduced=false,failed=false}={}){const frame=pixelFrames[id],clip=reduced||failed?'idle':pixelPose(actor,dragging);return frame?(frame.tops[clip]-frame.y)/frame.height:0;}
  function headInset(state,actor,options){return insetFor(selected(state,actor),actor,options);}
  function layoutOptions(state,actor){return {compact:true,scale:scaleFor(state,actor),aspect:frameAspect(state,actor)};}
  const base='assets/neko-cat/';
  const assets=Object.freeze({idle:base+'cat-idle-cat4-3.gif',running:base+'cat-idle-cat4-1.gif',success:base+'cat-idle-cat4-2.gif',drag:base+'cat-idle-cat-move-3.gif',still:base+'still.png'});
  function phase(actor,dragging=false){if(dragging)return 'drag';if(actor?.active||['working','stopping'].includes(actor?.status))return 'running';return actor?.work?.state==='success'?'success':'idle';}
  function pose(actor,dragging){if(dragging)return 'waving';if(actor?.status==='error'||actor?.work?.state==='error')return 'failed';if(actor?.status==='stopping'||actor?.work?.state==='waiting')return 'waiting';if(actor?.work?.state==='thinking')return 'review';if(actor?.work?.state==='success'||actor?.status==='success')return 'jumping';return actor?.active||actor?.status==='working'?'running':'idle';}
  function pixelPose(actor,dragging){
    if(dragging)return 'walk-left';
    const state=actor?.work?.state;
    if(actor?.status==='error'||state==='error')return 'failed';
    if(actor?.status==='stopping'||state==='waiting')return 'read';
    if(state==='success'||actor?.status==='success')return 'success';
    if(state==='thinking')return 'think';
    if(state==='result')return 'check';
    return actor?.active||actor?.status==='working'?'type':'idle';
  }
  function sourceFor(id,actor,{dragging=false,reduced=false,failed=false}={}){
    if(id===CAT)return reduced||failed?assets.still:assets[phase(actor,dragging)];
    if(id===CUSTOM){const value=actor?.customAppearance;if((reduced||failed)&&value?.stillDataUrl?.startsWith('data:image/png;base64,')&&validImageDataUrl({dataUrl:value.stillDataUrl}))return value.stillDataUrl;if(failed||reduced&&/^data:image\/(gif|webp);/.test(value?.dataUrl||''))return assets.still;return validCustom(value)?value.dataUrl:assets.still;}
    if(id===CLAUDE_PIXEL||id===GEMINI_PIXEL){const folder=id===CLAUDE_PIXEL?'claude':'gemini';return `assets/pixel-ai-girls/${folder}/${reduced||failed?'still.png':pixelPose(actor,dragging)+'.webp'}`;}
    if(id===CLAUDE||id===GEMINI){const folder=id===CLAUDE?'claude':'gemini',action=pose(actor,dragging);
      // The upstream idle/jumping/failed rows are visibly flattened. Use the
      // same character's upright animated rows, without stretching its pixels.
      const clip=id===CLAUDE?({idle:'review',jumping:'waving',failed:'waiting'}[action]||action):action;
      return `assets/ai-girls/${folder}/${reduced||failed?'still.png':clip+'.webp'}`;}
    return null;
  }
  // Replace only media; keep real task routing, work feedback and chat bubbles.
  function install({character,videos,feedback,document,matchMedia=()=>null,onHeadInset=()=>{}}){
    const motion=document.createElement('span'),image=document.createElement('img');
    motion.className='pet-cat-motion';motion.hidden=true;motion.setAttribute('aria-hidden','true');image.className='pet-cat';image.alt='';image.draggable=false;motion.appendChild(image);character.appendChild(motion);
    const media=matchMedia('(prefers-reduced-motion: reduce)'),original=feedback.switchTo;
    let current=ORIGINAL,currentCustom=null,actor=null,disposed=false,failed=false,lastSource='';
    function renderMedia(){
      if(disposed||current===ORIGINAL)return;
      const source=sourceFor(current,actor,{dragging:feedback.dragState.active,reduced:!!media?.matches,failed});
      onHeadInset(insetFor(current,actor,{dragging:feedback.dragState.active,reduced:!!media?.matches,failed}));
      motion.dataset.phase=current===CAT?phase(actor,feedback.dragState.active):'pose';motion.dataset.reduced=String(!!media?.matches);
      if(source!==lastSource){lastSource=source;image.src=source;}
    }
    function fenceVideos(){feedback.pending={gen:++feedback.gen,appearance:current};for(const video of videos){video.onended=null;video.pause();video.removeAttribute('src');video.load();video.classList.remove('is-front');}}
    const wrapped=function(next,once){if(current===ORIGINAL)return original.call(feedback,next,once);feedback.anim=next;feedback.once=once;renderMedia();};feedback.switchTo=wrapped;
    function render(state,nextActor){
      if(disposed)return;actor=nextActor;const next=selected(state,actor),custom=next===CUSTOM?actor?.customAppearance?.dataUrl:null;
      if(next!==current||custom!==currentCustom){
        const wasOriginal=current===ORIGINAL;current=next;currentCustom=custom;failed=false;lastSource='';character.dataset.appearance=next;motion.hidden=next===ORIGINAL;
        for(const video of videos)video.hidden=next!==ORIGINAL;
        if(next!==ORIGINAL){if(wasOriginal)fenceVideos();}
        else{image.removeAttribute('src');feedback.pending={gen:++feedback.gen};if(!feedback.resumeWorkStatusAnim())feedback.playIdle();}
      }
      renderMedia();
    }
    const onMotion=()=>renderMedia();media?.addEventListener?.('change',onMotion);
    image.onerror=()=>{if(current!==ORIGINAL&&!failed){failed=true;renderMedia();}};
    return Object.freeze({render,isCat:()=>current===CAT,isMedia:()=>current!==ORIGINAL,dispose(){if(disposed)return;disposed=true;media?.removeEventListener?.('change',onMotion);image.onerror=null;image.removeAttribute('src');motion.remove();if(feedback.switchTo===wrapped)feedback.switchTo=original;}});
  }
  return Object.freeze({ORIGINAL,CAT,CLAUDE,GEMINI,CLAUDE_PIXEL,GEMINI_PIXEL,CUSTOM,MAX_CUSTOM_BYTES,choices,valid,normalizeId,validImageDataUrl,validCustom,explicit,kind,preferenceKey,normalizePreferences,selected,setDefault,setActor,setCustom,scaleFor,setScale,frameAspect,headInset,pixelFrames,layoutOptions,phase,pose,pixelPose,sourceFor,assets,install});
});
