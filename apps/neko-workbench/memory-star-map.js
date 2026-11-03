(function(root){
  'use strict';
  const kinds={episode:'经历',fact:'事实',reflection:'反思',persona:'人格'};
  const colors={episode:'#a9dbed',fact:'#b9e9ff',reflection:'#c3a7f4',persona:'#ffd789'};
  const statuses={'candidate':'待确认','inferred':'推断','user-confirmed':'用户已确认',stored:'已存储',absorbed:'已吸收',archived:'已归档',pending:'待确认',confirmed:'已确认',promoted:'已晋升',merged:'已合并',denied:'已否定',rejected:'已否定',protected:'角色设定',promote_blocked:'晋升待处理'};
  const relations={'extracted-from':'提取','derived-from':'派生','synthesized-from':'反思来源','promoted-from':'晋升 / 合并','corrected-by':'纠正'};
  const hash=s=>{let h=2166136261;for(const c of s)h=Math.imul(h^c.charCodeAt(0),16777619);h=Math.imul(h^(h>>>16),0x7feb352d);h=Math.imul(h^(h>>>15),0x846ca68b);return (h^(h>>>16))>>>0;};
  const list=value=>Array.isArray(value)?value:[];

  function project(memory){
    const live=memory.graph?.available===true, records=list(memory.replication?.records), nodes=new Map(), blocked=new Set();
    const byItem=new Map(records.map(r=>[r.itemId,r]));
    for(const node of live?list(memory.graph.nodes):[]){
      if(!node||typeof node.id!=='string'||typeof node.text!=='string'||!kinds[node.kind])continue;
      const record=byItem.get(node.management?.id);
      if(record?.deleted||record?.conflict){blocked.add(node.id);continue;}
      nodes.set(node.id,{...node,sourceRefs:list(node.sourceRefs),...(record?.value?{certainty:record.value.certainty}:{}),
        ...(record?{management:{id:record.itemId,revisionIds:record.heads.map(e=>e.eventId)}}:{})});
    }
    for(const record of records){
      if(record.deleted||record.conflict||!record.value?.text)continue;
      const value=record.value,native=value.nativeRef;
      // A live native snapshot is authoritative; don't resurrect a filtered native row.
      if(live&&native)continue;
      const kind=native?.nativeStatus==='reflection'?'reflection':native?'fact':['episode','summary'].includes(value.kind)?'episode':'fact';
      const id=native?kind+':'+native.id:'event:'+record.itemId;
      if(nodes.has(id))continue;
      nodes.set(id,{id,kind,text:value.text,certainty:value.certainty,status:value.certainty,
        occurredAt:record.heads[0]?.occurredAt,management:{id:record.itemId,revisionIds:record.heads.map(e=>e.eventId)},
        sourceRefs:list(value.evidenceRefs).map(ref=>({id:ref,kind:ref.startsWith('native-fact:')?'fact':'message',
          ...(ref.startsWith('native-fact:')?{nodeId:'fact:'+ref.slice(12)}:{})}))});
    }
    const edges=new Map();
    function edge(e){if(!e||!nodes.has(e.source)||!nodes.has(e.target)||e.source===e.target||blocked.has(e.source)||blocked.has(e.target))return;edges.set(e.source+'\0'+e.target+'\0'+e.kind,e);}
    for(const e of live?list(memory.graph.edges):[])edge(e);
    if(!live)for(const n of nodes.values())for(const ref of n.sourceRefs)if(ref.nodeId)edge({source:ref.nodeId,target:n.id,kind:n.kind==='reflection'?'synthesized-from':'derived-from'});
    const maintenance=records.filter(r=>r.deleted||r.conflict).map(r=>({id:'revision:'+r.itemId,kind:'fact',text:'',
      status:r.deleted?'deleted':'conflict',maintenance:true,deleted:r.deleted,conflict:r.conflict,
      management:{id:r.itemId,revisionIds:r.heads.map(e=>e.eventId)},sourceRefs:[],
      revisions:r.conflict?r.heads.map(e=>({id:e.eventId,text:e.value?.text||'删除修订'})):[]}));
    return {nodes:[...nodes.values()],edges:[...edges.values()],maintenance,live};
  }

  // Seeded positions stay fixed across refreshes. Layered distances describe
  // memory types; only persisted provenance establishes relationships.
  function layout(graph){
    const positioned=new Map();
    for(const node of graph.nodes){
      const h=hash(node.id),a=(h/4294967296)*Math.PI*2,z=((hash(node.id+'z')/4294967296)-.5)*1.5;
      const radius={persona:.26,reflection:.48,fact:.76,episode:.96}[node.kind]*(.72+(hash(node.id+'r')%1000)/1800);
      positioned.set(node.id,{node,x:Math.cos(a)*radius,y:Math.sin(a)*radius*.78,z:z*radius});
    }
    return positioned;
  }

  function mount(host,pet){
    const doc=host.ownerDocument,win=doc.defaultView;
    host.innerHTML=`<main class="memory-universe">
      <canvas class="memory-space" tabindex="0" role="application" aria-label="记忆星图；拖动旋转，滚轮缩放；方向键选择星点，回车查看，Escape 关闭详情"></canvas>
      <header class="star-header"><div><span class="star-eyebrow">N.E.K.O.</span><h1>记忆星图</h1></div>
        <div class="star-tools"><button class="star-rotate" type="button" aria-pressed="false" aria-label="自动旋转">↻</button><button class="star-home" type="button" aria-label="重置视角">⌖</button><button class="refresh-memory" type="button" aria-label="刷新记忆">⟳</button><button class="star-settings-toggle" type="button" aria-label="记忆设置" aria-expanded="false">⚙</button></div></header>
      <nav class="star-filters" aria-label="记忆类型"><button type="button" data-kind="all" aria-pressed="true">全部</button>${Object.entries(kinds).map(([kind,title])=>`<button type="button" data-kind="${kind}" aria-pressed="false"><i style="--star-color:${colors[kind]}"></i>${title}</button>`).join('')}</nav>
      <p class="star-empty" hidden></p>
      <aside class="star-detail" hidden aria-label="记忆详情"></aside>
      <aside class="star-settings" hidden aria-label="记忆设置"><header><h2>记忆设置</h2><button type="button" class="star-settings-close" aria-label="关闭设置">×</button></header>
        <section class="memory-system"><button type="button" class="sync-memory">处理待存记忆</button><p class="memory-sync-status"></p>
        <details class="memory-model-settings"><summary>整理模型</summary><label class="check-label"><input type="checkbox" class="memory-reuse-chat" checked>使用聊天 API</label>
          <form class="memory-model-form"><fieldset class="memory-custom-model"><legend>独立整理模型</legend><label>协议<select name="protocol"><option value="openai-compatible">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select></label><label>API 地址<input name="baseUrl" type="url" maxlength="2048"></label><label>模型<input name="model" maxlength="200"></label><label>超时（毫秒）<input name="requestTimeoutMs" type="number" min="1000" max="300000" value="60000"></label><label>新密钥<input name="apiKey" type="password" autocomplete="new-password" placeholder="留空保留"></label></fieldset><button type="submit">保存并连接</button><p class="memory-key-status"></p></form></details><label class="check-label"><input type="checkbox" class="star-maintenance-toggle">显示已删除 / 冲突星点</label></section></aside>
      <footer class="star-footer"><span class="star-count"></span><span class="star-hint">拖动旋转 · 滚轮缩放 · 点击星点</span><span role="status" aria-live="polite"></span></footer>
    </main>`;
    const shell=host.firstElementChild,canvas=host.querySelector('canvas'),ctx=canvas.getContext('2d'),detail=host.querySelector('.star-detail');
    const status=host.querySelector('[role=status]'),empty=host.querySelector('.star-empty'),count=host.querySelector('.star-count'),settings=host.querySelector('.star-settings');
    const form=host.querySelector('.memory-model-form'),reuse=host.querySelector('.memory-reuse-chat'),custom=host.querySelector('.memory-custom-model');custom.disabled=true;
    let graph={nodes:[],edges:[],live:false},positions=new Map(),selected=null,selectedVersion='',filter='all',disposed=false,generation=0,frame=0,width=0,height=0;
    let yaw=.23,pitch=-.12,zoom=1,auto=false,previousTime=0,projected=[],drag=null,hover=null,modelLoaded=false,lastState='',sourcesGeneration=0,showMaintenance=false;
    const allNodes=()=>[...graph.nodes,...(showMaintenance?list(graph.maintenance):[])];
    const drafts=new Map(),listeners=[];
    const reduced=win.matchMedia?.('(prefers-reduced-motion: reduce)');
    const el=(tag,text,cls)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
    const on=(target,name,fn,options)=>{target.addEventListener(name,fn,options);listeners.push(()=>target.removeEventListener(name,fn,options));};
    const button=(label,fn,cls)=>{const b=el('button',label,cls);b.type='button';b.addEventListener('click',fn);return b;};
    function requestDraw(){if(!disposed&&!frame)frame=win.requestAnimationFrame(draw);}
    function resize(){const r=canvas.getBoundingClientRect(),dpr=Math.min(win.devicePixelRatio||1,2);width=r.width;height=r.height;canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);ctx?.setTransform(dpr,0,0,dpr,0,0);requestDraw();}
    const observer=new win.ResizeObserver(resize);observer.observe(canvas);
    function screen(point){
      const x=point.x*Math.cos(yaw)+point.z*Math.sin(yaw),z=-point.x*Math.sin(yaw)+point.z*Math.cos(yaw),y=point.y*Math.cos(pitch)-z*Math.sin(pitch),depth=point.y*Math.sin(pitch)+z*Math.cos(pitch);
      const scale=Math.min(width,height)*.37*zoom*(2.9/(2.9+depth));
      return {x:width*.5+x*scale,y:height*.52+y*scale,depth,scale};
    }
    function glow(x,y,r,color,alpha=1){
      const gradient=ctx.createRadialGradient(x,y,0,x,y,r*6);gradient.addColorStop(0,color);gradient.addColorStop(.15,color+'aa');gradient.addColorStop(.42,color+'24');gradient.addColorStop(1,color+'00');
      ctx.globalAlpha=alpha;ctx.fillStyle=gradient;ctx.beginPath();ctx.arc(x,y,r*6,0,Math.PI*2);ctx.fill();ctx.fillStyle='#f4fbff';ctx.beginPath();ctx.arc(x,y,Math.max(1,r*.65),0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;
    }
    function draw(time){
      frame=0;if(disposed||!ctx||!width||!height)return;
      if(auto&&!reduced?.matches&&!doc.hidden){yaw+=Math.min(time-previousTime||0,40)*.000055;}previousTime=time;
      ctx.clearRect(0,0,width,height);ctx.fillStyle='#080b12';ctx.fillRect(0,0,width,height);
      const haze=ctx.createRadialGradient(width*.5,height*.52,0,width*.5,height*.52,Math.min(width,height)*.55);haze.addColorStop(0,'#6a441419');haze.addColorStop(.4,'#382d2112');haze.addColorStop(1,'#080b1200');ctx.fillStyle=haze;ctx.fillRect(0,0,width,height);
      const shown=allNodes().filter(n=>filter==='all'||n.kind===filter),allowed=new Set(shown.map(n=>n.id));
      projected=shown.map(node=>({...screen(positions.get(node.id)),node})).sort((a,b)=>b.depth-a.depth);
      const points=new Map(projected.map(p=>[p.node.id,p])),center={x:width*.5,y:height*.52};
      // Faint ownership spokes: every rendered record belongs to this main persona.
      ctx.lineWidth=.55;ctx.strokeStyle='#d8b56a16';ctx.beginPath();for(const p of projected){ctx.moveTo(center.x,center.y);ctx.lineTo(p.x,p.y);}ctx.stroke();
      const connected=new Set(selected?[selected]:[]);
      for(const edge of graph.edges){if(!allowed.has(edge.source)||!allowed.has(edge.target))continue;const a=points.get(edge.source),b=points.get(edge.target),active=edge.source===selected||edge.target===selected;
        if(active){connected.add(edge.source);connected.add(edge.target);}ctx.strokeStyle=active?'#eacb8cbb':'#a9c8df2d';ctx.lineWidth=active?1.4:.65;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}
      for(const p of projected){const active=p.node.id===selected,dim=selected&&!connected.has(p.node.id);glow(p.x,p.y,Math.min(5,Math.max(1.7,(p.node.kind==='persona'?3.4:2.5)*(p.scale/250))),p.node.maintenance?'#748398':colors[p.node.kind],dim?.28:1);
        if(active||p.node.id===hover){ctx.strokeStyle=active?'#ffe2a4':'#bcdbef99';ctx.lineWidth=1;ctx.beginPath();ctx.arc(p.x,p.y,10,0,Math.PI*2);ctx.stroke();}}
      // The core denotes the owning agent; it is never counted as a memory.
      if(projected.length)glow(center.x,center.y,6.2,'#ffd789',.9);
      if(auto&&!reduced?.matches&&!doc.hidden)requestDraw();
    }
    function hit(x,y){return projected.filter(p=>Math.hypot(p.x-x,p.y-y)<=Math.max(12,6*zoom)).sort((a,b)=>Math.hypot(a.x-x,a.y-y)-Math.hypot(b.x-x,b.y-y)||a.depth-b.depth)[0]?.node.id||null;}
    function closeDetail(){selected=null;selectedVersion='';sourcesGeneration++;detail.hidden=true;detail.replaceChildren();requestDraw();}
    function select(id){
      const node=allNodes().find(n=>n.id===id);if(!node)return closeDetail();
      if(filter!=='all'&&node.kind!==filter){filter='all';for(const b of host.querySelectorAll('[data-kind]'))b.setAttribute('aria-pressed',String(b.dataset.kind==='all'));}
      selected=id;selectedVersion=JSON.stringify(node);auto=false;settings.hidden=true;host.querySelector('.star-settings-toggle').setAttribute('aria-expanded','false');host.querySelector('.star-rotate').setAttribute('aria-pressed','false');
      const token=++sourcesGeneration;detail.replaceChildren();detail.hidden=false;
      const header=el('header'),heading=el('h2',kinds[node.kind]);header.append(heading,button('×',closeDetail,'star-detail-close'));header.lastChild.setAttribute('aria-label','关闭记忆详情');detail.append(header);
      const badges=el('div',undefined,'star-badges');badges.append(el('span',node.deleted?'已删除':node.conflict?'修订冲突':statuses[node.status]||'状态未知'));if(node.suppressed)badges.append(el('span','暂缓主动提及'));
      if(node.certainty&&node.certainty!==node.status)badges.append(el('span',statuses[node.certainty]||node.certainty));detail.append(badges,el('p',node.text,'star-memory-text'));
      if(node.occurredAt){const when=new Date(node.occurredAt);if(Number.isFinite(when.getTime()))detail.append(el('time',when.toLocaleString('zh-CN',{hour12:false})));}
      if(node.deleted)detail.append(actionButton('显式恢复',()=>mutate({...node.management,action:'event-restore'})));
      else if(node.conflict){
        for(const revision of node.revisions)detail.append(el('pre',revision.text,'star-memory-text'));
        const edit=el('textarea');edit.setAttribute('aria-label','合并冲突内容');edit.maxLength=30000;const draft=drafts.get(node.id);edit.value=draft?.text||'';
        edit.addEventListener('input',()=>drafts.set(node.id,{text:edit.value,revisionIds:[...node.management.revisionIds]}));
        detail.append(edit,actionButton('保存合并',()=>mutate({...node.management,revisionIds:draft?.revisionIds||node.management.revisionIds,action:'event-resolve',text:edit.value})));
      }
      else if(node.management){
        const details=el('details',undefined,'star-edit');details.append(el('summary','编辑'));const edit=el('textarea');edit.setAttribute('aria-label','编辑记忆内容');edit.maxLength=30000;
        const draft=drafts.get(node.id);edit.value=draft?.text??node.text;edit.addEventListener('input',()=>drafts.set(node.id,{text:edit.value,revisionIds:[...node.management.revisionIds]}));details.append(edit);
        if(draft&&JSON.stringify(draft.revisionIds)!==JSON.stringify(node.management.revisionIds))details.append(el('small','记忆已更新；草稿保留，请核对。'));
        const input={id:node.management.id,revisionIds:draft?.revisionIds||node.management.revisionIds};
        const actions=el('div',undefined,'star-actions');if(node.certainty!=='user-confirmed')actions.append(actionButton('确认',()=>mutate({...input,action:'event-confirm'})));
        actions.append(actionButton('保存更正',()=>mutate({...input,action:'event-update',text:edit.value})),actionButton('删除',()=>mutate({...input,action:'event-delete'})));details.append(actions);detail.append(details);
      }
      const sources=el('section',undefined,'star-sources');sources.append(el('h3','来源与关系'));
      const connected=graph.edges.filter(e=>e.source===id||e.target===id);const seen=new Set();
      for(const edge of connected){const other=graph.nodes.find(n=>n.id===(edge.source===id?edge.target:edge.source));if(!other)continue;seen.add(other.id);
        sources.append(button((edge.target===id?'← ':'→ ')+(relations[edge.kind]||'来源')+' · '+kinds[other.kind],()=>select(other.id),'star-source-link'));}
      for(const ref of list(node.sourceRefs)){if(ref.nodeId&&seen.has(ref.nodeId))continue;const target=graph.nodes.find(n=>n.id===ref.nodeId);
        if(target)sources.append(button('← '+kinds[target.kind],()=>select(target.id),'star-source-link'));
        else sources.append(el('small',ref.id,'star-source-id'));}
      if(!connected.length&&!list(node.sourceRefs).length)sources.append(el('small',node.source==='character_card'?'角色设定':node.source==='manual'?'手动记录':'未记录来源'));
      detail.append(sources);
      if(node.management&&list(node.sourceRefs).some(r=>r.kind==='message')){
        const reveal=button('查看原始消息',async()=>{reveal.disabled=true;try{const rows=await pet.call('chat-memory-action',{action:'event-sources',id:node.management.id});
          if(disposed||selected!==id||token!==sourcesGeneration)return;
          for(const row of list(rows)){const quote=el('blockquote');quote.append(el('small',row.role==='user'?'你':'角色'),el('p',row.text));sources.append(quote);}if(!rows.length)sources.append(el('small','原始消息暂不可用'));
        }catch{if(!disposed&&selected===id&&token===sourcesGeneration)sources.append(el('small','来源读取未完成'));}finally{if(reveal.isConnected)reveal.disabled=false;}},'star-source-link');sources.append(reveal);
      }
      requestDraw();
    }
    function actionButton(label,action){const b=button(label,async()=>{if(b.disabled)return;b.disabled=true;try{await action();}catch{if(!disposed)status.textContent='操作未完成，请刷新';}finally{if(!disposed)b.disabled=false;}});return b;}
    async function mutate(input){const result=await pet.call('chat-memory-action',input);if(disposed)return;if(result?.ok===false){status.textContent=result.message||'操作未完成';return;}if(selected)drafts.delete(selected);await refresh();}
    async function refresh(){
      const token=++generation;status.textContent='读取中';try{const memory=await pet.call('chat-memory-read');if(disposed||token!==generation)return;
        graph=project(memory);positions=layout({nodes:[...graph.nodes,...graph.maintenance]});count.textContent=graph.nodes.length+' 颗记忆 · '+graph.edges.length+' 条关系';status.textContent=graph.live?'':'原生视图暂不可用 · 仅显示同步记录';
        empty.hidden=allNodes().length>0;empty.textContent=graph.live?'还没有记忆':'原生记忆暂不可用';
        const replication=memory.replication;host.querySelector('.memory-sync-status').textContent=(replication?.providerStates?.neko||'待连接')+' · 待处理 '+(replication?.pending||0)+(replication?.error?' · '+replication.error:'');
        const model=memory.memoryModel;if(model&&!modelLoaded){reuse.checked=model.useChatApi;custom.disabled=reuse.checked;for(const k of ['protocol','baseUrl','model','requestTimeoutMs'])if(model[k]!==undefined)form.elements.namedItem(k).value=String(model[k]);modelLoaded=true;}
        host.querySelector('.memory-key-status').textContent=model?.hasKey?'密钥已加密保存':'';
        if(selected){const next=allNodes().find(n=>n.id===selected);if(!next)closeDetail();else if(JSON.stringify(next)!==selectedVersion)select(selected);}requestDraw();
      }catch{if(!disposed&&token===generation){graph={nodes:[],edges:[],live:false};positions.clear();closeDetail();count.textContent='';empty.hidden=false;empty.textContent='记忆暂不可用';status.textContent='请检查主聊天与记忆设置';requestDraw();}}
    }
    on(canvas,'pointerdown',e=>{if(e.button!==0)return;auto=false;host.querySelector('.star-rotate').setAttribute('aria-pressed','false');drag={id:e.pointerId,x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,moved:false};canvas.setPointerCapture?.(e.pointerId);canvas.focus();});
    on(canvas,'pointermove',e=>{const r=canvas.getBoundingClientRect();if(drag&&e.pointerId===drag.id){if(Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY)>5)drag.moved=true;
      if(drag.moved){yaw+=(e.clientX-drag.x)*.006;pitch=Math.max(-1.3,Math.min(1.3,pitch+(e.clientY-drag.y)*.006));}drag.x=e.clientX;drag.y=e.clientY;
      }else{hover=hit(e.clientX-r.left,e.clientY-r.top);canvas.style.cursor=hover?'pointer':'grab';}requestDraw();});
    on(canvas,'pointerup',e=>{if(!drag||e.pointerId!==drag.id)return;const moved=drag.moved;drag=null;if(canvas.hasPointerCapture?.(e.pointerId))canvas.releasePointerCapture(e.pointerId);if(!moved){const r=canvas.getBoundingClientRect(),id=hit(e.clientX-r.left,e.clientY-r.top);if(id)select(id);else closeDetail();}});
    on(canvas,'pointercancel',()=>{drag=null;});on(canvas,'lostpointercapture',()=>{drag=null;});on(canvas,'pointerleave',()=>{hover=null;requestDraw();});
    on(canvas,'wheel',e=>{e.preventDefault();zoom=Math.max(.4,Math.min(3,zoom*Math.exp(-e.deltaY*.001)));requestDraw();},{passive:false});
    on(canvas,'keydown',e=>{if(['ArrowRight','ArrowDown','ArrowLeft','ArrowUp'].includes(e.key)){e.preventDefault();const ns=allNodes().filter(n=>filter==='all'||n.kind===filter);if(!ns.length)return;const step=['ArrowLeft','ArrowUp'].includes(e.key)?-1:1,i=ns.findIndex(n=>n.id===(hover||selected));hover=ns[(i+step+ns.length)%ns.length].id;requestDraw();}else if(e.key==='Enter'||e.key===' '){e.preventDefault();const id=hover||allNodes().find(n=>filter==='all'||n.kind===filter)?.id;if(id)select(id);}else if(e.key==='+'||e.key==='='){zoom=Math.min(3,zoom*1.15);requestDraw();}else if(e.key==='-'){zoom=Math.max(.4,zoom/1.15);requestDraw();}});
    on(shell,'keydown',e=>{if(e.key==='Escape'){closeDetail();settings.hidden=true;host.querySelector('.star-settings-toggle').setAttribute('aria-expanded','false');canvas.focus();}});
    on(host.querySelector('.star-home'),'click',()=>{yaw=.23;pitch=-.12;zoom=1;requestDraw();});
    on(host.querySelector('.star-rotate'),'click',e=>{auto=!auto;e.currentTarget.setAttribute('aria-pressed',String(auto));previousTime=0;requestDraw();});
    on(host.querySelector('.refresh-memory'),'click',refresh);
    for(const b of host.querySelectorAll('[data-kind]'))on(b,'click',()=>{filter=b.dataset.kind;for(const other of host.querySelectorAll('[data-kind]'))other.setAttribute('aria-pressed',String(other===b));closeDetail();hover=null;requestDraw();});
    on(host.querySelector('.star-settings-toggle'),'click',e=>{settings.hidden=!settings.hidden;e.currentTarget.setAttribute('aria-expanded',String(!settings.hidden));if(!settings.hidden)closeDetail();});
    on(host.querySelector('.star-settings-close'),'click',()=>{settings.hidden=true;host.querySelector('.star-settings-toggle').setAttribute('aria-expanded','false');});
    on(host.querySelector('.sync-memory'),'click',async e=>{const b=e.currentTarget;if(b.disabled)return;b.disabled=true;try{await mutate({action:'sync'});}catch{status.textContent='处理未完成，记录已保留';}finally{if(!disposed)b.disabled=false;}});
    on(reuse,'change',()=>{custom.disabled=reuse.checked;});
    on(host.querySelector('.star-maintenance-toggle'),'change',e=>{showMaintenance=e.target.checked;closeDetail();empty.hidden=allNodes().length>0;requestDraw();});
    on(form,'submit',async e=>{e.preventDefault();const b=form.querySelector('button');if(b.disabled)return;b.disabled=true;const get=n=>form.elements.namedItem(n);try{const secret=get('apiKey').value;
      await mutate({action:'configure-neko',enabled:true,useChatApi:reuse.checked,...(reuse.checked?{}:{protocol:get('protocol').value,baseUrl:get('baseUrl').value,model:get('model').value,requestTimeoutMs:Number(get('requestTimeoutMs').value),key:secret.trim()?{action:'replace',value:secret}:{action:'keep'}})});get('apiKey').value='';
      }catch{if(!disposed)status.textContent='记忆模型未能连接';}finally{if(!disposed)b.disabled=false;}});
    on(doc,'visibilitychange',()=>{previousTime=0;if(!doc.hidden)requestDraw();});
    const off=pet.onState(state=>{const s=state.mainChat;if(!s)return;const key=JSON.stringify([s.backend,s.chat?.phase,s.memorySystem]);if(key!==lastState){lastState=key;void refresh();}});
    // Periodic reads expose native background changes that don't alter hub revisions.
    const timer=win.setInterval(()=>{if(!doc.hidden&&!disposed)void refresh();},15000);
    resize();void refresh();
    return ()=>{disposed=true;generation++;sourcesGeneration++;off?.();observer.disconnect();win.clearInterval(timer);if(frame)win.cancelAnimationFrame(frame);for(const remove of listeners)remove();detail.replaceChildren();};
  }
  const api=Object.freeze({mount,project,layout});if(typeof module==='object'&&module.exports)module.exports=api;else root.WorkbenchMemoryGraph=api;
})(typeof window==='object'?window:globalThis);
