import { randomUUID, createHash } from 'node:crypto';
import { validateStudioGame, studioPreview } from './studio-game.mjs';

const authoringPrompt = [
  '你是 Nekofans 创造台。根据用户描述创作一款新的双人公开回合制小游戏，不套用已有棋类。',
  '只返回 JSON，结构为 {"title":"标题","description":"玩法和胜负条件","nodes":[...]}。',
  'nodes 有 3 到 24 个节点，0 是开局。行动节点为 {"text":"局面","seat":0,"choices":[{"label":"动作","next":1}]}。',
  '每个行动节点有 1 到 4 个选项，next 必须指向编号更大的节点；相邻行动节点的 seat 必须交替为 0、1。所有节点都从 0 可达。',
  '终局节点为 {"text":"结局","winner":0}，winner 取 0、1 或 "draw"，每条路径双方都要先行动过。',
  '用用户要求的设定和胜负逻辑设计不同选择、不同结局。局面和结局直接写好；不要给代码、链接、Markdown、秘密规则或外部资源。',
  '标题最多 40 字，说明 220 字，节点文字 160 字，动作 56 字。修改请求基于 previousDraft，仍返回完整新版本。',
].join('\n');

export function createGameStudio({provider} = {}) {
  if (!provider || typeof provider.stream !== 'function') throw TypeError('provider required');
  const drafts=new Map(); let busy=false;
  async function propose({prompt, revisionId, signal} = {}) {
    if (busy) return {status:'busy'};
    if(typeof prompt!=='string'||!prompt.trim()||[...prompt].length>2000)return {status:'invalid'};
    const base=revisionId && drafts.get(revisionId);
    if(revisionId && !base)return {status:'not-found'};
    if(drafts.size>=12)return {status:'limit'};
    const controller=new AbortController(),cancel=()=>controller.abort();
    if(signal?.aborted)return {status:'unavailable'};
    signal?.addEventListener('abort',cancel,{once:true}); const timer=setTimeout(cancel,90000);
    const wait=p=>new Promise((resolve,reject)=>{const stop=()=>reject(Error('cancelled'));if(controller.signal.aborted)return stop();controller.signal.addEventListener('abort',stop,{once:true});Promise.resolve(p).then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',stop));});
    busy=true;let iterator;
    try {
      const persona={id:'game-studio',name:'创造台 · 游戏制作',prompt:authoringPrompt};
      const text=JSON.stringify({request:prompt.trim(),...(base?{previousDraft:base.game}:{})});
      if(text.length>32000)return {status:'too-large'};
      iterator=provider.stream({persona,memories:[],maxOutputTokens:10000,signal:controller.signal,messages:[{id:randomUUID(),personaId:persona.id,conversationId:'private-game-draft',role:'user',text,createdAt:Date.now()}]})[Symbol.asyncIterator]();
      let output='',complete=false;
      for(;;){const next=await wait(iterator.next());if(next.done)break;const event=next.value;if(event?.type==='delta'&&typeof event.text==='string')output+=event.text;if(output.length>32000)return {status:'too-large'};if(event?.type==='complete'){complete=true;break;}}
      if(!complete||controller.signal.aborted)return {status:'invalid-proposal'};
      let game;
      try {
        const content = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(output)?.[1] ?? output;
        game = validateStudioGame(JSON.parse(content));
      } catch { return {status:'invalid-proposal'}; }
      if(!game)return {status:'invalid-proposal'};
      const id=randomUUID(),digest=createHash('sha256').update(JSON.stringify(game)).digest('hex');
      drafts.set(id,{game,digest,parent:revisionId||null});
      return {status:'draft',revisionId:id,digest,preview:studioPreview(game)};
    } catch {return {status:'unavailable'};}
    finally {busy=false;clearTimeout(timer);controller.abort();signal?.removeEventListener('abort',cancel);if(typeof iterator?.return==='function')Promise.resolve().then(()=>iterator.return()).catch(()=>{});}
  }
  // Owner-only adapter must control access; this module is not an HTTP API.
  function inspect(id){const d=drafts.get(id);return d?structuredClone(d):null;}
  return Object.freeze({propose,inspect});
}
