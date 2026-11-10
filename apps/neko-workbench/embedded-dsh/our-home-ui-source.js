// The room, first-person camera and agent observation share one saved scene.
async function mountOurHome(stage,options={}){
 const doc=stage.ownerDocument,win=options.window||doc.defaultView,bridge=options.bridge||win.nekoWorkbench;
 if(typeof bridge?.home!=='function')throw Error('小窝连接暂不可用');
 const el=(tag,cls,text)=>{const n=doc.createElement(tag);n.className=cls||'';if(text!==undefined)n.textContent=text;return n;};
 const root=el('section','neko-our-home'),canvas=el('canvas','neko-our-home__canvas');root.dataset.environment='ocean';canvas.tabIndex=0;canvas.setAttribute('aria-label','浮在海面上的小窝木平台');
 const top=el('div','neko-our-home__top'),invite=el('button','neko-our-home__invite','共建我们的家！');invite.type='button';invite.title='打开共建会话';
 const controls=el('div','neko-our-home__controls');
 const icons={orbit:'<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="M3 8v9l9 5 9-5V8M12 13v9"/>',first:'<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',free:'<ellipse cx="6" cy="7" rx="2" ry="3" transform="rotate(-25 6 7)"/><ellipse cx="18" cy="7" rx="2" ry="3" transform="rotate(25 18 7)"/><ellipse cx="10" cy="4" rx="1.8" ry="2.7"/><ellipse cx="14" cy="4" rx="1.8" ry="2.7"/><path d="M5 17c0-3 3-6 7-6s7 3 7 6-3 4-7 2c-4 2-7 1-7-2Z"/>'};
 function button(label,icon,fn){const b=el('button');b.type='button';b.title=label;b.setAttribute('aria-label',label);b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+icons[icon]+'</svg>';b.addEventListener('click',fn);controls.append(b);return b;}
 const orbit=button('小窝全景','orbit',()=>void command({action:'perspective',mode:'orbit'}));
 const first=button('大肥鱼第一视角','first',async()=>{if(!state?.avatar?.atHome&&!await command({action:'return-home'}))return;await command({action:'perspective',mode:'agent'});});
 let freely=true;const free=button('自由活动：开','free',()=>{freely=!freely;petMotion.setEnabled(freely);free.title='自由活动：'+(freely?'开':'关');free.setAttribute('aria-label',free.title);free.setAttribute('aria-pressed',String(freely));});free.setAttribute('aria-pressed','true');
 const status=el('p','neko-our-home__status');status.setAttribute('role','status');
 const heading=el('div','neko-our-home__heading'),value=el('div','neko-our-home__value','价值：— Token'),inventory=el('p','neko-our-home__inventory');value.setAttribute('aria-label','小窝累计建造 Token');heading.append(value,invite);top.append(heading,controls);
 const helper=el('img','neko-our-home__task-avatar');helper.alt='小窝工作会话正在建造';helper.hidden=true;root.append(canvas,top,status,inventory,helper);stage.append(root);
 let state=null,disposed=false,drag=null,w=1,h=1,azimuth=42,elevation=34,zoom=1,lookYaw=0,lookPitch=-10,pendingLook=null,lookTimer=null;
 const waterLevel=-.11,motion=win.matchMedia?.('(prefers-reduced-motion: reduce)');let seaTime=0,platformLift=0,frame=null,lastFrame=0,onScreen=true;
 const radians=d=>d*Math.PI/180,clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
 const dot=(a,b)=>a.reduce((sum,n,i)=>sum+n*b[i],0),sub=(a,b)=>a.map((n,i)=>n-b[i]);
 const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
 const normal=a=>{const l=Math.hypot(...a)||1;return a.map(n=>n/l);};
 let eye,forward,right,up,focal,faces=[];
 const avatar=new win.Image();avatar.src=options.posterSrc||options.avatar?.('bigfish')||'';avatar.onload=()=>draw();
 const video=doc.createElement('video');video.muted=true;video.playsInline=true;video.preload='auto';let animations=null,animationEpoch=0,performing=false,petRect=null,petDrag=null,petPress=null,pose=null,poseFrom=null,poseAt=0;
 const pick=list=>list?.length?list[Math.floor(Math.random()*list.length)]:null;
 async function play(kind){const epoch=++animationEpoch,name=pick(animations?.[kind==='action'?'actions':kind==='move'?'moves':kind]);if(!name)return;
  performing=kind==='action'||kind==='clicks';
  try{const result=await bridge.home({action:'pet-animation',name});if(disposed||epoch!==animationEpoch)return;video.loop=['idle','move','drag'].includes(kind);video.src=result.animation.src;root.dataset.petAction=name;await video.play();}catch{if(!disposed&&epoch===animationEpoch){performing=false;video.removeAttribute('src');root.dataset.petAction='';}}
 }
 video.onended=()=>{performing=false;void play('idle');};video.onerror=()=>{performing=false;video.removeAttribute('src');};
 const petMotion=createHomePetMotion({getState:()=>state,move:async request=>{if(!await command(request))throw Error('小鱼暂时不能移动');},onActivity:kind=>void play(kind),blocked:()=>performing||!!drag||!!petDrag||doc.hidden||!onScreen||doc.activeElement?.matches?.('input,textarea,[contenteditable=true]')});
 const motionTimer=win.setInterval(()=>void petMotion.tick(),250);
 function petPosition(){if(petDrag)return petDrag.position;const to=state?.avatar?.position;if(!to)return {x:0,y:0,z:2.5};if(!poseFrom||motion?.matches)return to;const t=clamp((win.performance.now()-poseAt)/900,0,1);return {x:poseFrom.x+(to.x-poseFrom.x)*t,y:0,z:poseFrom.z+(to.z-poseFrom.z)*t};}
 function camera(){
  const a=state?.avatar||{},p=a.position||{x:0,y:0,z:2.5},fp=state?.perspective==='agent'||state?.perspective==='yui';
  if(fp){eye=[p.x,(p.y||0)+1.1+platformLift,p.z];const yaw=radians(lookYaw),pitch=radians(lookPitch);forward=[Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),-Math.cos(yaw)*Math.cos(pitch)];focal=w/(2*Math.tan(radians(43)));}
  else{const yaw=radians(azimuth),pitch=radians(elevation),distance=17/zoom;eye=[Math.sin(yaw)*Math.cos(pitch)*distance,Math.sin(pitch)*distance,Math.cos(yaw)*Math.cos(pitch)*distance];forward=normal(sub([0,0,0],eye));focal=Math.min(w*.95,h*1.5)*.9;}
  right=normal(cross(forward,[0,1,0]));up=cross(right,forward);
 }
 const space=p=>{const d=sub(p,eye);return [dot(d,right),dot(d,up),dot(d,forward)];};
 function screen(p){return [w/2+p[0]*focal/p[2],h*.55-p[1]*focal/p[2]];}
 function clipped(points){const out=[];for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length],inside=a[2]>=.08,next=b[2]>=.08;if(inside)out.push(a);if(inside!==next){const t=(.08-a[2])/(b[2]-a[2]);out.push(a.map((v,k)=>v+(b[k]-v)*t));}}return out;}
 function face(vertices,color,edge){const p=clipped(vertices.map(space));if(p.length<3)return;faces.push({p:p.map(screen),depth:p.reduce((n,p)=>n+p[2],0)/p.length,color,edge});}
 function shade(color,amount){const s=/^#([0-9a-f]{6})$/i.exec(color);if(!s)return color;const n=parseInt(s[1],16);return '#'+[n>>16,(n>>8)&255,n&255].map(v=>Math.round(clamp(v*amount,0,255)).toString(16).padStart(2,'0')).join('');}
 function box(x,y,z,width,height,depth,color,rotation=0){const angle=radians(rotation),cs=Math.cos(angle),sn=Math.sin(angle);const p=(dx,dy,dz)=>[x+dx*cs+dz*sn,y+dy,z-dx*sn+dz*cs];const v=[p(-width/2,0,-depth/2),p(width/2,0,-depth/2),p(width/2,0,depth/2),p(-width/2,0,depth/2),p(-width/2,height,-depth/2),p(width/2,height,-depth/2),p(width/2,height,depth/2),p(-width/2,height,depth/2)];for(const [indices,light] of [[[0,1,5,4],.68],[[1,2,6,5],.85],[[2,3,7,6],.92],[[3,0,4,7],.76],[[4,5,6,7],1.12]])face(indices.map(i=>v[i]),shade(color,light));}
 function furniture(o){
  const {x,z,y,width:W,height:H,depth:D,rotation:r,color:c,kind}=o;
  const part=(dx,dy,dz,a,b,d,col)=>{const angle=radians(r);box(x+dx*Math.cos(angle)+dz*Math.sin(angle),y+dy+platformLift,z-dx*Math.sin(angle)+dz*Math.cos(angle),a,b,d,col,r);};
  if(kind==='rug'){part(0,0,0,W,.025,D,c);part(0,.027,0,W*.82,.008,D*.8,shade(c,1.13));}
  else if(['desk','table'].includes(kind)){part(0,H*.83,0,W,H*.16,D,c);for(const dx of [-W*.4,W*.4])for(const dz of [-D*.36,D*.36])part(dx,0,dz,.09,H*.85,.09,shade(c,.75));if(kind==='desk'){part(W*.3,0,0,W*.28,H*.82,D*.85,shade(c,.94));for(let n=1;n<=3;n++)part(W*.3,H*n*.19,D*.44,W*.15,.018,.025,'#bcb3a6');}}
  else if(kind==='bed'){part(0,0,0,W,H*.42,D,shade(c,.72));part(0,H*.42,0,W*.97,H*.42,D*.97,'#dedbd0');part(0,H*.82,D*.12,W*.98,H*.17,D*.7,c);part(0,H*.82,-D*.32,W*.75,H*.17,D*.21,'#eee7dc');}
  else if(kind==='chair'){part(0,H*.38,0,W,H*.12,D,c);part(0,H*.47,-D*.43,W,H*.53,.1,c);for(const dx of [-W*.35,W*.35])for(const dz of [-D*.35,D*.35])part(dx,0,dz,.07,H*.4,.07,'#434d53');}
  else if(kind==='sofa'){part(0,0,0,W,H*.38,D,shade(c,.8));part(0,H*.38,D*.05,W*.8,H*.22,D*.8,c);part(0,H*.38,-D*.4,W,H*.62,D*.22,c);for(const dx of [-W*.45,W*.45])part(dx,H*.3,0,W*.1,H*.4,D,c);}
  else if(kind==='shelf'){part(-W*.46,0,0,W*.08,H,D,c);part(W*.46,0,0,W*.08,H,D,c);for(let i=0;i<=3;i++){part(0,H*i/3,0,W,.06,D,c);if(i<3)for(let n=0;n<4;n++)part(-W*.32+n*W*.2,H*i/3+.07,0,W*.13,H*.23,D*.65,['#b88d85','#69869b','#d4bd93','#809e8e'][n]);}}
  else if(kind==='plant'){part(0,0,0,W*.7,H*.3,D*.7,'#a68c76');part(0,H*.3,0,.05,H*.6,.05,'#556b49');part(0,H*.48,0,W,H*.42,D,'#657e62');part(-W*.2,H*.66,D*.1,W*.65,H*.28,D*.6,'#88a27a');}
  else if(kind==='lamp'){part(0,0,0,W*.8,.06,D*.8,'#5c6061');part(0,.05,0,.055,H*.72,.055,'#7f7b70');part(0,H*.72,0,W,H*.25,D,'#efe0bb');}
  else if(kind==='screen'){part(0,0,0,W*.5,.04,D*2,'#374754');part(0,.03,0,.06,H*.18,.06,'#374754');part(0,H*.2,0,W,H*.8,D,'#293c4b');part(0,H*.25,D*.53,W*.91,H*.68,.018,'#7699b5');}
  else if(kind==='window'){part(0,0,0,W,H,D,'#d4c6af');part(0,H*.06,D*.55,W*.88,H*.88,.025,'#4f718d');part(0,H*.06,D*.65,.05,H*.88,.03,'#ddcfb5');part(0,H*.46,D*.65,W*.88,.05,.03,'#ddcfb5');}
  else if(kind==='plush'){part(0,0,0,W*.8,H*.6,D*.8,c);part(0,H*.45,0,W,H*.48,D,c);for(const dx of [-W*.32,W*.32])part(dx,H*.84,0,W*.25,H*.2,D*.5,c);for(const dx of [-W*.18,W*.18])part(dx,H*.72,D*.51,.04,.05,.02,'#24384c');}
  else part(0,0,0,W,H,D,c);
 }
 function ocean(ctx,paintFace){
  // This is world geometry below the platform, shared by orbit and first
  // person. Water continues far beyond the room and intersects its draft.
  face([[-600,waterLevel,-600],[600,waterLevel,-600],[600,waterLevel,600],[-600,waterLevel,600]],'#67b7c9');
  faces.forEach(paintFace);faces=[];
  function stroke(points,color,width=1){let connected=false;ctx.beginPath();for(const point of points){const p=space(point);if(p[2]<.1){connected=false;continue;}const s=screen(p);if(connected)ctx.lineTo(...s);else ctx.moveTo(...s);connected=true;}ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();}
  for(let row=-20;row<=20;row++){
   const points=[],z=row*1.35;for(let step=-28;step<=28;step++){const x=step*1.25;points.push([x,waterLevel+.012*Math.sin(x*.6+z*.4+seaTime),z+.12*Math.sin(x*.8+seaTime*.7+row)]);}
   const alpha=.22/(1+Math.abs(row)*.07);stroke(points,`rgba(227,252,255,${alpha})`,1.1);
  }
  for(let i=0;i<95;i++){const x=((i*17.73)%54)-27,z=((i*11.31)%48)-24,p=space([x,waterLevel+.015,z]);if(p[2]<=.1)continue;const s=screen(p),glow=.11+.1*Math.sin(seaTime*1.1+i*2.3);ctx.fillStyle=`rgba(238,255,255,${glow})`;ctx.beginPath();ctx.arc(s[0],s[1],Math.max(.5,Math.min(2,focal/p[2]*.012)),0,Math.PI*2);ctx.fill();}
  // Ripples touch the exposed edges at the actual waterline, not under a
  // detached floor shadow. The submerged part of the base stays underwater.
  for(const side of [-1,1])for(let axis=0;axis<2;axis++){
   const points=[];for(let i=0;i<=60;i++){const n=i/60,offset=.07+.025*Math.sin(n*24-seaTime*1.2);points.push(axis?[side*(4.5+offset),waterLevel+.01,-3.5+n*7]:[-4.5+n*9,waterLevel+.01,side*(3.5+offset)]);}stroke(points,'rgba(235,255,255,.5)',1.4);
  }
 }
 function draw(){if(disposed||!state)return;const ctx=canvas.getContext('2d');if(!ctx)return;seaTime=motion?.matches?0:win.performance.now()/1000;platformLift=motion?.matches?0:Math.sin(seaTime*.8)*.014;const scale=Math.min(win.devicePixelRatio||1,2);ctx.setTransform(scale,0,0,scale,0,0);ctx.clearRect(0,0,w,h);camera();faces=[];
  const paintFace=f=>{ctx.beginPath();ctx.moveTo(...f.p[0]);for(const p of f.p.slice(1))ctx.lineTo(...p);ctx.closePath();ctx.fillStyle=f.color;ctx.fill();if(f.edge){ctx.strokeStyle=f.edge;ctx.lineWidth=.5;ctx.stroke();}};
  ocean(ctx,paintFace);
  box(0,waterLevel,0,9,platformLift-.01-waterLevel,7,'#8b7860');
  // Floor layers are below every object. Sorting the slab's large top face
  // together with the boards would incorrectly cover the far half of them.
  faces.sort((a,b)=>b.depth-a.depth).forEach(paintFace);faces=[];
  for(let row=0;row<20;row++)for(let col=-1;col<7;col++){const left=Math.max(-4.5,-4.5+col*1.5+(row%2)*.75),right=Math.min(4.5,-4.5+(col+1)*1.5+(row%2)*.75),back=-3.5+row*.35;if(right<=left)continue;face([[left,platformLift,back],[right,platformLift,back],[right,platformLift,back+.35],[left,platformLift,back+.35]],shade('#b6a083',.96+((row*7+col*3)%5)*.013),'#8c765c55');}
  faces.sort((a,b)=>b.depth-a.depth).forEach(paintFace);faces=[];
  for(const item of state.items||[])furniture(item);
  const a=state.avatar||{},fp=state.perspective==='agent'||state.perspective==='yui';let pet=null;
  petRect=null;if(a.atHome&&!fp){const p=petPosition(),foot=space([p.x,.03+platformLift,p.z]),head=space([p.x,1.3+platformLift,p.z]);if(foot[2]>.08&&head[2]>.08){const f=screen(foot),t=screen(head);pet={p:f,height:Math.max(20,f[1]-t[1]),depth:foot[2]};}}
  function paintPet(){if(!pet)return;const size=pet.height,media=video.readyState>=2&&video.videoWidth?video:avatar,frame=homePetSpriteFrame(pet.p,size,media.videoWidth||media.naturalWidth,media.videoHeight||media.naturalHeight,media===video);petRect=frame.hit;if(media===video||avatar.complete&&avatar.naturalWidth){const r=frame.draw;ctx.drawImage(media,r.left,r.top,r.width,r.height);}else{ctx.fillStyle='#829dbf';ctx.beginPath();ctx.arc(pet.p[0],pet.p[1]-size*.45,size*.3,0,Math.PI*2);ctx.fill();}pet=null;}
  faces.sort((a,b)=>b.depth-a.depth);for(const f of faces){if(pet&&pet.depth>f.depth)paintPet();paintFace(f);}paintPet();
 }
 function updateUi(){const fp=['agent','yui'].includes(state.perspective);orbit.setAttribute('aria-pressed',String(!fp));first.setAttribute('aria-pressed',String(fp));const v=state.homeValue,known=v?.status==='recorded'&&!v.unknownCalls&&Number.isSafeInteger(v.tokens)&&v.tokens>=0;value.textContent='价值：'+(known?v.tokens.toLocaleString('en-US'):'—')+' Token';value.title=v?.unknownCalls?'部分建造请求未返回用量；已确认 '+v.tokens.toLocaleString('en-US')+' Token':'从本版本开始累计成功修改小窝的模型请求用量；不含普通聊天、浏览、手动修改和不可追溯的历史用量';inventory.textContent=(state.items||[]).length?`${state.items.length} 件一起添置的东西`:'';const p=state.persistence;status.textContent=state.buildError||(p?.status==='save-error'||p?.status==='load-error'?p.error||'小窝暂未保存':'');canvas.setAttribute('aria-label',fp?'大肥鱼第一视角，海面木平台，拖动环顾，W A S D 移动':'浮在海面上的小窝木平台，拖动旋转，滚轮缩放');}
 function setState(next){if(disposed||!next?.ok||!next.avatar||next.revision<(state?.revision??-1))return;const p=next.avatar.position;if(!pose||p.x!==pose.x||p.z!==pose.z){poseFrom=petPosition();pose={...p};poseAt=win.performance.now();}state=next;if(!drag){lookYaw=state.avatar?.yaw||0;lookPitch=state.avatar?.pitch??-10;}updateUi();draw();}
 function animate(now){frame=null;if(disposed||doc.hidden||!onScreen||motion?.matches)return;if(now-lastFrame>=50){lastFrame=now;draw();}frame=win.requestAnimationFrame(animate);}
 function syncAnimation(){if(frame!==null)win.cancelAnimationFrame?.(frame);frame=null;if(video.getAttribute('src')){if(doc.hidden||!onScreen)video.pause();else void video.play().catch(()=>{});}if(!disposed&&!doc.hidden&&onScreen&&!motion?.matches&&typeof win.requestAnimationFrame==='function')frame=win.requestAnimationFrame(animate);}
 function motionChanged(){draw();syncAnimation();}
 async function command(request){try{const result=await bridge.home(request);if(!disposed)setState(result);return result;}catch(e){if(!disposed)status.textContent=e.message||'小窝暂未更新';return null;}}
 function resize(){const r=root.getBoundingClientRect();w=Math.max(1,Math.floor(r.width));h=Math.max(1,Math.floor(r.height));const scale=Math.min(win.devicePixelRatio||1,2);canvas.width=Math.round(w*scale);canvas.height=Math.round(h*scale);draw();}
 invite.addEventListener('click',async()=>{if(invite.disabled)return;invite.disabled=true;status.textContent='';const detail={};try{doc.dispatchEvent(new win.CustomEvent('neko-home-build-workspace',{detail}));if(!detail.handled)throw Error('共建工作会话暂不可用');await detail.promise;}catch(e){status.textContent=e.message||'共建会话未能打开';}finally{invite.disabled=false;}});
 function localPoint(e){const r=canvas.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};}
 function ground(e){const p=localPoint(e),dx=(p.x-w/2)/focal,dy=-(p.y-h*.55)/focal,ray=forward.map((n,i)=>n+right[i]*dx+up[i]*dy),t=(platformLift-eye[1])/ray[1];return t>0?{x:clamp(eye[0]+ray[0]*t,-4.1,4.1),y:0,z:clamp(eye[2]+ray[2]*t,-3.1,3.1)}:null;}
 canvas.addEventListener('pointerdown',e=>{if(e.button!==0)return;canvas.focus();petMotion.pause();const p=localPoint(e);if(petRect&&p.x>=petRect.left&&p.x<=petRect.right&&p.y>=petRect.top&&p.y<=petRect.bottom){petPress={id:e.pointerId,x:e.clientX,y:e.clientY};petDrag={position:{...petPosition()},moved:false};void play('drag');}else drag={id:e.pointerId,x:e.clientX,y:e.clientY};canvas.setPointerCapture?.(e.pointerId);});
 canvas.addEventListener('pointermove',e=>{if(!petPress||petPress.id!==e.pointerId)return;if(Math.hypot(e.clientX-petPress.x,e.clientY-petPress.y)>5){const p=ground(e);if(p){petDrag.position=p;petDrag.moved=true;draw();}}});
 canvas.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag.x=e.clientX;drag.y=e.clientY;if(state?.perspective==='agent'||state?.perspective==='yui'){lookYaw+=dx*.35;lookPitch=clamp(lookPitch-dy*.25,-55,45);pendingLook={action:'avatar_look',yaw:lookYaw,pitch:lookPitch};clearTimeout(lookTimer);lookTimer=win.setTimeout(()=>{if(pendingLook)void command(pendingLook);pendingLook=null;},100);}else{azimuth-=dx*.4;elevation=clamp(elevation+dy*.25,18,70);}draw();});
 const end=async e=>{if(petPress){const held=petDrag;petPress=null;if(held?.moved&&e.type!=='pointercancel'){await command({action:'avatar_place',x:held.position.x,z:held.position.z});}petDrag=null;poseFrom=null;petMotion.pause();void play(e.type==='pointercancel'?'idle':held?.moved?'idle':'clicks');draw();}drag=null;if(pendingLook){clearTimeout(lookTimer);void command(pendingLook);pendingLook=null;}};canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);
 canvas.addEventListener('wheel',e=>{if(state?.perspective!=='orbit')return;e.preventDefault();zoom=clamp(zoom*(e.deltaY<0?1.08:1/1.08),.6,2);draw();},{passive:false});
 canvas.addEventListener('keydown',e=>{if(!['agent','yui'].includes(state?.perspective))return;const key=e.key.toLowerCase();if(!['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright'].includes(key))return;e.preventDefault();const yaw=radians(lookYaw),forwardStep=['w','arrowup'].includes(key)?1:['s','arrowdown'].includes(key)?-1:0,side=['d','arrowright'].includes(key)?1:['a','arrowleft'].includes(key)?-1:0;void command({action:'avatar_walk',dx:(Math.sin(yaw)*forwardStep+Math.cos(yaw)*side)*.25,dz:(-Math.cos(yaw)*forwardStep+Math.sin(yaw)*side)*.25});});
 const observer=win.ResizeObserver?new win.ResizeObserver(resize):null;observer?.observe(root);win.addEventListener('resize',resize);const unsubscribe=bridge.subscribeHome?.(setState);
 let helperActive=false,helperEventSeen=false;const setHelper=snapshot=>{if(disposed)return;helperActive=snapshot?.homeTask?.active===true;helper.hidden=!helperActive||!helper.src;};
 const unsubscribeTask=bridge.subscribe?.(snapshot=>{helperEventSeen=true;setHelper(snapshot);});void bridge.getState?.().then(snapshot=>{if(!helperEventSeen)setHelper(snapshot);}).catch(()=>{});
 void bridge.home({action:'home-task-avatar'}).then(result=>{if(!disposed&&typeof result?.src==='string'&&result.src.startsWith('data:image/webp;base64,')){helper.src=result.src;helper.hidden=!helperActive;}}).catch(()=>{});
 const intersection=win.IntersectionObserver?new win.IntersectionObserver(entries=>{onScreen=entries[0]?.isIntersecting!==false;syncAnimation();}):null;intersection?.observe(root);doc.addEventListener('visibilitychange',syncAnimation);motion?.addEventListener?.('change',motionChanged);
 const enterHome=()=>void command({action:'return-home'});stage.addEventListener('neko-home-enter',enterHome);
 const release=()=>{disposed=true;stage.removeEventListener('neko-home-enter',enterHome);animationEpoch++;win.clearInterval(motionTimer);petMotion.dispose();video.onended=video.onerror=null;if(video.getAttribute('src'))video.pause();video.removeAttribute('src');clearTimeout(lookTimer);if(frame!==null)win.cancelAnimationFrame?.(frame);observer?.disconnect();intersection?.disconnect();unsubscribe?.();unsubscribeTask?.();win.removeEventListener('resize',resize);doc.removeEventListener('visibilitychange',syncAnimation);motion?.removeEventListener?.('change',motionChanged);avatar.onload=null;root.remove();};
 try{setState(await bridge.home({action:'status'}));resize();syncAnimation();void bridge.home({action:'pet-animations'}).then(result=>{if(!disposed&&result.animations){animations=result.animations;void play('idle');}}).catch(()=>{});}catch(error){release();throw error;}
 return release;
}

function mountYuiHome(stage,options={}){return mountOurHome(stage,options);}
