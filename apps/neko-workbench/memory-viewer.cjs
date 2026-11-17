'use strict';
const {DatabaseSync}=require('node:sqlite');
const {existsSync}=require('node:fs');
const {join}=require('node:path');
const AVATARS={bigfish:'assets/icons/bigfish.webp',yui:'assets/memory-characters/yui.webp',claude:'assets/memory-characters/claude.webp',gemini:'assets/ai-girls/gemini/still.png',devcat:'assets/neko-cat/still.png'};

/** View existing per-persona archives without changing the active chat character.
 * Only Bigfish currently owns a native engine. Other roles are read-only here.
 */
function createMemoryViewer({getRuntime,getRoles}){
  function characters(){return getRoles().roles.filter(r=>/^[a-z0-9_-]{1,64}$/.test(r.id)).map(r=>({id:r.id,name:r.name,
    avatar:r.avatarId==='custom'&&/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(r.customDataUrl||'')?r.customDataUrl:AVATARS[r.avatarId]||AVATARS[r.id]||AVATARS.bigfish,
    readOnly:r.id!=='bigfish'}));}
  function selected(id='bigfish'){const character=characters().find(r=>r.id===id);if(!character)throw Error('未知记忆人物');return character;}
  function database(name,read){
    const runtime=getRuntime();if(!runtime||runtime.closed)throw Error('记忆服务未就绪');
    const file=join(runtime.dataDir,name);if(!existsSync(file))return [];
    const db=new DatabaseSync(file,{readOnly:true});try{return read(db);}finally{db.close();}
  }
  const table=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  function archived(id){return database('memories.sqlite',db=>{
    const rows=table(db,'memories')?db.prepare('SELECT id,kind,text,confirmation,source_message_ids,created_at,updated_at FROM memories WHERE persona_id=? ORDER BY seq').all(id).map(r=>({...r,archiveKind:'memory',certainty:r.confirmation==='confirmed'?'user-confirmed':'candidate'})):[];
    if(table(db,'conversation_summaries'))rows.push(...db.prepare('SELECT id,text,source_ids,updated_at FROM conversation_summaries WHERE persona_id=? ORDER BY seq').all(id).map(r=>({...r,archiveKind:'summary',kind:'summary',certainty:'inferred',created_at:r.updated_at,source_message_ids:r.source_ids})));
    return rows.map(row=>{
      const value={kind:row.kind,text:row.text,visibility:'private',certainty:row.certainty,evidenceRefs:JSON.parse(row.source_message_ids)};
      const itemId='archive:'+row.archiveKind+':'+row.id;
      const event={eventId:itemId+':'+row.updated_at,itemId,personaId:id,origin:'user',operation:'upsert',parents:[],occurredAt:new Date(Number(row.updated_at)).toISOString(),value};
      return {itemId:event.itemId,createdAt:new Date(Number(row.created_at)).toISOString(),value,heads:[event],deleted:false,conflict:false};
    });
  });}
  return {
    characters,
    async read(id='bigfish'){
      const character=selected(id),runtime=getRuntime();if(!runtime||runtime.closed)throw Error('记忆服务未就绪');
      const body=id==='bigfish'?await runtime.memories():{items:[],summaries:[],replication:{mode:'archive',pending:0,conflicts:0,providerStates:{},records:archived(id)},memoryModel:null};
      return {...body,character,characters:characters(),readOnly:character.readOnly,
        viewMessage:character.readOnly?'当前查看此人物的独立存档；该人物尚未接入原生记忆整理。':''};
    },
    async history(id='bigfish'){
      selected(id);if(id==='bigfish')return getRuntime().history();
      return database('conversations.sqlite',db=>{
        if(!table(db,'messages'))return [];
        const latest=db.prepare('SELECT conversation_id FROM messages WHERE persona_id=? ORDER BY seq DESC LIMIT 1').get(id);if(!latest)return [];
        return db.prepare('SELECT id,role,text,created_at FROM messages WHERE persona_id=? AND conversation_id=? ORDER BY seq DESC LIMIT 200').all(id,latest.conversation_id).reverse().map(r=>({id:r.id,personaId:id,conversationId:latest.conversation_id,role:r.role,text:r.text,createdAt:Number(r.created_at)}));
      });
    },
    action(input){const {personaId='bigfish',...command}=input;selected(personaId);if(personaId!=='bigfish')throw Error('此人物的记忆当前仅供查看');return getRuntime().memoryAction(command);},
  };
}
module.exports={createMemoryViewer};
