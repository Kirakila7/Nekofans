'use strict';
// QQ is an external social channel. Its agents may converse but cannot invoke
// host tools, including tools installed later in the agent's own scope.
const DENIAL='QQ 会话仅支持聊天，本机工具调用已禁用。';
const installed = new WeakSet();
async function installQQAgentGuard(agentCtx) {
  if(!agentCtx || typeof agentCtx.inject!=='function')throw Error('QQ 会话工具防护不可用');
  if(installed.has(agentCtx))return;
  let ready=false;
  const fiber=agentCtx.inject(['tools'],scoped=>{
    if(typeof scoped.tools?.guard!=='function'||typeof scoped.tools?.restrict!=='function')throw Error('QQ 会话工具防护不可用');
    scoped.tools.guard(()=>DENIAL);
    scoped.tools.restrict({allow:[]});
    ready=true;
  });
  try{await fiber;}catch{throw Error('QQ 会话工具防护不可用');}
  if(!ready || fiber.state!==2){try{await fiber.dispose?.();}catch{}throw Error('QQ 会话工具防护不可用');}
  installed.add(agentCtx);
}
module.exports={installQQAgentGuard,DENIAL};
