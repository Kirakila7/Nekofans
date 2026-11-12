(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.WorkbenchChatUI=api;})(globalThis,function(){
  'use strict';
  function mountSettings(host,pet){
    host.innerHTML='<main class="chat-panel"><h1>聊天 API 设置</h1><p>主角色聊天与工作任务分开。</p><button type="button" class="use-deepseek-account" disabled>使用 DeepSeek 工作台账号</button><p>实验功能：使用已登录的工作台账号，无需另填 API Key；真实账号聊天尚未验收。社区大厅中的妈妈自动回复、手动生成回复及共同经历记忆暂不支持此模式。</p><form class="api-form"><div class="api-presets"><button type="button" class="deepseek-preset" disabled>使用 DeepSeek 预设</button><p>DeepSeek 聊天使用独立的 API Key 和 API 账户额度，与工作台登录的 DSH 账号及余额分开；发送消息会消耗 API 额度。</p></div><label>协议<select name="protocol"><option value="openai-compatible">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select></label><label>API 基础地址<input name="baseUrl" type="url" maxlength="2048" placeholder="https://example.com/v1"></label><label>模型<input name="model" type="text" maxlength="200" autocomplete="off"></label><div class="api-limits"><label>超时（毫秒）<input name="requestTimeoutMs" type="number" min="1000" max="300000" required></label><label>回复 Token 上限<input name="maxOutputTokens" type="number" min="1" max="32000" required></label></div><label>新密钥<input name="apiKey" type="password" maxlength="16384" autocomplete="new-password" placeholder="留空保留已存密钥"></label><label class="check-label"><input name="clearKey" type="checkbox">清除已保存密钥</label><p class="key-state"></p><p>保存后使用 Chat API，与可选本机 N.E.K.O. 连接互斥。密钥只保存在本机系统加密存储中。</p><p class="feature-status">原生语音：未接入，当前使用文字聊天。</p><button type="submit">保存并使用 Chat API</button><p role="status" aria-live="polite"></p></form><nav class="chat-settings-links"><button type="button" class="open-chat-memory">鱼的记忆</button><button type="button" class="open-local-neko">接回 N.E.K.O. 已有角色…</button></nav></main>';
    const form=host.querySelector('form'),get=name=>form.elements.namedItem(name),status=host.querySelector('[role=status]'),saved=host.querySelector('.key-state'),button=form.querySelector('button[type=submit]'),preset=host.querySelector('.deepseek-preset'),account=host.querySelector('.use-deepseek-account');
    let loaded=false,disposed=false,savedBaseUrl='',hasSavedKey=false,deepseekPresetSelected=false;
    const roleButtons=[];
    for(const [external,label] of [[false,'接回本工作台的 DSH 角色…'],[true,'接回独立 DSH 的角色…']]){
      let foundRole=null;
      const roleButton=host.ownerDocument.createElement('button');
      roleButton.type='button';
      roleButton.textContent=label;
      host.querySelector('.chat-settings-links').append(roleButton);
      roleButtons.push(roleButton);
      roleButton.addEventListener('click',async()=>{
        roleButtons.forEach(item=>{item.disabled=true;});
        try{
          const role=await pet.call('chat-dsh-role',{external,...(foundRole?{id:foundRole.id}:{})});
          if(disposed||!role)return;
          if(foundRole){
            status.textContent=role.running?'已连接 '+role.name:'已绑定 '+role.name+'，请在原工作台启动养鱼。';
            foundRole=null;
            roleButton.textContent=label;
          }else{
            foundRole=role;
            roleButton.textContent='接回 '+role.name;
          }
        }catch(error){
          if(disposed)return;
          foundRole=null;
          roleButton.textContent=label;
          status.textContent=error.message;
        }finally{if(!disposed)roleButtons.forEach(item=>{item.disabled=false;});}
      });
    }
    function render(snapshot){
      if(disposed||!snapshot)return;
      if(snapshot.settings&&!loaded){for(const name of ['protocol','baseUrl','model','requestTimeoutMs','maxOutputTokens'])get(name).value=String(snapshot.settings[name]??'');savedBaseUrl=String(snapshot.settings.baseUrl??'');loaded=true;preset.disabled=false;account.disabled=false;}
      hasSavedKey=!!snapshot.hasKey;
      saved.textContent=(snapshot.hasKey?'密钥已加密保存':'尚未保存密钥')+(snapshot.secureStorageAvailable?'':' · 系统加密存储不可用');
      if(!loaded)status.textContent=snapshot.error||'正在装配聊天服务…';
    }
    preset.addEventListener('click',()=>{if(!loaded||disposed)return;get('protocol').value='openai-compatible';get('baseUrl').value='https://api.deepseek.com';get('model').value='deepseek-flash';deepseekPresetSelected=true;status.textContent='已填入 DeepSeek 设置，请确认对应的 API Key 后保存。';});
    account.addEventListener('click',async()=>{if(!loaded||disposed||account.disabled||button.disabled)return;account.disabled=true;button.disabled=true;account.setAttribute('aria-busy','true');status.textContent='正在切换聊天方式…';try{const result=await pet.call('chat-use-deepseek-account');if(disposed)return;if(result?.backend!=='deepseek-account')throw Error('切换失败');render(result);status.textContent='已切换到 DeepSeek 工作台账号聊天；请确保工作台已登录。';}catch{if(!disposed)status.textContent='未能切换，请检查工作台连接后重试。';}finally{if(!disposed){account.disabled=false;button.disabled=false;account.removeAttribute('aria-busy');}}});
    host.querySelector('.open-chat-memory').addEventListener('click',()=>pet.call('chat-open-memory').catch(()=>{status.textContent='聊天记忆窗口未能打开';}));
    host.querySelector('.open-local-neko').addEventListener('click',()=>pet.call('chat-open-neko-settings').catch(()=>{status.textContent='本机连接设置未能打开';}));
    const off=pet.onState(state=>render(state.mainChat));
    pet.call('chat-settings-read').then(render,()=>{if(!disposed)status.textContent='聊天设置暂不可用';});
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(!loaded||button.disabled)return;button.disabled=true;button.setAttribute('aria-busy','true');status.textContent='正在保存…';
      const secret=get('apiKey').value;
      const key=get('clearKey').checked?{action:'clear'}:secret.trim()?{action:'replace',value:secret}:{action:'keep'};
      if(deepseekPresetSelected&&hasSavedKey&&key.action==='keep'){
        let savedOrigin='',targetOrigin='';try{savedOrigin=new URL(savedBaseUrl).origin;targetOrigin=new URL(get('baseUrl').value).origin;}catch{}
        if(!savedOrigin||savedOrigin!==targetOrigin){status.textContent='当前已保存其他服务商的密钥，请输入 DeepSeek API Key，或先勾选清除旧密钥。';button.disabled=false;button.removeAttribute('aria-busy');return;}
      }
      try{
        const result=await pet.call('chat-settings-save',{protocol:get('protocol').value,baseUrl:get('baseUrl').value,model:get('model').value,
          requestTimeoutMs:Number(get('requestTimeoutMs').value),maxOutputTokens:Number(get('maxOutputTokens').value),key});
        if(disposed)return;get('apiKey').value='';get('clearKey').checked=false;render(result);savedBaseUrl=get('baseUrl').value;deepseekPresetSelected=false;status.textContent=result.hasKey?'设置已保存；发送一条消息可测试连接。':'设置已保存；请先填写 API Key 再发送消息。';
      }catch{if(!disposed)status.textContent='保存失败，请检查地址、模型和系统加密存储';}
      finally{if(!disposed){button.disabled=false;button.removeAttribute('aria-busy');}}
    });
    return ()=>{disposed=true;off?.();};
  }
  // A live data visualization: stars are records, rays indicate ownership only.
  function memoryExplorer(host,renderCard,onCharacterChange){
    const doc=host.ownerDocument,win=doc.defaultView;
    host.innerHTML='<div class="memory-explorer"><div class="memory-explorer-top"><div><span class="memory-eyebrow">BIGFISH / MEMORY</span><h2>鱼的记忆</h2></div><div class="memory-view-tabs" role="group" aria-label="记忆视图"><button type="button" data-view="stars" aria-pressed="true">星图</button><button type="button" data-view="list" aria-pressed="false">文字列表</button></div></div><div class="memory-filters"><label class="memory-search-label">搜索记忆<input class="memory-search" type="search" placeholder="搜索内容或来源…" maxlength="200"></label><label>类型<select class="memory-kind"><option value="all">全部类型</option><option value="fact">事实</option><option value="preference">偏好</option><option value="episode">经历</option><option value="summary">摘要 / 反思</option></select></label><label>状态<select class="memory-state"><option value="active">正在记得</option><option value="all">全部记录</option><option value="deleted">已忘记</option><option value="conflict">待合并</option></select></label><label>排序<select class="memory-sort"><option value="priority">置顶与优先级</option><option value="recent">最近更新</option><option value="oldest">最早记忆</option></select></label></div><div class="memory-stars-layout"><div class="memory-universe"><canvas class="memory-canvas" tabindex="0" role="application" aria-label="记忆星图。左右方向键选择记忆，回车查看详情；也可切换文字列表操作。"></canvas><div class="memory-character"><button type="button" class="memory-character-toggle" aria-label="切换查看人物，当前：大肥鱼" aria-haspopup="menu" aria-expanded="false" title="切换查看人物"><img src="assets/icons/bigfish.webp" alt="大肥鱼" width="52" height="52" draggable="false"></button><div class="memory-character-menu" role="menu" aria-label="选择记忆人物" hidden></div></div><div class="memory-map-controls" role="group" aria-label="星图视角"><button type="button" class="memory-zoom-in" aria-label="放大星图" title="放大"></button><button type="button" class="memory-zoom-out" aria-label="缩小星图" title="缩小"></button><button type="button" class="memory-reset" aria-label="重置视角" title="重置视角"></button></div><p class="memory-map-empty" aria-live="polite"></p><div class="memory-time"><label><span>时间</span><input class="memory-time-range" type="range" min="0" max="1" value="1" step="1" aria-label="查看截至所选日期的记忆"></label></div><div class="memory-map-overview"><div class="memory-map-stats"></div><div class="memory-legend"><span data-kind="fact">事实</span><span data-kind="preference">偏好</span><span data-kind="episode">经历</span><span data-kind="summary">摘要 / 反思</span></div></div><section class="memory-inspector memory-popover" role="dialog" aria-label="选中的记忆"><header class="memory-popover-header"><span>记忆详情</span><button type="button" class="memory-popover-close" aria-label="关闭记忆浮窗">关闭</button></header><div class="memory-selected"></div></section></div></div><div class="memory-list-view" hidden><p class="memory-list-count" aria-live="polite"></p><div class="memory-list-cards"></div><nav class="memory-pagination" aria-label="记忆分页"><button type="button" class="memory-prev">上一页</button><span class="memory-page-label"></span><button type="button" class="memory-next">下一页</button></nav></div></div>';
    const $=selector=>host.querySelector(selector),canvas=$('.memory-canvas'),context=canvas.getContext('2d');
    let character={id:'bigfish',name:'大肥鱼',avatar:'assets/icons/bigfish.webp'},characters=[character];
    const characterMenu=$('.memory-character-menu'),characterToggle=$('.memory-character-toggle');
    const closeCharacters=()=>{characterMenu.hidden=true;characterToggle.setAttribute('aria-expanded','false');};
    function setCharacters(metadata){
      const next=metadata.character||character;
      if(next.id!==character.id){cutoff=null;page=0;selectedId=null;popoverOpen=false;for(const cls of ['.memory-search','.memory-kind','.memory-state','.memory-sort'])$(cls).value=cls==='.memory-search'?'':cls==='.memory-kind'?'all':cls==='.memory-state'?'active':'priority';}
      character=next;characters=metadata.characters?.length?metadata.characters:characters;
      $('.memory-eyebrow').textContent='MEMORY / '+character.name;
      const image=characterToggle.querySelector('img');image.src=character.avatar||'assets/icons/bigfish.webp';image.alt=character.name;
      characterToggle.setAttribute('aria-label','切换查看人物，当前：'+character.name);$('.memory-explorer-top h2').textContent='鱼的记忆';
      characterMenu.replaceChildren();
      for(const item of characters){const button=doc.createElement('button'),avatar=doc.createElement('img'),name=doc.createElement('span');button.type='button';button.setAttribute('role','menuitemradio');button.setAttribute('aria-checked',String(item.id===character.id));avatar.src=item.avatar||'assets/icons/bigfish.webp';avatar.alt='';name.textContent=item.name;button.append(avatar,name);button.addEventListener('click',()=>{closeCharacters();if(item.id!==character.id)onCharacterChange?.(item,characters);});characterMenu.append(button);}
    }
    characterToggle.addEventListener('click',()=>{const open=characterMenu.hidden;characterMenu.hidden=!open;characterToggle.setAttribute('aria-expanded',String(open));if(open)characterMenu.querySelector('[aria-checked=true]')?.focus();});
    const outsideCharacters=e=>{if(!$('.memory-character').contains(e.target))closeCharacters();};doc.addEventListener('pointerdown',outsideCharacters);
    characterMenu.addEventListener('keydown',e=>{const buttons=[...characterMenu.querySelectorAll('button')],index=buttons.indexOf(doc.activeElement);if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}});
    let records=[],visible=[],selectedId=null,view='stars',page=0,cutoff=null,minDay=0,maxDay=0,popoverOpen=true;
    let angle=.15,tilt=-.14,zoom=1,frame=0,disposed=false,points=[],pointer=null,width=0,height=0;
    const colors={fact:'#ffdf8a',preference:'#f2a6c1',episode:'#b7efff',summary:'#c9b5ff'};
    const priority=r=>r.value?.priority??r.previousValue?.priority??50,pinned=r=>(r.value||r.previousValue)?.pinned===true;
    const timestamp=r=>Math.max(0,...r.heads.map(e=>Date.parse(e.occurredAt)||0));
    const day=r=>Math.floor((Date.parse(r.createdAt)||timestamp(r))/86400000);
    const dateText=n=>new Date(n*86400000).toLocaleDateString('zh-CN',{timeZone:'UTC'});
    function setView(value){
      view=value;$('.memory-stars-layout').hidden=view!=='stars';$('.memory-list-view').hidden=view!=='list';
      for(const button of host.querySelectorAll('[data-view]'))button.setAttribute('aria-pressed',String(button.dataset.view===view));
      render();if(view==='stars'){resize();schedule();}else{win.cancelAnimationFrame(frame);frame=0;}
    }
    function render(){
      const query=$('.memory-search').value.trim().toLocaleLowerCase(),kind=$('.memory-kind').value,state=$('.memory-state').value;
      visible=records.filter(r=>{
        if(state==='active'&&r.deleted||state==='deleted'&&!r.deleted||state==='conflict'&&!r.conflict)return false;
        const values=r.value?[r.value]:r.previousValue?[r.previousValue]:r.heads.map(e=>e.value).filter(Boolean);
        return (kind==='all'||values.some(v=>v.kind===kind))&&(!query||values.some(v=>(v.text+' '+(v.evidenceRefs||[]).join(' ')).toLocaleLowerCase().includes(query)))&&(cutoff===null||day(r)<=cutoff);
      });
      const sort=$('.memory-sort').value;
      visible.sort((a,b)=>(sort==='priority'?(Number(pinned(b))-Number(pinned(a))||priority(b)-priority(a)||timestamp(b)-timestamp(a)):sort==='oldest'?timestamp(a)-timestamp(b):timestamp(b)-timestamp(a))||a.itemId.localeCompare(b.itemId));
      if(!visible.some(r=>r.itemId===selectedId))selectedId=visible[0]?.itemId||null;
      $('.memory-map-stats').textContent=`${visible.length} 条记忆 · ${visible.filter(pinned).length} 条置顶`;
      $('.memory-list-count').textContent=`${visible.length} 条记忆 · 优先级 0–100，数值越大越靠前；置顶优先。`;
      $('.memory-map-empty').textContent=visible.length?'':records.length?'没有符合筛选条件的记忆':character.id==='bigfish'?'还没有记忆。完成聊天后，这里会慢慢亮起。':'这个人物还没有已保存的独立记忆。';
      const timeText=cutoff===null?'全部时间':'截至 '+dateText(cutoff);
      $('.memory-time-range').setAttribute('aria-valuetext',timeText);$('.memory-time-range').title=timeText;
      const selected=visible.find(r=>r.itemId===selectedId),target=$('.memory-selected');
      target.replaceChildren();if(selected)target.append(renderCard(selected));
      $('.memory-popover').hidden=!selected||!popoverOpen;
      const pages=Math.max(1,Math.ceil(visible.length/30));page=Math.min(page,pages-1);
      $('.memory-list-cards').replaceChildren(...visible.slice(page*30,page*30+30).map(renderCard));
      if(!visible.length){const empty=doc.createElement('p');empty.className='empty-state';empty.textContent='没有符合筛选条件的记忆。';$('.memory-list-cards').append(empty);}
      $('.memory-page-label').textContent=`${page+1} / ${pages}`;$('.memory-prev').disabled=page===0;$('.memory-next').disabled=page>=pages-1;
      schedule();
    }
    function closePopover(){popoverOpen=false;$('.memory-popover').hidden=true;canvas.focus();schedule();}
    function select(id){selectedId=id;popoverOpen=true;const row=visible.find(r=>r.itemId===id);$('.memory-selected').replaceChildren(...(row?[renderCard(row)]:[]));$('.memory-popover').hidden=!row;schedule();}
    function positionPopover(point){
      const popup=$('.memory-popover');if(popup.hidden||!point)return;
      const gap=18,pad=12,top=width<600?88:56,pw=popup.offsetWidth,ph=popup.offsetHeight;
      let x=point.x+gap;if(x+pw>width-pad)x=point.x-gap-pw;
      x=Math.max(pad,Math.min(width-pw-pad,x));
      const y=Math.max(top,Math.min(height-ph-78,point.y-ph*.35));
      popup.style.left=x+'px';popup.style.top=y+'px';
    }
    const hash=id=>{let n=2166136261;for(const char of id)n=Math.imul(n^char.charCodeAt(0),16777619);return n>>>0;};
    function draw(){
      frame=0;if(disposed||view!=='stars'||!context||!width||!height)return;
      const c=context,w=width,h=height,cx=w*.5,cy=h*.46,radius=Math.min(w*.43,h*.38)*zoom;
      c.clearRect(0,0,w,h);c.fillStyle='#0b1018';c.fillRect(0,0,w,h);
      const core=c.createRadialGradient(cx,cy,0,cx,cy,radius*1.1);core.addColorStop(0,'#70512135');core.addColorStop(.4,'#20263b30');core.addColorStop(1,'#0b101800');c.fillStyle=core;c.fillRect(0,0,w,h);
      // Stable positions survive refresh, sort and filters. At most 800 stars per frame.
      const plotted=visible.slice(0,800);
      points=plotted.map(record=>{
        const seed=hash(record.itemId),a=(seed%100000)/100000*Math.PI*2,b=Math.acos(2*((hash(record.itemId+':lat')%10000)/10000)-1),rad=.28+(hash(record.itemId+':r')%1000)/1000*.72;
        let x=Math.cos(a)*Math.sin(b)*rad,y=Math.cos(b)*rad,z=Math.sin(a)*Math.sin(b)*rad;
        const xx=x*Math.cos(angle)-z*Math.sin(angle),zz=x*Math.sin(angle)+z*Math.cos(angle),yy=y*Math.cos(tilt)-zz*Math.sin(tilt),depth=y*Math.sin(tilt)+zz*Math.cos(tilt),perspective=1/(1-depth*.3);
        return {record,x:cx+xx*radius*perspective,y:cy+yy*radius*perspective,depth,size:(1.6+priority(record)/35+(pinned(record)?1.3:0))*perspective};
      }).sort((a,b)=>a.depth-b.depth);
      for(const p of points){
        const active=p.record.itemId===selectedId,color=colors[p.record.value?.kind]||'#aab7cc';
        c.globalAlpha=p.record.deleted?.18:active?.85:.07+priority(p.record)/1800;c.strokeStyle=active?'#ffdf8a':color;c.lineWidth=active?1:.6;c.beginPath();c.moveTo(cx,cy);c.lineTo(p.x,p.y);c.stroke();
        c.globalAlpha=p.record.deleted?.3:.55+(p.depth+1)*.2;
        const glow=c.createRadialGradient(p.x,p.y,0,p.x,p.y,p.size*5);glow.addColorStop(0,color+'bc');glow.addColorStop(.25,color+'40');glow.addColorStop(1,color+'00');c.fillStyle=glow;c.beginPath();c.arc(p.x,p.y,p.size*5,0,Math.PI*2);c.fill();
        c.fillStyle=color;c.beginPath();c.arc(p.x,p.y,p.size,0,Math.PI*2);c.fill();c.fillStyle='#ffffff';c.beginPath();c.arc(p.x,p.y,p.size*.45,0,Math.PI*2);c.fill();
        if(active||pinned(p.record)){c.globalAlpha=active?1:.6;c.strokeStyle=color;c.lineWidth=1;c.beginPath();c.arc(p.x,p.y,p.size+5,0,Math.PI*2);c.stroke();}
      }
      c.globalAlpha=1;const halo=c.createRadialGradient(cx,cy,0,cx,cy,42);halo.addColorStop(0,'#fff5ce');halo.addColorStop(.14,'#ffe3a6');halo.addColorStop(.35,'#efc36f65');halo.addColorStop(1,'#e1a94e00');c.fillStyle=halo;c.beginPath();c.arc(cx,cy,42,0,Math.PI*2);c.fill();
      const selected=points.find(p=>p.record.itemId===selectedId);
      if(selected)positionPopover(selected);
      if(visible.length>800){c.font='11px system-ui';c.fillStyle='#9baabd';c.textAlign='left';c.fillText('星图展示当前排序前 800 条，文字列表可查看全部',16,80);}
    }
    function schedule(){if(!disposed&&view==='stars'&&!frame)frame=win.requestAnimationFrame(draw);}
    function resize(){const rect=canvas.getBoundingClientRect();width=rect.width;height=rect.height;if(!width||!height)return;const scale=Math.min(win.devicePixelRatio||1,2);canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);context?.setTransform(scale,0,0,scale,0,0);schedule();}
    const observer=win.ResizeObserver?new win.ResizeObserver(resize):null;observer?.observe(canvas);observer?.observe($('.memory-popover'));
    const hit=(x,y)=>points.filter(p=>Math.hypot(p.x-x,p.y-y)<Math.max(12,p.size+5)).sort((a,b)=>Math.hypot(a.x-x,a.y-y)-Math.hypot(b.x-x,b.y-y))[0];
    canvas.addEventListener('pointerdown',e=>{if(e.button!==0)return;pointer={id:e.pointerId,x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,moved:false};canvas.setPointerCapture?.(e.pointerId);});
    canvas.addEventListener('pointermove',e=>{const rect=canvas.getBoundingClientRect();if(pointer&&e.pointerId===pointer.id){if(Math.hypot(e.clientX-pointer.startX,e.clientY-pointer.startY)>4)pointer.moved=true;if(pointer.moved){angle+=(e.clientX-pointer.x)*.007;tilt=Math.max(-1.3,Math.min(1.3,tilt+(e.clientY-pointer.y)*.005));}pointer.x=e.clientX;pointer.y=e.clientY;schedule();}else{const p=hit(e.clientX-rect.left,e.clientY-rect.top);canvas.style.cursor=p?'pointer':'grab';canvas.title=p?(p.record.value?.text||'待合并记忆').slice(0,120):'';}});
    canvas.addEventListener('pointerup',e=>{if(!pointer||pointer.id!==e.pointerId)return;const rect=canvas.getBoundingClientRect();if(!pointer.moved){const p=hit(e.clientX-rect.left,e.clientY-rect.top);if(p)select(p.record.itemId);}pointer=null;canvas.releasePointerCapture?.(e.pointerId);});
    canvas.addEventListener('pointercancel',()=>{pointer=null;});canvas.addEventListener('lostpointercapture',()=>{pointer=null;});
    canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=Math.max(.45,Math.min(2.8,zoom*(e.deltaY<0?1.1:.9)));schedule();},{passive:false});
    canvas.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Enter'].includes(e.key)||!visible.length)return;e.preventDefault();const index=visible.findIndex(r=>r.itemId===selectedId);if(e.key==='Enter'){popoverOpen=true;$('.memory-popover').hidden=false;schedule();$('.memory-selected textarea')?.focus();return;}select(visible[(index+(e.key==='ArrowRight'?1:-1)+visible.length)%visible.length].itemId);});
    $('.memory-popover-close').addEventListener('click',closePopover);
    const escape=e=>{if(e.key!=='Escape')return;if(!characterMenu.hidden){e.preventDefault();closeCharacters();characterToggle.focus();}else if(view==='stars'&&popoverOpen){e.preventDefault();closePopover();}};host.addEventListener('keydown',escape);
    for(const button of host.querySelectorAll('[data-view]'))button.addEventListener('click',()=>setView(button.dataset.view));
    for(const selector of ['.memory-search','.memory-kind','.memory-state','.memory-sort'])$(selector).addEventListener(selector==='.memory-search'?'input':'change',()=>{page=0;render();});
    $('.memory-prev').addEventListener('click',()=>{page--;render();});$('.memory-next').addEventListener('click',()=>{page++;render();});
    $('.memory-zoom-in').addEventListener('click',()=>{zoom=Math.min(2.8,zoom*1.2);schedule();});$('.memory-zoom-out').addEventListener('click',()=>{zoom=Math.max(.45,zoom/1.2);schedule();});$('.memory-reset').addEventListener('click',()=>{angle=.15;tilt=-.14;zoom=1;schedule();});
    $('.memory-time-range').addEventListener('input',e=>{const value=Number(e.target.value);cutoff=value===maxDay?null:value;page=0;render();});
    const visibility=()=>{if(doc.hidden){win.cancelAnimationFrame(frame);frame=0;}else schedule();};doc.addEventListener('visibilitychange',visibility);
    setView('stars');
    return {openStars(){setView('stars');},update(next,metadata={}){setCharacters(metadata);records=next;const days=records.map(day);minDay=days.length?Math.min(...days):0;maxDay=days.length?Math.max(...days):0;const slider=$('.memory-time-range');slider.min=String(minDay);slider.max=String(maxDay);if(cutoff!==null)cutoff=Math.max(minDay,Math.min(maxDay,cutoff));slider.value=String(cutoff??maxDay);slider.disabled=minDay===maxDay;render();},close(){disposed=true;observer?.disconnect();win.cancelAnimationFrame(frame);host.removeEventListener('keydown',escape);doc.removeEventListener('pointerdown',outsideCharacters);doc.removeEventListener('visibilitychange',visibility);}};
  }
  function mountMemory(host,pet){
    host.innerHTML='<main class="chat-panel memory-panel"><header><h1>鱼的记忆</h1><button type="button" class="refresh-memory">刷新</button></header><p>每个人物的记忆独立保存，点击头像切换查看。候选与模型推断不会冒充用户确认。</p><section class="memory-system"><h2>原生记忆服务</h2><button type="button" class="sync-memory">立即处理待存记忆</button><p class="memory-sync-status"></p><details class="memory-model-settings"><summary>N.E.K.O. 记忆组件与整理模型</summary><p>组件在本机自动运行，默认复用当前聊天通道：DeepSeek 账号模式使用账号额度，也可设置独立 API 模型。整理会调用所选模型。DSH 工作任务不进入这套记忆。</p><label class="check-label"><input type="checkbox" class="memory-reuse-chat" checked>使用当前聊天通道整理记忆（账号 / API）</label><form class="memory-model-form"><fieldset class="memory-custom-model"><legend>独立记忆整理模型</legend><label>协议<select name="protocol"><option value="openai-compatible">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select></label><label>API 基础地址<input name="baseUrl" type="url" maxlength="2048"></label><label>模型<input name="model" maxlength="200"></label><label>超时（毫秒）<input name="requestTimeoutMs" type="number" min="1000" max="300000" value="60000"></label><label>新密钥<input name="apiKey" type="password" maxlength="16384" autocomplete="new-password" placeholder="留空保留已存密钥"></label></fieldset><button type="submit">保存并连接记忆组件</button><p class="memory-key-status"></p></form></details></section><p role="status" aria-live="polite"></p><section class="memory-items"></section><section class="memory-summaries"></section><details><summary>最近聊天记录</summary><div class="chat-history"></div></details></main>';
    const document=host.ownerDocument,status=host.querySelector('[role=status]'),items=host.querySelector('.memory-items'),summaries=host.querySelector('.memory-summaries'),history=host.querySelector('.chat-history');
    let generation=0,disposed=false,lastBackend,lastPhase,lastMemory,modelLoaded=false,explorer=null,selectedPersonaId='bigfish',viewReadOnly=false;const drafts=new Map(),rebaseDrafts=new Set();
    const syncStatus=host.querySelector('.memory-sync-status'),reuse=host.querySelector('.memory-reuse-chat'),modelForm=host.querySelector('.memory-model-form'),custom=host.querySelector('.memory-custom-model');
    const node=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;};
    const actionButton=(text,action)=>{const button=node('button',text);button.type='button';button.addEventListener('click',async()=>{if(button.disabled)return;button.disabled=true;button.setAttribute('aria-busy','true');try{await action();}catch{if(!disposed)status.textContent='操作未完成，请刷新后重试';}finally{if(!disposed){button.disabled=false;button.removeAttribute('aria-busy');}}});return button;};
    async function mutate(input){if(viewReadOnly)throw Error('此人物的记忆仅供查看');const owner=selectedPersonaId,result=await pet.call('chat-memory-action',{...input,personaId:owner});if(disposed||owner!==selectedPersonaId)return;if(result?.ok!==false&&input.id){if(['event-update','event-resolve','event-delete','event-restore'].includes(input.action))drafts.delete(input.id);else{rebaseDrafts.add(input.id);const draft=drafts.get(input.id);if(input.action==='event-priority'&&draft&&Number(draft.priority)===input.priority)delete draft.priority;}}await refresh();if(result?.ok===false)status.textContent=result.message||'操作未完成，仍使用原有设置';else status.textContent='已保存记忆，待处理内容会自动同步';}
    host.querySelector('.sync-memory').addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;button.setAttribute('aria-busy','true');status.textContent='正在处理记忆…';try{await mutate({action:'sync'});}catch{status.textContent='记忆处理未完成，记录已保留';}finally{if(!disposed){button.disabled=false;button.removeAttribute('aria-busy');}}});
    reuse.addEventListener('change',()=>{custom.disabled=reuse.checked;});custom.disabled=true;
    modelForm.addEventListener('submit',async event=>{
      event.preventDefault();const button=modelForm.querySelector('button');if(button.disabled)return;button.disabled=true;button.setAttribute('aria-busy','true');status.textContent='正在连接记忆组件…';const get=name=>modelForm.elements.namedItem(name);
      try{const secret=get('apiKey').value;await mutate({action:'configure-neko',enabled:true,useChatApi:reuse.checked,...(reuse.checked?{}:{protocol:get('protocol').value,baseUrl:get('baseUrl').value,model:get('model').value,requestTimeoutMs:Number(get('requestTimeoutMs').value),key:secret.trim()?{action:'replace',value:secret}:{action:'keep'}})});get('apiKey').value='';}
      catch{if(!disposed)status.textContent='记忆组件尚未就绪，请检查组件安装和模型设置';}finally{if(!disposed){button.disabled=false;button.removeAttribute('aria-busy');}}
    });
    function renderReplication(replication,model,metadata){
      host.querySelector('.memory-system').hidden=!replication||viewReadOnly;if(!replication)return;

      syncStatus.textContent='N.E.K.O.：'+(replication.providerStates.neko||'待连接')+'；待处理 '+replication.pending+' 条，冲突 '+replication.conflicts+' 条。'+(replication.error||'');
      if(model&&!modelLoaded){reuse.checked=model.useChatApi;custom.disabled=reuse.checked;for(const key of ['protocol','baseUrl','model','requestTimeoutMs'])if(model[key]!==undefined)modelForm.elements.namedItem(key).value=String(model[key]);modelLoaded=true;}
      host.querySelector('.memory-key-status').textContent=model?.route==='deepseek-account'?'记忆整理复用 DeepSeek 工作台账号与额度，无需独立 API Key':model?.hasKey?'独立记忆密钥已加密保存':'独立记忆密钥尚未保存';
      if(!explorer)explorer=memoryExplorer(items,renderRecord,(character,characters)=>{
        generation++;selectedPersonaId=character.id;viewReadOnly=character.readOnly===true;history.replaceChildren();summaries.replaceChildren();host.querySelector('.memory-system').hidden=true;
        host.querySelector('header h1').textContent='鱼的记忆';
        explorer.update([],{character,characters});void refresh();
      });
      explorer.update(replication.records,metadata);
    }
    function renderRecord(record){
        const card=node('article',undefined,'memory-card'),controls=node('div',undefined,'memory-controls'),revisionIds=record.heads.map(e=>e.eventId),input={id:record.itemId,revisionIds};
        card.dataset.memoryId=record.itemId;
        if(rebaseDrafts.delete(record.itemId)&&drafts.has(record.itemId))drafts.get(record.itemId).revisionIds=[...revisionIds];
        const at=record.createdAt||record.heads.map(e=>e.occurredAt).sort().at(-1);card.append(node('time',at?new Date(at).toLocaleString('zh-CN'):'时间未知','memory-record-time'));
        if(viewReadOnly){const value=record.value||record.previousValue,certainty=value?.certainty==='user-confirmed'?'用户已确认':value?.certainty==='inferred'?'模型推断':'待确认';card.append(node('p','独立存档 · '+certainty+' · 仅供查看','memory-source-badge'),node('pre',value?.text||'记忆内容不可用'),node('small','来源：'+(value?.evidenceRefs||[]).join('、')));return card;}
        if(record.deleted){card.append(node('p','已删除 · 旧记录不会自动恢复'));if(record.previousValue?.text)card.append(node('pre',record.previousValue.text));card.append(actionButton('显式恢复',()=>mutate({...input,action:'event-restore'})));return card;}
        if(record.conflict){card.append(node('p','这条记忆有不同修订，请选择或合并内容'));for(const head of record.heads)card.append(node('pre',head.value?.text||'删除修订'));const edit=node('textarea');edit.maxLength=30000;edit.setAttribute('aria-label','合并冲突内容');card.append(edit,actionButton('保存合并',()=>mutate({...input,action:'event-resolve',text:edit.value})));}
        else{
          const value=record.value;if(!value)return card;const edit=node('textarea'),draft=drafts.get(record.itemId);edit.value=draft?.text??value.text;edit.maxLength=30000;edit.setAttribute('aria-label','编辑记忆内容');
          const saveDraft=patch=>{const previous=drafts.get(record.itemId);drafts.set(record.itemId,{...previous,...patch,revisionIds:previous?.revisionIds||[...revisionIds]});};
          edit.addEventListener('input',()=>saveDraft({text:edit.value}));
          if(draft){input.revisionIds=draft.revisionIds;if(JSON.stringify(draft.revisionIds)!==JSON.stringify(revisionIds)){
            const latest=node('details'),label=node('summary','查看最新保存内容');latest.append(label,node('pre',value.text));
            card.append(node('p','这条记忆已有新修订，草稿已保留。核对最新内容后可继续编辑。'),latest,actionButton('保留草稿，按最新修订继续编辑',()=>{draft.revisionIds=[...revisionIds];return refresh();}));
          }}
          const source=record.itemId.startsWith('channel:bili:')?'B站生活经历':record.itemId.startsWith('channel:qq:')?'QQ对话经历':record.itemId.startsWith('lobby:')?'大厅共同经历':value.certainty==='user-confirmed'?'用户已确认':value.certainty==='inferred'?'模型推断 / 历史摘要':'待确认 / 历史经历';
          const lobbyRefs=(value.evidenceRefs||[]).filter(ref=>ref.startsWith('lobby-msg:')).length;
          const refs=[...(value.evidenceRefs||[]).filter(ref=>!ref.startsWith('lobby-msg:')),...(lobbyRefs?['大厅消息'+(lobbyRefs>1?' ×'+lobbyRefs:'')]:[])].join('、')||'来源缺失';
          card.dataset.kind=value.kind;
          const badge=node('p',({fact:'事实',preference:'偏好',episode:'经历',summary:'摘要 / 反思'}[value.kind]||'记忆')+' · '+source+' · '+(value.visibility==='private'?'私人':'给用户的日记'),'memory-source-badge');badge.dataset.kind=value.kind;
          const priorityBox=node('div',undefined,'memory-priority-controls'),priorityLabel=node('label','优先级 '),priority=node('input');priority.type='number';priority.min='0';priority.max='100';priority.step='1';priority.value=String(draft?.priority??value.priority??50);priority.setAttribute('aria-label','记忆优先级（0–100）');
          priority.addEventListener('input',()=>saveDraft({priority:priority.value}));priorityLabel.append(priority);
          const priorityInput=()=>({...input,revisionIds:drafts.get(record.itemId)?.revisionIds||revisionIds,action:'event-priority',priority:Number(priority.value),pinned:value.pinned===true});
          const savePriority=actionButton('保存优先级',async()=>{if(!priority.value.trim()||!priority.checkValidity()){status.textContent='请输入 0–100 的整数优先级';priority.focus();return;}await mutate(priorityInput());});savePriority.className='memory-save-priority';
          const pin=actionButton(value.pinned?'取消置顶':'置顶',()=>mutate({...priorityInput(),priority:value.priority??50,pinned:!value.pinned}));pin.className='memory-pin';pin.setAttribute('aria-pressed',String(!!value.pinned));
          priorityBox.append(priorityLabel,savePriority,pin);
          card.append(badge,priorityBox,edit,node('small','来源：'+refs));
          if(value.certainty!=='user-confirmed')controls.append(actionButton('确认',()=>mutate({...input,action:'event-confirm'})));
          controls.append(actionButton('保存更正',()=>mutate({...input,action:'event-update',text:edit.value})));
        }
        const forget=actionButton('删除记忆',()=>mutate({...input,action:'event-delete'}));forget.className='memory-forget';controls.append(forget);card.append(controls);return card;
    }
    async function refresh(){
      const token=++generation,owner=selectedPersonaId;status.textContent='正在读取…';
      try{
        const [memory,messages]=await Promise.all([pet.call('chat-memory-read',{personaId:owner}),pet.call('chat-history',{personaId:owner})]);
        if(disposed||token!==generation||owner!==selectedPersonaId)return;viewReadOnly=memory.readOnly===true;
        if(memory.character)host.querySelector('header h1').textContent='鱼的记忆';
        if(!memory.replication){explorer?.close();explorer=null;items.replaceChildren(node('h2','偏好与事实'));}summaries.replaceChildren(node('h2','旧版历史摘要'));summaries.hidden=!!memory.replication&&!memory.summaries.length;
        if(!memory.replication&&!memory.items.length)items.append(node('p','还没有记忆；聊天产生的候选会显示在这里。','empty-state'));
        for(const item of memory.replication?[]:memory.items){
          const card=node('article',undefined,'memory-card'),heading=node('p',item.confirmation==='confirmed'?'已确认':'待确认','memory-badge');
          const text=node('textarea');text.value=item.text;text.maxLength=500;text.setAttribute('aria-label',item.confirmation==='confirmed'?'编辑已确认记忆':'编辑候选记忆');
          const controls=node('div',undefined,'memory-controls');
          if(item.confirmation!=='confirmed')controls.append(actionButton('确认',()=>mutate({action:'confirm',id:item.id})));
          controls.append(actionButton('保存修改',()=>mutate({action:'update',id:item.id,text:text.value})),actionButton('删除',()=>mutate({action:'remove',id:item.id})));
          card.append(heading,text,node('small','来源消息：'+item.sourceMessageIds.join('、')),controls);items.append(card);
        }
        renderReplication(memory.replication,memory.memoryModel,memory);
        if(!memory.summaries.length)summaries.append(node('p','长会话超出近期上下文后才会生成带来源的摘要。','empty-state'));
        for(const summary of memory.summaries){
          const card=node('article',undefined,'memory-card'),sources=node('div',undefined,'summary-sources');
          const controls=node('div',undefined,'memory-controls');
          controls.append(actionButton('查看来源',async()=>{const rows=await pet.call('chat-memory-action',{action:'sources',id:summary.id});if(disposed||!card.isConnected)return;sources.replaceChildren(...rows.map(row=>node('pre',(row.role==='user'?'用户：':'角色：')+row.text)));}),actionButton('删除摘要',()=>mutate({action:'remove-summary',id:summary.id})));
          card.append(node('p',summary.text),node('small','自动摘录，不是已确认事实'),controls,sources);summaries.append(card);
        }
        history.replaceChildren(...messages.slice(-60).map(message=>node('p',(message.role==='user'?'你：':'角色：')+message.text,'history-message')));
        if(!messages.length)history.append(node('p','还没有聊天记录。'));status.textContent=memory.viewMessage||'当前使用 N.E.K.O. 记忆，已读取本角色存档';
      }catch{if(!disposed&&token===generation){if(explorer)explorer.update([]);else items.replaceChildren();summaries.replaceChildren();history.replaceChildren();host.querySelector('.memory-system').hidden=owner!=='bigfish';status.textContent='此人物的记忆读取失败，请刷新重试或切换人物。';}}
    }
    const off=pet.onState(state=>{const snapshot=state.mainChat;if(!snapshot)return;const backend=snapshot.backend,phase=snapshot.chat?.phase,memory=JSON.stringify(snapshot.memorySystem);const refreshNow=backend!==lastBackend||memory!==lastMemory||(['connecting','replying'].includes(lastPhase)&&!['connecting','replying'].includes(phase));lastBackend=backend;lastPhase=phase;lastMemory=memory;if(refreshNow)void refresh();});
    const offOpen=pet.onMemoryOpen?.(()=>explorer?.openStars());
    host.querySelector('.refresh-memory').addEventListener('click',()=>void refresh());void refresh();
    return ()=>{disposed=true;generation++;explorer?.close();offOpen?.();off?.();};
  }
  return Object.freeze({mountSettings,mountMemory});
});
