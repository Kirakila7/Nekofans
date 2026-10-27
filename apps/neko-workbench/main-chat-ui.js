(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.WorkbenchChatUI=api;})(globalThis,function(){
  'use strict';
  function mountSettings(host,pet){
    host.innerHTML='<main class="chat-panel"><h1>聊天 API 设置</h1><p>主角色独立聊天，任务继续从 DSH 工作台发起。</p><form class="api-form"><label>协议<select name="protocol"><option value="openai-compatible">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select></label><label>API 基础地址<input name="baseUrl" type="url" maxlength="2048" placeholder="https://example.com/v1"></label><label>模型<input name="model" type="text" maxlength="200" autocomplete="off"></label><div class="api-limits"><label>超时（毫秒）<input name="requestTimeoutMs" type="number" min="1000" max="300000" required></label><label>回复 Token 上限<input name="maxOutputTokens" type="number" min="1" max="32000" required></label></div><label>新密钥<input name="apiKey" type="password" maxlength="16384" autocomplete="new-password" placeholder="留空保留已存密钥"></label><label class="check-label"><input name="clearKey" type="checkbox">清除已保存密钥</label><p class="key-state"></p><p>保存后使用 Chat API，与可选本机 N.E.K.O. 连接互斥。密钥只保存在本机系统加密存储中。</p><p class="feature-status">原生语音：未接入，当前使用文字聊天。</p><button type="submit">保存并使用 Chat API</button><p role="status" aria-live="polite"></p></form><nav class="chat-settings-links"><button type="button" class="open-chat-memory">聊天记忆…</button><button type="button" class="open-local-neko">连接本机 N.E.K.O.（可选）…</button></nav></main>';
    const form=host.querySelector('form'),get=name=>form.elements.namedItem(name),status=host.querySelector('[role=status]'),saved=host.querySelector('.key-state'),button=form.querySelector('button');
    let loaded=false,disposed=false;
    function render(snapshot){
      if(disposed||!snapshot)return;
      if(snapshot.settings&&!loaded){for(const name of ['protocol','baseUrl','model','requestTimeoutMs','maxOutputTokens'])get(name).value=String(snapshot.settings[name]??'');loaded=true;}
      saved.textContent=(snapshot.hasKey?'密钥已加密保存':'尚未保存密钥')+(snapshot.secureStorageAvailable?'':' · 系统加密存储不可用');
      if(!loaded)status.textContent=snapshot.error||'正在装配聊天服务…';
    }
    host.querySelector('.open-chat-memory').addEventListener('click',()=>pet.call('chat-open-memory').catch(()=>{status.textContent='聊天记忆窗口未能打开';}));
    host.querySelector('.open-local-neko').addEventListener('click',()=>pet.call('chat-open-neko-settings').catch(()=>{status.textContent='本机连接设置未能打开';}));
    const off=pet.onState(state=>render(state.mainChat));
    pet.call('chat-settings-read').then(render,()=>{if(!disposed)status.textContent='聊天设置暂不可用';});
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(!loaded||button.disabled)return;button.disabled=true;status.textContent='正在保存…';
      const secret=get('apiKey').value;
      const key=get('clearKey').checked?{action:'clear'}:secret.trim()?{action:'replace',value:secret}:{action:'keep'};
      try{
        const result=await pet.call('chat-settings-save',{protocol:get('protocol').value,baseUrl:get('baseUrl').value,model:get('model').value,
          requestTimeoutMs:Number(get('requestTimeoutMs').value),maxOutputTokens:Number(get('maxOutputTokens').value),key});
        if(disposed)return;get('apiKey').value='';get('clearKey').checked=false;render(result);status.textContent='已保存，主角色现在使用 Chat API';
      }catch{if(!disposed)status.textContent='保存失败，请检查地址、模型和系统加密存储';}
      finally{if(!disposed)button.disabled=false;}
    });
    return ()=>{disposed=true;off?.();};
  }
  function mountMemory(host,pet){
    host.innerHTML='<main class="chat-panel memory-panel"><header><h1>聊天记忆</h1><button type="button" class="refresh-memory">刷新</button></header><p>候选记忆经你确认后才作为事实召回。自动摘要保留来源，原始聊天不会因删除记忆而删除。</p><p role="status" aria-live="polite"></p><section class="memory-items"></section><section class="memory-summaries"></section><details><summary>最近聊天记录</summary><div class="chat-history"></div></details></main>';
    const document=host.ownerDocument,status=host.querySelector('[role=status]'),items=host.querySelector('.memory-items'),summaries=host.querySelector('.memory-summaries'),history=host.querySelector('.chat-history');
    let generation=0,disposed=false,lastBackend,lastPhase;
    const node=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;};
    const actionButton=(text,action)=>{const button=node('button',text);button.type='button';button.addEventListener('click',async()=>{if(button.disabled)return;button.disabled=true;try{await action();}catch{if(!disposed)status.textContent='操作未完成，请刷新后重试';}finally{if(!disposed)button.disabled=false;}});return button;};
    async function mutate(input){await pet.call('chat-memory-action',input);await refresh();}
    async function refresh(){
      const token=++generation;status.textContent='正在读取…';
      try{
        const [memory,messages]=await Promise.all([pet.call('chat-memory-read'),pet.call('chat-history')]);
        if(disposed||token!==generation)return;items.replaceChildren(node('h2','偏好与事实'));summaries.replaceChildren(node('h2','自动摘要'));
        if(!memory.items.length)items.append(node('p','还没有记忆；聊天产生的候选会显示在这里。','empty-state'));
        for(const item of memory.items){
          const card=node('article',undefined,'memory-card'),heading=node('p',item.confirmation==='confirmed'?'已确认':'待确认','memory-badge');
          const text=node('textarea');text.value=item.text;text.maxLength=500;text.setAttribute('aria-label',item.confirmation==='confirmed'?'编辑已确认记忆':'编辑候选记忆');
          const controls=node('div',undefined,'memory-controls');
          if(item.confirmation!=='confirmed')controls.append(actionButton('确认',()=>mutate({action:'confirm',id:item.id})));
          controls.append(actionButton('保存修改',()=>mutate({action:'update',id:item.id,text:text.value})),actionButton('删除',()=>mutate({action:'remove',id:item.id})));
          card.append(heading,text,node('small','来源消息：'+item.sourceMessageIds.join('、')),controls);items.append(card);
        }
        if(!memory.summaries.length)summaries.append(node('p','长会话超出近期上下文后才会生成带来源的摘要。','empty-state'));
        for(const summary of memory.summaries){
          const card=node('article',undefined,'memory-card'),sources=node('div',undefined,'summary-sources');
          const controls=node('div',undefined,'memory-controls');
          controls.append(actionButton('查看来源',async()=>{const rows=await pet.call('chat-memory-action',{action:'sources',id:summary.id});if(disposed||!card.isConnected)return;sources.replaceChildren(...rows.map(row=>node('pre',(row.role==='user'?'用户：':'角色：')+row.text)));}),actionButton('删除摘要',()=>mutate({action:'remove-summary',id:summary.id})));
          card.append(node('p',summary.text),node('small','自动摘录，不是已确认事实'),controls,sources);summaries.append(card);
        }
        history.replaceChildren(...messages.slice(-60).map(message=>node('p',(message.role==='user'?'你：':'角色：')+message.text,'history-message')));
        if(!messages.length)history.append(node('p','还没有聊天记录。'));status.textContent='已读取本角色的轻量记忆';
      }catch{if(!disposed&&token===generation){items.replaceChildren();summaries.replaceChildren();history.replaceChildren();status.textContent='请先使用聊天 API 模式；本机 N.E.K.O. 的记忆在原界面管理。';}}
    }
    const off=pet.onState(state=>{const snapshot=state.mainChat;if(!snapshot)return;const backend=snapshot.backend,phase=snapshot.chat?.phase;const refreshNow=backend!==lastBackend||(['connecting','replying'].includes(lastPhase)&&!['connecting','replying'].includes(phase));lastBackend=backend;lastPhase=phase;if(refreshNow)void refresh();});
    host.querySelector('.refresh-memory').addEventListener('click',()=>void refresh());void refresh();
    return ()=>{disposed=true;generation++;off?.();};
  }
  return Object.freeze({mountSettings,mountMemory});
});
