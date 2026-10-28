'use strict';
// QQ is an external social channel. Its agents may converse but cannot invoke
// host tools, including tools installed later in the agent's own scope.
const DENIAL='QQ 会话仅支持聊天，本机工具调用已禁用。';
const { CHAT_PROMPT } = require('./chat-policy.cjs');
const installed = new WeakSet();
async function installQQAgentGuard(agentCtx) {
  if(!agentCtx || typeof agentCtx.inject!=='function')throw Error('QQ 会话工具防护不可用');
  if(installed.has(agentCtx))return;
  let ready=false;
  const fiber=agentCtx.inject(['tools','systemPrompt'],scoped=>{
    if(typeof scoped.tools?.guard!=='function'||typeof scoped.tools?.restrict!=='function')throw Error('QQ 会话工具防护不可用');
    if(typeof scoped.systemPrompt?.section!=='function'||typeof scoped.systemPrompt?.suppressRuntimeContext!=='function')throw Error('QQ 会话工具防护不可用');
    scoped.tools.guard(()=>DENIAL);
    scoped.tools.restrict({allow:[]});
    scoped.systemPrompt.section({name:'neko:qq-chat',order:0,text:CHAT_PROMPT,complete:true,interpolate:false});
    scoped.systemPrompt.suppressRuntimeContext();
    ready=true;
  });
  try{await fiber;}catch{throw Error('QQ 会话工具防护不可用');}
  if(!ready || fiber.state!==2){try{await fiber.dispose?.();}catch{}throw Error('QQ 会话工具防护不可用');}
  installed.add(agentCtx);
}
module.exports={installQQAgentGuard,DENIAL};
