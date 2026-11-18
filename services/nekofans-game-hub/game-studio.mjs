import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateStudioGame, studioPreview } from './studio-game.mjs';
import { nextStudioNode } from '../nekofans-game-workshop/server/studio-definition.mjs';

const MAX_LOCAL_DRAFTS = 128;
const MAX_DRAFT_FILE_BYTES = 3 * 1024 * 1024;
const revisionKey = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const gameDigest = game => createHash('sha256').update(JSON.stringify(game)).digest('hex');

function readDrafts(file) {
  const drafts = new Map();
  try {
    if (statSync(file).size > MAX_DRAFT_FILE_BYTES) throw Error('Draft file too large');
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    if (stored?.version !== 1 || !Array.isArray(stored.revisions) || stored.revisions.length > MAX_LOCAL_DRAFTS) throw Error('Invalid draft file');
    for (const entry of stored.revisions) {
      const game = validateStudioGame(entry?.game);
      if (!game || typeof entry.id !== 'string' || !revisionKey.test(entry.id) || drafts.has(entry.id) ||
          (entry.parent !== null && !drafts.has(entry.parent)) || entry.digest !== gameDigest(game) ||
          !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0 || !Number.isFinite(new Date(entry.createdAt).valueOf())) throw Error('Invalid draft revision');
      drafts.set(entry.id, { game, digest: entry.digest, parent: entry.parent, createdAt: entry.createdAt });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return drafts;
}

function writeDrafts(file, drafts) {
  const revisions = [...drafts].map(([id, draft]) => ({ id, ...draft }));
  const payload = JSON.stringify({ version: 1, revisions });
  if (Buffer.byteLength(payload) > MAX_DRAFT_FILE_BYTES) throw Error('Draft file too large');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, payload, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

const authoringPrompt = [
  '你是 Nekofans 创造台。根据用户描述创作一款新的双人公开回合制小游戏，不套用已有棋类。',
  '只返回 JSON，结构为 {"title":"标题","description":"玩法和胜负条件","nodes":[...]}。',
  'nodes 有 3 到 24 个节点，0 是开局。行动节点为 {"text":"局面","seat":0,"choices":[{"label":"动作","next":1}]}。',
  '每个行动节点有 1 到 4 个选项，next 必须指向编号更大的节点；相邻行动节点的 seat 必须交替为 0、1。所有节点都从 0 可达。',
  '终局节点为 {"text":"结局","winner":0}，winner 取 0、1 或 "draw"，每条路径双方都要先行动过。',
  '用用户要求的设定和胜负逻辑设计不同选择、不同结局。局面和结局直接写好；不要给代码、链接、Markdown、秘密规则或外部资源。',
  '标题最多 40 字，说明 220 字，节点文字 160 字，动作 56 字。修改请求基于 previousDraft，仍返回完整新版本。',
].join('\n');

export function createGameStudio({provider, draftFile} = {}) {
  if (!provider || typeof provider.stream !== 'function') throw TypeError('provider required');
  let drafts=new Map(),busy=false,storageUnavailable=false;
  const unsaved=new Set();
  if(draftFile){
    try{drafts=readDrafts(draftFile);}catch{storageUnavailable=true;}
  }
  function openDraft(id){
    if(storageUnavailable)return {status:'draft-storage-unavailable'};
    const revision=drafts.get(id);
    return revision?{status:'draft',revisionId:id,digest:revision.digest,preview:studioPreview(revision.game),
      ...(unsaved.has(id)?{saved:false}:{})}:{status:'not-found'};
  }
  function listDrafts(){
    if(storageUnavailable)return {status:'draft-storage-unavailable'};
    const parents=new Set([...drafts.values()].map(revision=>revision.parent));
    const revisions=[...drafts].reverse().filter(([id])=>!parents.has(id))
      .map(([revisionId,{game,createdAt}])=>({revisionId,title:game.title,createdAt}));
    return {status:'ready',revisions};
  }
  async function propose({prompt, revisionId, signal} = {}) {
    if (busy) return {status:'busy'};
    if (storageUnavailable) return {status:'draft-storage-unavailable'};
    if(typeof prompt!=='string'||!prompt.trim()||[...prompt].length>2000)return {status:'invalid'};
    const base=revisionId && drafts.get(revisionId);
    if(revisionId && !base)return {status:'not-found'};
    if(drafts.size>=(draftFile?MAX_LOCAL_DRAFTS:12))return {status:'limit'};
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
      const id=randomUUID(),revision={game,digest:gameDigest(game),parent:revisionId||null,createdAt:Date.now()};
      const next=new Map(drafts).set(id,revision);
      if(draftFile){
        try{writeDrafts(draftFile,next);unsaved.clear();}
        catch{unsaved.add(id);}
      }
      drafts=next;
      return openDraft(id);
    } catch {return {status:'unavailable'};}
    finally {busy=false;clearTimeout(timer);controller.abort();signal?.removeEventListener('abort',cancel);if(typeof iterator?.return==='function')Promise.resolve().then(()=>iterator.return()).catch(()=>{});}
  }
  // Owner-only adapter must control access; this module is not an HTTP API.
  function inspect(id){const d=drafts.get(id);return d?structuredClone({game:d.game,digest:d.digest,parent:d.parent}):null;}
  function workshopProject(id) {
    const revision = drafts.get(id);
    if (!revision) return null;
    return structuredClone(revision.game);
  }
  function playtest(revisionId, moves) {
    const game = drafts.get(revisionId)?.game;
    if (!game) return { status: 'not-found' };
    if (!Array.isArray(moves) || moves.length >= game.nodes.length) return { status: 'invalid' };
    let index = 0;
    for (const option of moves) {
      const next = nextStudioNode(game, index, { type: 'choose', option }, game.nodes[index].seat);
      if (next === undefined) return { status: 'invalid' };
      index = next;
    }
    const node = game.nodes[index];
    if (node.choices) return { status: 'turn', text: node.text, seat: node.seat, choices: node.choices.map(choice => choice.label) };
    return { status: 'finished', text: node.text, winner: node.winner };
  }
  return Object.freeze({propose,inspect,workshopProject,playtest,openDraft,listDrafts});
}
