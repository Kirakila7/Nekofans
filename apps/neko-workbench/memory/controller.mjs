import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { MemoryHub } from '../framework/reference/memory-hub.mjs';
import { EventStore, validateEvents, stable } from './event-store.mjs';
import { NekoMemoryAdapter, NekoMemoryWorker } from './neko-adapter.mjs';
const hash=v=>createHash('sha256').update(stable(v)).digest('hex');

/** Native NEKO is the only memory provider; the hub is a durable delivery ledger. */
export class WorkbenchMemory {
  constructor({directory,dataDir,repositoryRoot,getModel,getPersona,getLegacy,notify=()=>{},worker,autoSyncIntervalMs=30000}){
    Object.assign(this,{directory,dataDir,getLegacy,notify});this.closed=false;this.activeSync=null;this.localTail=Promise.resolve();
    try{
    this.store=new EventStore(join(directory,'hub.sqlite'));
    this.settings={autoSync:true,nekoEnabled:true};
    this.worker=worker||new NekoMemoryWorker({repositoryRoot,dataRoot:join(directory,'native'),getModel,getPersona});
    this.neko=new NekoMemoryAdapter({worker:this.worker,isConfigured:()=>this.settings.nekoEnabled});
    const previous=this.store.get('hub');
    if(previous){if(previous.personaId!=='bigfish')throw Error('memory persona mismatch');validateEvents(previous.events,'bigfish');}
    const snapshot=previous?structuredClone(previous):{personaId:'bigfish',events:[],cursors:{},acknowledgements:{}};
    // Read the former side table once, including events saved before the hub caught up.
    // Neither this file nor the original Markdown diaries are changed or removed.
    if(!this.store.get('nativeOnlyMigration')){
      const oldDiary=join(directory,'diary.sqlite');
      if(existsSync(oldDiary)){
        const db=new DatabaseSync(oldDiary,{readOnly:true});
        try{
          const owner=db.prepare("SELECT value FROM metadata WHERE key='personaId'").get();
          if(owner&&JSON.parse(owner.value)!=='bigfish')throw Error('memory persona mismatch');
          const events=db.prepare('SELECT body FROM events ORDER BY seq').all().map(row=>JSON.parse(row.body));
          snapshot.events=validateEvents(events,'bigfish',snapshot.events);
        }finally{db.close();}
      }
      snapshot.mode='neko';
      this.store.db.exec('BEGIN IMMEDIATE');
      try{
        if(previous&&!this.store.get('preNativeOnlyHub'))this.store.set('preNativeOnlyHub',previous);
        this.store.set('hub',snapshot);this.store.set('nativeOnlyMigration',1);
        this.store.db.exec('COMMIT');
      }catch(error){this.store.db.exec('ROLLBACK');throw error;}
    }
    snapshot.mode='neko';
    this.hub=new MemoryHub({personaId:'bigfish',adapters:{neko:this.neko},snapshot,persist:async state=>{this.store.set('hub',state);}});
    this.providerStates={neko:'待连接'};this.error='';
    this.timer=setInterval(()=>{if(!this.closed)void this.sync().catch(()=>{});},autoSyncIntervalMs);this.timer.unref?.();
    }catch(error){this.store?.close();throw error;}
  }
  status(){
    const state=this.hub.snapshot(),ack=new Set(state.acknowledgements.neko||[]);
    return {mode:state.mode,autoSync:this.settings.autoSync,configured:this.settings.nekoEnabled,pending:this.settings.nekoEnabled?state.events.filter(e=>!ack.has(e.eventId)).length:0,
      conflicts:this.hub.records().filter(r=>r.conflict).length,providerStates:{...this.providerStates},error:this.error,
      revision:state.events.length};
  }
  publish(){if(!this.closed)this.notify(this.status());}
  async reconcile(){
    if(this.closed)return;
    const legacy=await this.getLegacy();if(this.closed||!legacy)return;
    const snapshots=[...(legacy.items||[]).map(v=>({id:'local:'+v.id,value:{kind:v.kind,text:v.text,visibility:'private',certainty:v.confirmation==='confirmed'?'user-confirmed':'candidate',evidenceRefs:v.sourceMessageIds}})),
      ...(legacy.summaries||[]).map(v=>({id:'summary:'+v.id,value:{kind:'summary',text:v.text,visibility:'private',certainty:'inferred',evidenceRefs:v.sourceMessageIds}}))];
    const previous=this.store.get('legacy')||{},summaryOwners=this.store.get('summaryOwners')||{},next={},records=new Map(this.hub.records().map(r=>[r.itemId,r])),events=[];
    for(const row of snapshots){
      const fingerprint=hash(row.value);next[row.id]=fingerprint;
      if(row.id.startsWith('summary:'))summaryOwners[row.id]=legacy.conversationId||null;
      if(previous[row.id]===fingerprint)continue;
      const record=records.get(row.id);if(record?.deleted)continue;
      events.push(this.event(row.id,row.value,record?.heads||[], 'upsert','diary','legacy:'+hash([row.id,fingerprint,record?.heads.map(e=>e.eventId)||[]])));
    }
    for(const id of Object.keys(previous))if(!(id in next)){
      if(id.startsWith('summary:')&&summaryOwners[id]!==undefined&&summaryOwners[id]!== (legacy.conversationId||null)){next[id]=previous[id];continue;}
      const record=records.get(id);if(record&&!record.deleted)events.push(this.event(id,undefined,record.heads,'delete','user'));
    }
    if(events.length)await this.hub.add(events);
    this.store.set('legacy',next);
    this.store.set('summaryOwners',summaryOwners);
    // Reconcile raw completed turns after a crash between conversation commit and
    // the optional turn hook. Incomplete/cancelled assistant turns do not exist here.
    const file=join(this.dataDir,'conversations.sqlite');
    if(existsSync(file)){
      const db=new DatabaseSync(file,{readOnly:true});
      try{
        const offset=this.store.get('chatCursor')||0;
        const rows=db.prepare('SELECT seq,id,persona_id,conversation_id,role,text,created_at FROM messages WHERE persona_id=? AND seq>? ORDER BY seq LIMIT 256').all('bigfish',Math.max(0,offset-1));
        let previousMessage=null;const turns=[];
        for(const row of rows){
          if(row.seq>offset&&row.role==='assistant'&&previousMessage?.role==='user'&&previousMessage.conversation_id===row.conversation_id){
            const item='turn:'+hash([previousMessage.id,row.id]);const full='用户原话：'+previousMessage.text+'\n角色回复：'+row.text;
            for(let start=0;start<full.length;start+=24000){const id=item+':'+(start/24000),eventId='chat:'+hash([id,full]);const event=this.event(id,{kind:'episode',text:full.slice(start,start+24000),visibility:'private',certainty:'inferred',evidenceRefs:[previousMessage.id,row.id]},[],'upsert','user',eventId);event.occurredAt=new Date(Number(row.created_at)).toISOString();turns.push(event);}
          }
          previousMessage=row;
        }
        if(turns.length)await this.hub.add(turns);
        if(rows.length)this.store.set('chatCursor',Number(rows.at(-1).seq));
      }finally{db.close();}
    }
  }
  event(itemId,value,heads=[],operation='upsert',origin='user',eventId=randomUUID()){
    const prior=this.hub.snapshot().events.find(e=>e.eventId===eventId);
    if(prior)return structuredClone(prior);
    return {eventId,itemId,personaId:'bigfish',origin,operation,parents:heads.map(e=>e.eventId),occurredAt:new Date().toISOString(),...(value?{value:structuredClone(value)}:{})};
  }
  localSync(){const task=this.localTail.then(()=>this.reconcile());this.localTail=task.catch(()=>{});return task;}
  async sync(){
    if(this.closed)throw Error('记忆服务已关闭');
    // A completed chat may arrive while an earlier synchronization is in flight.
    // Stage its durable events before joining that job, then deliver anything it missed.
    await this.localSync();
    if(this.closed)throw Error('记忆服务已关闭');
    if(this.activeSync){
      await this.activeSync;
      if(this.closed)throw Error('记忆服务已关闭');
      return this.status().pending?this.sync():this.status();
    }
    const task=(async()=>{
      // Pull generated native facts after delivering completed turns.
      for(let pass=0;pass<2;pass++){
        const results=await this.hub.sync();
        this.providerStates.neko=results.neko.ok?'已连接':'待连接或待重试';
        if(!results.neko.ok)throw Error('记忆处理未完成，待处理记录已保留');
      }
      this.error='';this.publish();return this.status();
    })();
    this.activeSync=task;
    try{return await task;}catch(error){this.error='同步未完成，记录已保留，可稍后重试';this.publish();throw error;}finally{if(this.activeSync===task)this.activeSync=null;}
  }
  async view(){if(!this.activeSync)await this.localSync();return {...this.status(),records:this.hub.records()};}
  async recall(personaId,query,budget,signal){
    if(personaId!=='bigfish'||this.closed||signal?.aborted)return [];
    await this.localSync();if(signal?.aborted||this.closed)return [];
    try{
      let values=await this.neko.recall(query,budget,signal);
      const historyFile=join(this.dataDir,'conversations.sqlite');
      if(existsSync(historyFile)){
        const db=new DatabaseSync(historyFile,{readOnly:true});
        try{
          const latest=db.prepare('SELECT conversation_id FROM messages WHERE persona_id=? ORDER BY seq DESC LIMIT 1').get('bigfish');
          const recent=new Set(latest?db.prepare('SELECT id FROM messages WHERE persona_id=? AND conversation_id=? ORDER BY seq DESC LIMIT 20').all('bigfish',latest.conversation_id).map(r=>r.id):[]);
          values=values.filter(v=>!['episode','summary'].includes(v.kind)||!v.evidenceRefs.some(id=>recent.has(id)));
        }finally{db.close();}
      }
      if(signal?.aborted||this.closed)return [];
      this.providerStates.neko='已连接';this.publish();return values;
    }catch(error){this.providerStates.neko='暂不可用';this.error='N.E.K.O. 记忆暂不可用，本次聊天继续，记录已保留待重试';this.publish();throw error;}
  }
  async recordTurn(){await this.localSync();void this.sync().catch(()=>{});}
  /** A short lobby summary the user took part in. Raw lobby text never comes through here.
   * The origin stays 'user'; the 'lobby:' item prefix and 'lobby-msg:' refs mark the source. */
  async recordSharedExperience({id,text,occurredAt,evidenceRefs}={}){
    if(this.closed)throw Error('记忆服务已关闭');
    if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(id))throw Error('大厅经历标识无效');
    if(typeof text!=='string'||!text.trim()||text.length>2000)throw Error('大厅经历内容无效');
    const at=typeof occurredAt==='number'?occurredAt:Date.parse(occurredAt);
    if(!Number.isFinite(at))throw Error('大厅经历时间无效');
    if(!Array.isArray(evidenceRefs)||!evidenceRefs.length||evidenceRefs.length>256||evidenceRefs.some(ref=>typeof ref!=='string'||!/^lobby-msg:[A-Za-z0-9_-]{1,120}$/.test(ref)))throw Error('大厅经历来源无效');
    await this.localSync();if(this.closed)throw Error('记忆服务已关闭');
    const itemId='lobby:'+id,eventId='lobby:'+hash([id,text.trim()]);
    // One record per segment. A retry after restart may summarize differently;
    // never fork the item into a conflict or revive a record the user deleted.
    if(this.hub.snapshot().events.some(e=>e.itemId===itemId))return {itemId,eventId,created:false};
    const event=this.event(itemId,{kind:'episode',text:text.trim(),visibility:'private',certainty:'inferred',evidenceRefs:[...new Set(evidenceRefs)]},[],'upsert','user',eventId);
    event.occurredAt=new Date(at).toISOString();
    await this.hub.add([event]);
    void this.sync().catch(()=>{});this.publish();
    return {itemId,eventId,created:true};
  }
  async connect(){
    try{await this.hub.ready('neko');this.providerStates.neko='已连接';this.error='';}
    catch(error){this.providerStates.neko='待连接或待重试';this.error='N.E.K.O. 记忆尚未就绪，请检查组件与记忆模型设置';this.publish();throw error;}
    void this.sync().catch(()=>{});this.publish();return this.status();
  }
  async change({action,id,text,revisionIds}){
    await this.localSync();const record=this.hub.records().find(r=>r.itemId===id);
    if(!record||!Array.isArray(revisionIds)||stable([...revisionIds].sort())!==stable(record.heads.map(e=>e.eventId).sort()))throw Error('记忆已变化，请刷新后再操作');
    let value=record.value,operation='upsert';
    if(action==='event-delete')operation='delete';
    else if(action==='event-restore'){
      if(!record.deleted)throw Error('这条记忆未删除');
      value=[...this.hub.snapshot().events].reverse().find(e=>e.itemId===id&&e.value)?.value;if(!value)throw Error('没有可恢复的修订');operation='restore';
    }else{
      if(record.deleted)throw Error('请先显式恢复这条记忆');
      if(action==='event-resolve'){if(!record.conflict)throw Error('没有待处理冲突');value=record.heads.find(e=>e.value)?.value;}
      else if(record.conflict)throw Error('请先合并冲突');
      if(!value)throw Error('记忆内容不可用');value=structuredClone(value);
      if(action==='event-resolve')value.evidenceRefs=[...new Set(record.heads.flatMap(e=>e.value?.evidenceRefs||[]))].slice(0,256);
      if(action==='event-confirm')value.certainty='user-confirmed';
      else if(['event-update','event-resolve'].includes(action)){
        if(typeof text!=='string'||!text.trim()||text.length>30000)throw Error('记忆内容无效');value.text=text.trim();value.certainty='user-confirmed';
      }else throw Error('记忆操作无效');
    }
    if(value&&this.hub.snapshot().events.some(e=>e.itemId===id&&e.value?.visibility==='private'))value={...value,visibility:'private'};
    const event=this.event(id,value,record.heads,operation);await this.hub.add([event]);
    void this.sync().catch(()=>{});this.publish();return this.view();
  }
  async close(){
    if(this.closed)return;this.closed=true;clearInterval(this.timer);
    await this.worker.close();await Promise.allSettled([this.activeSync,this.localTail]);await this.hub.queue;
    this.store.close();
  }
}
