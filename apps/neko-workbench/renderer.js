const query = new URLSearchParams(location.search);
const view = query.get('view');
const actorId = query.get('actor');
const host = document.getElementById('app');
let state, inputVisible = false, dragStart, lastPointer, dragged = false, noticeTimer;
const clips = {idle:'idle',working:'working',stopping:'waiting',success:'success',stopped:'idle',error:'error'};
const busy = actor => ['working','stopping'].includes(actor.status);
// Settings submits show an in-flight state and cannot be double-submitted.
async function submitting(form,task){const button=form.querySelector('button[type=submit]');if(button?.disabled)return;if(button){button.disabled=true;button.setAttribute('aria-busy','true');}try{await task();}finally{if(button){button.disabled=false;button.removeAttribute('aria-busy');}}}

if(view==='chat-settings'){
  document.title='聊天 API 设置';window.addEventListener('unload',window.WorkbenchChatUI.mountSettings(host,window.pet),{once:true});
}else if(view==='chat-memory'){
  document.title='聊天记忆';window.addEventListener('unload',window.WorkbenchChatUI.mountMemory(host,window.pet),{once:true});
}else if(view==='neko-settings'){
  document.title='N.E.K.O. 聊天';
  host.innerHTML='<form class="settings-form neko-settings"><label for="neko-url">N.E.K.O. 服务地址</label><input id="neko-url" type="url" required placeholder="http://127.0.0.1:48911"><label for="neko-character">聊天角色</label><input id="neko-character" type="text" list="neko-characters" placeholder="默认使用独立大肥鱼角色"><datalist id="neko-characters"></datalist><p>沿用 N.E.K.O. 的角色与记忆，使用现有单行聊天框。</p><button type="submit">连接</button><span role="status"></span></form>';
  let loaded=false;const url=document.getElementById('neko-url'),character=document.getElementById('neko-character'),message=host.querySelector('[role=status]');
  function renderSettings(next){state=next;if(!loaded){url.value=state.neko.baseUrl;character.value=state.neko.character||'';loaded=true;}
    const list=document.getElementById('neko-characters');list.replaceChildren(...(state.neko.characters||[]).map(name=>{const item=document.createElement('option');item.value=name;return item;}));
    message.textContent=state.neko.connection==='ready'?'已连接 '+state.neko.character:state.neko.connection==='connecting'?'连接中…':state.neko.error||'请先启动 N.E.K.O.';
  }
  window.pet.onState(renderSettings);window.pet.call('state').then(renderSettings);
  host.querySelector('form').onsubmit=event=>{event.preventDefault();void submitting(event.currentTarget,async()=>{try{await window.pet.call('neko-settings',{baseUrl:url.value,character:character.value});}catch(error){message.textContent=error.message;}});};
}else if(view==='rename'){
  document.title='修改名字';
  host.innerHTML='<form class="settings-form rename-form"><label for="pet-name">给她起个名字</label><input id="pet-name" type="text" maxlength="48" autocomplete="off" spellcheck="false"><p>留空就跟随 DSH 的名字。</p><button type="submit">保存</button><span role="status"></span></form>';
  const field=document.getElementById('pet-name'),message=host.querySelector('[role=status]');let loaded=false;
  function renderName(next){state=next;const a=state.actors.find(a=>a.id===actorId);if(a&&!loaded){field.value=a.nickname||'';field.placeholder=a.dshName||a.name;loaded=true;field.focus();}}
  window.pet.onState(renderName);window.pet.call('state').then(renderName);
  host.querySelector('form').onsubmit=event=>{event.preventDefault();void submitting(event.currentTarget,async()=>{try{await window.pet.call('rename',{name:field.value});message.textContent='已保存';}catch(error){message.textContent=error.message;}});};
} else if (view === 'settings') {
  document.title='任务与帮手形象数量';
  host.innerHTML='<form class="settings-form"><label for="helper-limit">任务与帮手形象数量上限</label><input id="helper-limit" type="number" min="1" max="32" step="1" required><p>任务与子代理共用名额，常驻优先。隐藏形象不影响后台运行。</p><button type="submit">保存</button><span role="status"></span></form>';
  const field=document.getElementById('helper-limit'),message=host.querySelector('[role=status]');
  let loaded=false;
  function renderSettings(next){state=next;field.min=Math.max(1,state.helperDisplay?.pinned||0);if(!loaded){field.value=state.preferences.helperLimit;loaded=true;}}
  window.pet.onState(renderSettings);window.pet.call('state').then(renderSettings);
  host.querySelector('form').onsubmit=event=>{event.preventDefault();void submitting(event.currentTarget,async()=>{try{await window.pet.call('settings',{helperLimit:Number(field.value)});message.textContent='已保存';}catch(error){message.textContent=error.message;}});};
} else if (view === 'memory') {
  document.title='任务备注';
  host.innerHTML = '<form class="memory-form"><label for="memory">工作台任务备注</label><textarea id="memory" placeholder="每行一条，发送任务时带上"></textarea><button type="submit">保存备注</button><span id="saved" role="status"></span></form>';
  const field = document.getElementById('memory');
  let loaded = false;
  function renderMemory(next) {state=next;if(!loaded){field.value=state.memory.join('\n');loaded=true;}}
  window.pet.onState(renderMemory);
  window.pet.call('state').then(renderMemory);
  host.querySelector('form').onsubmit = event => {
    event.preventDefault();
    void submitting(event.currentTarget,async()=>{
      try {await window.pet.call('memory',{text:field.value});document.getElementById('saved').textContent='已保存';}
      catch {document.getElementById('saved').textContent='保存失败，请再试一次';}
    });
  };
} else {
  host.innerHTML = '<main class="pet"><div class="pet-bubble is-whisper" role="status" hidden></div><button class="character" type="button"><video class="pet-video" autoplay muted playsinline aria-hidden="true"></video><video class="pet-video" autoplay muted playsinline aria-hidden="true"></video></button><form class="chat" hidden><span class="chat-whale" aria-hidden="true"><svg viewBox="0 0 40 32" fill="none"><path d="M12 20C5 21 2 17 3 13C7 13 10 14 12 17C11 12 13 9 17 9C19 13 17 17 15 19" fill="#7EBCE5"/><path d="M12 19C12 12 19 9 26 11C34 12 38 17 36 23C34 29 20 29 15 25C13 24 12 22 12 19Z" fill="#78B8E3"/><path d="M16 23C21 27 30 27 34 23" stroke="#DFF3FF" stroke-width="3" stroke-linecap="round"/><path d="M23 21C23 24 20 25 19 23" fill="#509CCC"/><circle cx="31" cy="17" r="1.3" fill="#385B7C"/><path d="M25 7V4M22 6L20 4M28 6L30 3" stroke="#8EC9EC" stroke-width="1.7" stroke-linecap="round"/></svg></span><span class="chat-water" aria-hidden="true"><svg viewBox="0 0 72 12" fill="none"><path d="M1 5C7 0 13 0 19 5S31 10 37 5S49 0 55 5S67 10 73 5M1 11C7 6 13 6 19 11S31 16 37 11S49 6 55 11S67 16 73 11" stroke="#8CC3E8" stroke-width="1.2"/></svg></span><input type="text" autocomplete="off" spellcheck="false" maxlength="30000"></form></main>';
  const character = host.querySelector('.character');
  const videos = host.querySelectorAll('video');
  const bubble = host.querySelector('.pet-bubble');
  const inspector=document.createElement('dl');inspector.className='task-inspector';inspector.hidden=true;
  inspector.innerHTML='<div><dt>任务</dt><dd data-field="task"></dd></div><div><dt>工作</dt><dd data-field="work"></dd></div><div><dt>你说</dt><dd data-field="lastUser"></dd></div>';
  inspector.setAttribute('aria-label','任务与上一条消息');host.querySelector('.pet').append(inspector);
  let hoverTimer,overCharacter=false;
  function hideInspector(){clearTimeout(hoverTimer);hoverTimer=null;inspector.hidden=true;host.querySelector('.pet').classList.remove('inspector-open');}
  function scheduleInspector(){
    if(actor()?.kind==='task'||actor()?.id==='main'&&['chat-api','deepseek-account'].includes(actor()?.chatBackend))return;
    if(!overCharacter||inputVisible||dragStart||dragged||hoverTimer||!inspector.hidden)return;
    hoverTimer=setTimeout(()=>{hoverTimer=null;if(overCharacter&&!inputVisible&&!dragStart){inspector.hidden=false;host.querySelector('.pet').classList.add('inspector-open');}},240);
  }
  const nameTag=document.createElement('div');nameTag.className='pet-logo';
  nameTag.innerHTML='<svg aria-hidden="true" viewBox="0 0 42 36" fill="none"><path d="M10 18C5 19 2 16 2 12C6 12 9 14 10 16C9 11 11 8 14 8C16 12 14 16 12 18" fill="#AED9F0"/><path d="M10 19C10 11 17 6 25 7C34 7 40 13 39 22C38 30 32 33 24 32C15 32 10 27 10 19Z" fill="#ECF8FF" stroke="#94C6E5" stroke-width="1.3"/><path d="M16 27C21 30 30 30 35 26" stroke="#C8E7F7" stroke-width="1.2" stroke-linecap="round"/><path d="M23 3V1M19 4L17 2" stroke="#8BC7E8" stroke-width="1.5" stroke-linecap="round"/></svg><span class="logo-letter"></span>';
  nameTag.hidden=true;host.querySelector('.pet').append(nameTag);
  const tierTag=document.createElement('div');tierTag.className='pet-tier';host.querySelector('.pet').append(tierTag);
  const feedback = new window.DshPetFeedback(actorId,videos,bubble);
  const appearance=window.PetAppearance.install({character,videos,feedback,document,matchMedia:query=>window.matchMedia(query),onHeadInset:value=>host.querySelector('.pet').style.setProperty('--media-head-inset',String(value))});
  let desktopMotion=null,runningPresentation=false;
  const stopMotion=window.pet.onMotion?.(value=>{
    desktopMotion=value;appearance.setMotion(value);
    const pet=host.querySelector('.pet');pet.dataset.agentMotion=value?.phase||'';
    pet.dataset.motionRetire=String(value?.retire!==false);
    pet.style.setProperty('--agent-lean',Math.max(-6,Math.min(6,Number(value?.lean)||0))+'deg');
    const a=actor();if(a)renderAnimation(a);
    passThrough();
  });
  window.addEventListener('unload',()=>stopMotion?.(),{once:true});
  window.addEventListener('unload',()=>appearance.dispose(),{once:true});
  const apiReplyPresenter=window.PetChatPresentation.createReplyPresenter(feedback);
  const stageWidth=Number(query.get('stageWidth'))||239;
  host.querySelector('.pet').style.setProperty('--pet-size',stageWidth+'px');
  host.querySelector('.pet').style.setProperty('--stage-width',stageWidth+'px');
  const form = host.querySelector('form');
  const input = host.querySelector('input');
  const stopReply=document.createElement('button');stopReply.type='button';stopReply.className='chat-stop';stopReply.textContent='■';stopReply.title='停止回复';stopReply.setAttribute('aria-label','停止回复');stopReply.hidden=true;form.append(stopReply);
  stopReply.addEventListener('click',()=>{stopReply.setAttribute('aria-busy','true');stopReply.disabled=true;window.pet.call('chat-cancel').catch(()=>showBubble('停止回复未完成，请重试')).finally(()=>{stopReply.removeAttribute('aria-busy');stopReply.disabled=false;});});
  let shownNotice,shownReply;
  const actor = () => state?.actors.find(a=>a.id===actorId);
  let ignoredMouse=null,lastHover=null;
  function passThrough(event=lastHover){
    if(event)lastHover={clientX:event.clientX,clientY:event.clientY};
    const a=actor(),exploring=a?.id!=='main'&&(desktopMotion||state?.preferences.subagentFountain!==false||state?.preferences.subagentClustering!==false||a?.kind!=='task'&&appearance.isCat()&&state?.preferences.subagentExploration!==false);
    let ignore=false;
    if(exploring&&!inputVisible&&!dragStart){
      const targets=[character,tierTag];
      if(!bubble.hidden)targets.push(bubble);
      ignore=!event||!targets.some(node=>{let r=node.getBoundingClientRect();if(node===character&&!appearance.isMedia()){const b=window.PetShared.HIT_BOX;r={left:r.left+r.width*b.x0/640,right:r.left+r.width*b.x1/640,top:r.top+r.height*b.y0/360,bottom:r.top+r.height*b.y1/360};}return event.clientX>=r.left&&event.clientX<=r.right&&event.clientY>=r.top&&event.clientY<=r.bottom;});
    }
    if(ignoredMouse!==ignore){ignoredMouse=ignore;window.pet.call('pass-through',{ignore}).catch(()=>{});}
  }
  window.addEventListener('mousemove',passThrough);
  window.addEventListener('mouseleave',()=>{lastHover=null;passThrough();});
  function showBubble(text) {feedback.showLocal(text);}
  function renderAnimation(a) {
    const visual=window.PetChatPresentation.animationActor(a,desktopMotion);
    appearance.render(state,visual);
    if(visual.presentationRunning){
      feedback.workOn=false;feedback.workText=null;feedback.workState=null;
      if(!dragged&&feedback.anim!=='子代理-持续奔跑')feedback.switchTo('子代理-持续奔跑',false);
    }else if(a.work){
      // Landing can happen without a new task tick. Apply the latest real work
      // snapshot immediately instead of leaving the airborne running loop on.
      if(runningPresentation){feedback.prevWorkTick=-1;feedback.prevWorkState=null;}
      feedback.onWorkTick(a.work,a.work.tick);
      if(runningPresentation&&!a.work.state)feedback.playIdle();
    }
    if(a.kind==='task'){feedback.workOn=false;feedback.workText=null;feedback.renderBubble?.();}
    runningPresentation=!!visual.presentationRunning;
  }
  function resumeAnimation() {
    const a=actor();
    if(a&&window.PetChatPresentation.animationActor(a,desktopMotion).presentationRunning)feedback.switchTo('子代理-持续奔跑',false);
    else if(!feedback.resumeWorkStatusAnim())feedback.playIdle();
  }
  function setInput(visible) {
    const a=actor(),tier=window.PetChatPresentation.role(a); if(!a)return;
    if(tier==='subagent'){inputVisible=false;form.remove();bubble.hidden=true;host.querySelector('.pet').classList.remove('chat-open','task-chat-open');return;}
    if(tier==='task'){
      inputVisible=visible;form.hidden=true;const pet=host.querySelector('.pet');pet.classList.remove('chat-open');pet.classList.toggle('task-chat-open',visible);
      character.setAttribute('aria-expanded',String(visible));window.pet.call('motion-input',{active:visible}).catch(()=>{});passThrough();hideInspector();
      feedback.showLocal(visible?window.PetChatPresentation.taskChatText(a):'',{persistent:visible});return;
    }
    inputVisible=visible;form.hidden=!visible;host.querySelector('.pet').classList.toggle('chat-open',visible);
    window.pet.call('motion-input',{active:visible}).catch(()=>{});passThrough();
    if(visible){hideInspector();input.focus();}else scheduleInspector();
  }
  function render(next) {
    state=next;const a=actor();if(!a)return;document.title=a.name;const work=a.work;host.querySelector('.pet').dataset.workState=work?.state||'';host.querySelector('.pet').dataset.chatBackend=a.chatBackend||'dsh';host.querySelector('.pet').dataset.tier=a.id==='main'?'main':a.kind==='task'?'task':'subagent';
    const effectiveWidth=Number(a.stageWidth)||stageWidth;host.querySelector('.pet').style.setProperty('--pet-size',effectiveWidth+'px');host.querySelector('.pet').style.setProperty('--stage-width',effectiveWidth+'px');
    const tier=a.id==='main'?'主角色':a.kind==='task'?'任务':'帮手';tierTag.textContent=Array.from(a.name||'').slice(0,3).join('');tierTag.title=a.name+' · '+tier+(a.pinned?' · 常驻':'')+(a.dshName&&a.nickname?'\nDSH：'+a.dshName:'');tierTag.setAttribute('aria-label',tier+' · '+a.name);
    const appearanceId=window.PetAppearance.selected(state,a);host.querySelector('.pet').dataset.appearance=appearanceId;host.querySelector('.pet').dataset.media=String(appearanceId!==window.PetAppearance.ORIGINAL);
    host.querySelector('.pet').style.setProperty('--appearance-scale',String(window.PetAppearance.scaleFor(state,a)));
    host.querySelector('.pet').style.setProperty('--frame-aspect',String(window.PetAppearance.frameAspect(state,a)));
    renderAnimation(a);
    passThrough();
    if(a.kind==='task')hideInspector();
    if(a.id!=='main'&&a.kind!=='task'){form.remove();inputVisible=false;host.querySelector('.pet').classList.remove('chat-open','task-chat-open');}

    nameTag.querySelector('.logo-letter').textContent=Array.from(a.name)[0]||'鲸';nameTag.classList.toggle('is-pinned',!!a.pinned);nameTag.title=a.name+(a.pinned?' · 常驻桌面':'')+(a.dshName&&a.nickname?'\nDSH：'+a.dshName:'');nameTag.setAttribute('aria-label',a.name);
    character.setAttribute('aria-label',a.id==='main'?'与'+a.name+'聊天':a.kind==='task'?'展开或收起子会话聊天：'+a.name:'查看子代理状态：'+a.name);if(a.kind==='task')character.setAttribute('aria-expanded',String(inputVisible));else character.removeAttribute('aria-expanded');
    const preview=window.PetContext.preview(a);for(const field of inspector.querySelectorAll('dd'))field.textContent=preview[field.dataset.field];
    input.setAttribute('aria-label','给'+a.name+'发消息');
    const mainChatService=a.id==='main'&&['chat-api','deepseek-account'].includes(a.chatBackend);
    input.title=a.id==='main'?(a.chatBackend==='deepseek-account'?'DeepSeek 账号聊天 · 大肥鱼':a.chatBackend==='chat-api'?'独立聊天 API · 大肥鱼':'N.E.K.O. · '+(state.neko.character||'等待连接')):a.name+(a.task?'\n任务：'+a.task:'');
    input.maxLength=mainChatService?8000:30000;
    stopReply.hidden=!(mainChatService&&busy(a));form.classList.toggle('can-stop',!stopReply.hidden);
    input.readOnly=a.id!=='main'&&a.mode!=='continuable';
    const shortName=Array.from(a.name).slice(0,12).join('')+(Array.from(a.name).length>12?'…':'');
    input.placeholder=a.id==='main'?(busy(a)?'正在回复，可点右侧停止':a.chatBackend==='deepseek-account'?'和大肥鱼聊聊，回车发送':a.chatBackend==='chat-api'?(state.mainChat?.hasKey&&state.mainChat?.settings?.model?'和大肥鱼聊聊，回车发送':'右键 → 聊天 API 设置'):state.neko.connection==='ready'?'和'+state.neko.character+'说点什么，回车发送':'N.E.K.O. 未连接，右键设置'):input.readOnly?'只读子任务，在 DSH 查看':busy(a)?((a.work?.task||a.task)?.slice(0,25)||'正在做，稍等一下…'):shortName+'：发消息，回车发送';
    if(a.id==='main'&&(mainChatService||a.screenReply)){
      hideInspector();bubble.tabIndex=0;bubble.title='最近回复，可滚动查看全文';apiReplyPresenter.render(a);
    }else if(a.kind==='task'){
      apiReplyPresenter.reset();bubble.tabIndex=0;bubble.title='子会话聊天消息';feedback.showLocal(inputVisible?window.PetChatPresentation.taskChatText(a):'',{persistent:inputVisible});
    }else if(a.id!=='main'){
      apiReplyPresenter.reset();feedback.showLocal('');bubble.hidden=true;bubble.removeAttribute('tabindex');bubble.removeAttribute('title');
    }else{
      if(apiReplyPresenter.reset())shownReply=shownNotice=undefined;
      bubble.removeAttribute('tabindex');bubble.removeAttribute('title');
      if(a.notice?.id!==shownNotice){shownNotice=a.notice?.id;feedback.showLocal(a.notice?.text||'');}
      const replyKey=a.chatReply&&JSON.stringify([a.chatReply.id,a.chatReply.text,a.chatReply.streaming]);
      if(replyKey&&replyKey!==shownReply){shownReply=replyKey;feedback.showLocal(a.chatReply.text);}
    }
  }
  window.pet.onState(render);
  window.pet.onInput(()=>setInput(true));
  window.pet.call('state').then(render);
  function trackHover(event){
    const r=character.getBoundingClientRect(),x=(event.clientX-r.left)/r.width,y=(event.clientY-r.top)/r.height;
    const box=appearance.isMedia()?{x0:0,y0:0,x1:640,y1:360}:window.PetShared.HIT_BOX;
    overCharacter=x>=box.x0/640&&x<=box.x1/640&&y>=box.y0/360&&y<=box.y1/360;
    if(overCharacter)scheduleInspector();else hideInspector();
  }
  character.addEventListener('pointerenter',trackHover);
  character.addEventListener('pointerleave',()=>{overCharacter=false;hideInspector();});
  window.addEventListener('blur',()=>{overCharacter=false;hideInspector();});
  character.addEventListener('pointerdown',event=>{
    hideInspector();
    if(event.button!==0)return;
    dragStart={x:event.screenX,y:event.screenY};lastPointer=dragStart;dragged=false;
    character.setPointerCapture(event.pointerId);
  });
  character.addEventListener('pointermove',event=>{
    trackHover(event);
    if(!dragStart)return;
    if(!dragged&&Math.hypot(event.screenX-dragStart.x,event.screenY-dragStart.y)>5){dragged=true;feedback.dragState.active=true;feedback.playOnce(window.PetShared.pick(feedback.animations.drag,feedback.anim));}
    if(dragged){window.pet.call('move',{dx:event.screenX-lastPointer.x,dy:event.screenY-lastPointer.y});lastPointer={x:event.screenX,y:event.screenY};}
  });
  character.addEventListener('pointerup',async()=>{
    if(!dragStart)return;
    dragStart=null;
    if(dragged){feedback.dragState.active=false;dragged=false;overCharacter=false;hideInspector();resumeAnimation();await window.pet.call('move-end');}
    else setInput(!inputVisible);
  });
  character.addEventListener('pointercancel',()=>{const wasDragged=dragged;dragStart=null;dragged=false;overCharacter=false;hideInspector();feedback.dragState.active=false;resumeAnimation();if(wasDragged)window.pet.call('move-end').catch(()=>{});});
  character.addEventListener('click',event=>{if(event.detail===0)setInput(!inputVisible);});
  document.addEventListener('contextmenu',event=>{event.preventDefault();hideInspector();window.pet.call('menu');});
  input.addEventListener('keydown',event=>{
    if(event.isComposing||event.keyCode===229)return;
    if(event.key==='Escape'){event.preventDefault();setInput(false);}
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();const text=input.value.trim();const a=actor();if(!text||!a||a.id!=='main')return;
    if(busy(a)){showBubble('我还在做，等我一下。');return;}
    try {await window.pet.call('prompt',{id:actorId,text});input.value='';setInput(false);}
    catch(error){showBubble(error.message);}
  });
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!event.isComposing)setInput(false);});
}
