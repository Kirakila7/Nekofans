(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.WorkbenchChatUI=api;})(globalThis,function(){
  'use strict';
  function mountSettings(host,pet){
    host.innerHTML='<main class="chat-panel"><h1>聊天 API 设置</h1><p>主角色聊天与工作任务分开。</p><button type="button" class="use-deepseek-account" disabled>使用 DeepSeek 工作台账号</button><p>实验功能：使用已登录的工作台账号，无需另填 API Key；真实账号聊天尚未验收。社区大厅中的妈妈自动回复、手动生成回复及共同经历记忆暂不支持此模式。</p><form class="api-form"><div class="api-presets"><button type="button" class="deepseek-preset" disabled>使用 DeepSeek 预设</button><p>DeepSeek 聊天使用独立的 API Key 和 API 账户额度，与工作台登录的 DSH 账号及余额分开；发送消息会消耗 API 额度。</p></div><label>协议<select name="protocol"><option value="openai-compatible">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select></label><label>API 基础地址<input name="baseUrl" type="url" maxlength="2048" placeholder="https://example.com/v1"></label><label>模型<input name="model" type="text" maxlength="200" autocomplete="off"></label><div class="api-limits"><label>超时（毫秒）<input name="requestTimeoutMs" type="number" min="1000" max="300000" required></label><label>回复 Token 上限<input name="maxOutputTokens" type="number" min="1" max="32000" required></label></div><label>新密钥<input name="apiKey" type="password" maxlength="16384" autocomplete="new-password" placeholder="留空保留已存密钥"></label><label class="check-label"><input name="clearKey" type="checkbox">清除已保存密钥</label><p class="key-state"></p><p>保存后使用 Chat API，与可选本机 N.E.K.O. 连接互斥。密钥只保存在本机系统加密存储中。</p><p class="feature-status">原生语音：未接入，当前使用文字聊天。</p><button type="submit">保存并使用 Chat API</button><p role="status" aria-live="polite"></p></form><nav class="chat-settings-links"><button type="button" class="open-chat-memory">聊天记忆…</button><button type="button" class="open-local-neko">连接本机 N.E.K.O.（可选）…</button></nav></main>';
    const form=host.querySelector('form'),get=name=>form.elements.namedItem(name),status=host.querySelector('[role=status]'),saved=host.querySelector('.key-state'),button=form.querySelector('button[type=submit]'),preset=host.querySelector('.deepseek-preset'),account=host.querySelector('.use-deepseek-account');
    let loaded=false,disposed=false,savedBaseUrl='',hasSavedKey=false,deepseekPresetSelected=false;
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
  function mountMemory(host,pet){
    return window.WorkbenchMemoryGraph.mount(host,pet);
  }
  return Object.freeze({mountSettings,mountMemory});
});
