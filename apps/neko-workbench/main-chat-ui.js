(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.WorkbenchChatUI=api;})(globalThis,function(){
  'use strict';
  function mountSettings(host,pet){
    host.innerHTML='<main class="chat-panel"><h1>聊天 API 设置</h1><p>主角色独立聊天，任务继续从 DSH 工作台发起。</p><form class="api-form"><div class="api-presets"><button type="button" class="deepseek-preset" disabled>使用 DeepSeek 预设</button><p>DeepSeek 聊天使用独立的 API Key 和 API 账户额度，与工作台登录的 DSH 账号及余额分开；发送消息会消耗 API 额度。</p></div><label>协议<select name="protocol"><option value="openai-compatible">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select></label><label>API 基础地址<input name="baseUrl" type="url" maxlength="2048" placeholder="https://example.com/v1"></label><label>模型<input name="model" type="text" maxlength="200" autocomplete="off"></label><div class="api-limits"><label>超时（毫秒）<input name="requestTimeoutMs" type="number" min="1000" max="300000" required></label><label>回复 Token 上限<input name="maxOutputTokens" type="number" min="1" max="32000" required></label></div><label>新密钥<input name="apiKey" type="password" maxlength="16384" autocomplete="new-password" placeholder="留空保留已存密钥"></label><label class="check-label"><input name="clearKey" type="checkbox">清除已保存密钥</label><p class="key-state"></p><p>保存后使用 Chat API，与可选本机 N.E.K.O. 连接互斥。密钥只保存在本机系统加密存储中。</p><p class="feature-status">原生语音：未接入，当前使用文字聊天。</p><button type="submit">保存并使用 Chat API</button><p role="status" aria-live="polite"></p></form><nav class="chat-settings-links"><button type="button" class="open-chat-memory">聊天记忆…</button><button type="button" class="open-local-neko">连接本机 N.E.K.O.（可选）…</button></nav></main>';
    const voice=host.querySelector('.feature-status');voice.innerHTML='<label class="check-label"><input type="checkbox" class="tts-enabled" disabled>使用 N.E.K.O. 免费语音朗读主角色回复</label><p>回复文字会发送至 N.E.K.O. 语音服务，服务可能有使用限制。</p><button type="button" class="tts-stop">停止朗读</button><span class="tts-status" role="status"></span>';
    const enabled=voice.querySelector('.tts-enabled'),voiceStatus=voice.querySelector('.tts-status');
    function renderVoice(state){if(disposed||!state)return;enabled.checked=state.preferences?.ttsEnabled===true;enabled.disabled=false;}
    enabled.addEventListener('change',async()=>{enabled.disabled=true;try{await pet.call('tts-settings',{enabled:enabled.checked});voiceStatus.textContent='语音设置已保存';}catch{enabled.checked=!enabled.checked;voiceStatus.textContent='语音设置保存失败';}finally{if(!disposed)enabled.disabled=false;}});
    voice.querySelector('.tts-stop').addEventListener('click',()=>pet.call('tts-stop').catch(()=>{voiceStatus.textContent='无法停止语音';}));
    pet.call('state').then(renderVoice,()=>{if(!disposed)voiceStatus.textContent='语音设置暂不可用';});
    const form=host.querySelector('form'),get=name=>form.elements.namedItem(name),status=host.querySelector('.api-form > [role=status]'),saved=host.querySelector('.key-state'),button=form.querySelector('button[type=submit]'),preset=host.querySelector('.deepseek-preset');
    let loaded=false,disposed=false,savedBaseUrl='',hasSavedKey=false,deepseekPresetSelected=false;
    function render(snapshot){
      if(disposed||!snapshot)return;
      if(snapshot.settings&&!loaded){for(const name of ['protocol','baseUrl','model','requestTimeoutMs','maxOutputTokens'])get(name).value=String(snapshot.settings[name]??'');savedBaseUrl=String(snapshot.settings.baseUrl??'');loaded=true;preset.disabled=false;}
      hasSavedKey=!!snapshot.hasKey;
      saved.textContent=(snapshot.hasKey?'密钥已加密保存':'尚未保存密钥')+(snapshot.secureStorageAvailable?'':' · 系统加密存储不可用');
      if(!loaded)status.textContent=snapshot.error||'正在装配聊天服务…';
    }
    preset.addEventListener('click',()=>{if(!loaded||disposed)return;get('protocol').value='openai-compatible';get('baseUrl').value='https://api.deepseek.com';get('model').value='deepseek-flash';deepseekPresetSelected=true;status.textContent='已填入 DeepSeek 设置，请确认对应的 API Key 后保存。';});
    host.querySelector('.open-chat-memory').addEventListener('click',()=>pet.call('chat-open-memory').catch(()=>{status.textContent='聊天记忆窗口未能打开';}));
    host.querySelector('.open-local-neko').addEventListener('click',()=>pet.call('chat-open-neko-settings').catch(()=>{status.textContent='本机连接设置未能打开';}));
    const off=pet.onState(state=>{render(state.mainChat);renderVoice(state);});
    pet.call('chat-settings-read').then(render,()=>{if(!disposed)status.textContent='聊天设置暂不可用';});
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(!loaded||button.disabled)return;button.disabled=true;status.textContent='正在保存…';
      const secret=get('apiKey').value;
      const key=get('clearKey').checked?{action:'clear'}:secret.trim()?{action:'replace',value:secret}:{action:'keep'};
      if(deepseekPresetSelected&&hasSavedKey&&key.action==='keep'){
        let savedOrigin='',targetOrigin='';try{savedOrigin=new URL(savedBaseUrl).origin;targetOrigin=new URL(get('baseUrl').value).origin;}catch{}
        if(!savedOrigin||savedOrigin!==targetOrigin){status.textContent='当前已保存其他服务商的密钥，请输入 DeepSeek API Key，或先勾选清除旧密钥。';button.disabled=false;return;}
      }
      try{
        const result=await pet.call('chat-settings-save',{protocol:get('protocol').value,baseUrl:get('baseUrl').value,model:get('model').value,
          requestTimeoutMs:Number(get('requestTimeoutMs').value),maxOutputTokens:Number(get('maxOutputTokens').value),key});
        if(disposed)return;get('apiKey').value='';get('clearKey').checked=false;render(result);savedBaseUrl=get('baseUrl').value;deepseekPresetSelected=false;status.textContent=result.hasKey?'设置已保存；发送一条消息可测试连接。':'设置已保存；请先填写 API Key 再发送消息。';
      }catch{if(!disposed)status.textContent='保存失败，请检查地址、模型和系统加密存储';}
      finally{if(!disposed)button.disabled=false;}
    });
    return ()=>{disposed=true;off?.();};
  }
  function mountMemory(host,pet){
    host.innerHTML='<main class="chat-panel memory-panel"><header><h1>N.E.K.O. 记忆</h1><button type="button" class="refresh-memory">刷新</button></header><p>主角色统一使用 N.E.K.O. 记忆，自动整理已完成的聊天。原始记录保留；候选和模型推断不会冒充用户确认。</p><section class="memory-system"><h2>原生记忆服务</h2><button type="button" class="sync-memory">立即处理待存记忆</button><p class="memory-sync-status"></p><details class="memory-model-settings"><summary>N.E.K.O. 记忆组件与整理模型</summary><p>组件在本机自动运行，默认使用聊天 API 整理记忆，也可设置独立模型。整理会调用所选模型。DSH 工作任务不进入这套记忆。</p><label class="check-label"><input type="checkbox" class="memory-reuse-chat" checked>使用当前聊天 API 整理记忆</label><form class="memory-model-form"><fieldset class="memory-custom-model"><legend>独立记忆整理模型</legend><label>协议<select name="protocol"><option value="openai-compatible">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select></label><label>API 基础地址<input name="baseUrl" type="url" maxlength="2048"></label><label>模型<input name="model" maxlength="200"></label><label>超时（毫秒）<input name="requestTimeoutMs" type="number" min="1000" max="300000" value="60000"></label><label>新密钥<input name="apiKey" type="password" maxlength="16384" autocomplete="new-password" placeholder="留空保留已存密钥"></label></fieldset><button type="submit">保存并连接记忆组件</button><p class="memory-key-status"></p></form></details></section><p role="status" aria-live="polite"></p><section class="memory-items"></section><section class="memory-summaries"></section><details><summary>最近聊天记录</summary><div class="chat-history"></div></details></main>';
    const document=host.ownerDocument,status=host.querySelector('[role=status]'),items=host.querySelector('.memory-items'),summaries=host.querySelector('.memory-summaries'),history=host.querySelector('.chat-history');
    let generation=0,disposed=false,lastBackend,lastPhase,lastMemory,modelLoaded=false;const drafts=new Map();
    const syncStatus=host.querySelector('.memory-sync-status'),reuse=host.querySelector('.memory-reuse-chat'),modelForm=host.querySelector('.memory-model-form'),custom=host.querySelector('.memory-custom-model');
    const node=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;};
    const actionButton=(text,action)=>{const button=node('button',text);button.type='button';button.addEventListener('click',async()=>{if(button.disabled)return;button.disabled=true;try{await action();}catch{if(!disposed)status.textContent='操作未完成，请刷新后重试';}finally{if(!disposed)button.disabled=false;}});return button;};
    async function mutate(input){const result=await pet.call('chat-memory-action',input);if(result?.ok!==false&&input.id)drafts.delete(input.id);await refresh();if(result?.ok===false)status.textContent=result.message||'操作未完成，仍使用原有设置';}
    host.querySelector('.sync-memory').addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;status.textContent='正在处理记忆…';try{await mutate({action:'sync'});}catch{status.textContent='记忆处理未完成，记录已保留';}finally{if(!disposed)button.disabled=false;}});
    reuse.addEventListener('change',()=>{custom.disabled=reuse.checked;});custom.disabled=true;
    modelForm.addEventListener('submit',async event=>{
      event.preventDefault();const button=modelForm.querySelector('button');if(button.disabled)return;button.disabled=true;status.textContent='正在连接记忆组件…';const get=name=>modelForm.elements.namedItem(name);
      try{const secret=get('apiKey').value;await mutate({action:'configure-neko',enabled:true,useChatApi:reuse.checked,...(reuse.checked?{}:{protocol:get('protocol').value,baseUrl:get('baseUrl').value,model:get('model').value,requestTimeoutMs:Number(get('requestTimeoutMs').value),key:secret.trim()?{action:'replace',value:secret}:{action:'keep'}})});get('apiKey').value='';}
      catch{if(!disposed)status.textContent='记忆组件尚未就绪，请检查组件安装和模型设置';}finally{if(!disposed)button.disabled=false;}
    });
    function renderReplication(replication,model){
      host.querySelector('.memory-system').hidden=!replication;if(!replication)return;

      syncStatus.textContent='N.E.K.O.：'+(replication.providerStates.neko||'待连接')+'；待处理 '+replication.pending+' 条，冲突 '+replication.conflicts+' 条。'+(replication.error||'');
      if(model&&!modelLoaded){reuse.checked=model.useChatApi;custom.disabled=reuse.checked;for(const key of ['protocol','baseUrl','model','requestTimeoutMs'])if(model[key]!==undefined)modelForm.elements.namedItem(key).value=String(model[key]);modelLoaded=true;}
      host.querySelector('.memory-key-status').textContent=model?.hasKey?'独立记忆密钥已加密保存':'独立记忆密钥尚未保存';
      if(replication.records.length>200)items.append(node('p','显示最近 200 条结构化记录，原始聊天与日记继续完整保留。'));
      for(const record of replication.records.slice(-200).reverse()){
        const card=node('article',undefined,'memory-card'),controls=node('div',undefined,'memory-controls'),revisionIds=record.heads.map(e=>e.eventId),input={id:record.itemId,revisionIds};
        if(record.deleted){card.append(node('p','已删除 · 旧记录不会自动恢复'),actionButton('显式恢复',()=>mutate({...input,action:'event-restore'})));items.append(card);continue;}
        if(record.conflict){card.append(node('p','这条记忆有不同修订，请选择或合并内容'));for(const head of record.heads)card.append(node('pre',head.value?.text||'删除修订'));const edit=node('textarea');edit.maxLength=30000;edit.setAttribute('aria-label','合并冲突内容');card.append(edit,actionButton('保存合并',()=>mutate({...input,action:'event-resolve',text:edit.value})));}
        else{
          const value=record.value;if(!value)continue;const edit=node('textarea'),draft=drafts.get(record.itemId);edit.value=draft?.text??value.text;edit.maxLength=30000;edit.setAttribute('aria-label','编辑记忆内容');
          edit.addEventListener('input',()=>drafts.set(record.itemId,{text:edit.value,revisionIds:[...revisionIds]}));
          if(draft){input.revisionIds=draft.revisionIds;if(JSON.stringify(draft.revisionIds)!==JSON.stringify(revisionIds))card.append(node('p','这条记忆已有新修订，你的编辑草稿已保留；请核对后重新编辑。'));}
          card.append(node('p',(value.certainty==='user-confirmed'?'用户已确认':value.certainty==='inferred'?'模型推断 / 历史摘要':'待确认 / 历史经历')+' · '+(value.visibility==='private'?'私人':'给用户的日记')),edit,node('small','来源：'+(value.evidenceRefs.join('、')||'来源缺失')));
          if(value.certainty!=='user-confirmed')controls.append(actionButton('确认',()=>mutate({...input,action:'event-confirm'})));
          controls.append(actionButton('保存更正',()=>mutate({...input,action:'event-update',text:edit.value})));
        }
        controls.append(actionButton('删除记忆',()=>mutate({...input,action:'event-delete'})));card.append(controls);items.append(card);
      }
    }
    async function refresh(){
      const token=++generation;status.textContent='正在读取…';
      try{
        const [memory,messages]=await Promise.all([pet.call('chat-memory-read'),pet.call('chat-history')]);
        if(disposed||token!==generation)return;items.replaceChildren(node('h2','偏好与事实'));summaries.replaceChildren(node('h2','旧版历史摘要'));summaries.hidden=!!memory.replication&&!memory.summaries.length;
        if(!(memory.replication?memory.replication.records:memory.items).length)items.append(node('p','还没有记忆；聊天产生的候选会显示在这里。','empty-state'));
        for(const item of memory.replication?[]:memory.items){
          const card=node('article',undefined,'memory-card'),heading=node('p',item.confirmation==='confirmed'?'已确认':'待确认','memory-badge');
          const text=node('textarea');text.value=item.text;text.maxLength=500;text.setAttribute('aria-label',item.confirmation==='confirmed'?'编辑已确认记忆':'编辑候选记忆');
          const controls=node('div',undefined,'memory-controls');
          if(item.confirmation!=='confirmed')controls.append(actionButton('确认',()=>mutate({action:'confirm',id:item.id})));
          controls.append(actionButton('保存修改',()=>mutate({action:'update',id:item.id,text:text.value})),actionButton('删除',()=>mutate({action:'remove',id:item.id})));
          card.append(heading,text,node('small','来源消息：'+item.sourceMessageIds.join('、')),controls);items.append(card);
        }
        renderReplication(memory.replication,memory.memoryModel);
        if(!memory.summaries.length)summaries.append(node('p','长会话超出近期上下文后才会生成带来源的摘要。','empty-state'));
        for(const summary of memory.summaries){
          const card=node('article',undefined,'memory-card'),sources=node('div',undefined,'summary-sources');
          const controls=node('div',undefined,'memory-controls');
          controls.append(actionButton('查看来源',async()=>{const rows=await pet.call('chat-memory-action',{action:'sources',id:summary.id});if(disposed||!card.isConnected)return;sources.replaceChildren(...rows.map(row=>node('pre',(row.role==='user'?'用户：':'角色：')+row.text)));}),actionButton('删除摘要',()=>mutate({action:'remove-summary',id:summary.id})));
          card.append(node('p',summary.text),node('small','自动摘录，不是已确认事实'),controls,sources);summaries.append(card);
        }
        history.replaceChildren(...messages.slice(-60).map(message=>node('p',(message.role==='user'?'你：':'角色：')+message.text,'history-message')));
        if(!messages.length)history.append(node('p','还没有聊天记录。'));status.textContent='当前使用 N.E.K.O. 记忆，已读取本角色存档';
      }catch{if(!disposed&&token===generation){items.replaceChildren();summaries.replaceChildren();history.replaceChildren();status.textContent='请先使用聊天 API 模式；本机 N.E.K.O. 的记忆在原界面管理。';}}
    }
    const off=pet.onState(state=>{const snapshot=state.mainChat;if(!snapshot)return;const backend=snapshot.backend,phase=snapshot.chat?.phase,memory=JSON.stringify(snapshot.memorySystem);const refreshNow=backend!==lastBackend||memory!==lastMemory||(['connecting','replying'].includes(lastPhase)&&!['connecting','replying'].includes(phase));lastBackend=backend;lastPhase=phase;lastMemory=memory;if(refreshNow)void refresh();});
    host.querySelector('.refresh-memory').addEventListener('click',()=>void refresh());void refresh();
    return ()=>{disposed=true;generation++;off?.();};
  }
  return Object.freeze({mountSettings,mountMemory});
});
