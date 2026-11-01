import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { EventStore, capabilities, selectValues, stable } from './event-store.mjs';
const digest=text=>createHash('sha256').update(text).digest('hex');
const normalized=text=>text.normalize('NFKC').replace(/[,，。！？!?;；\p{Z}\s]/gu,'').toLowerCase();

/** Read-only binding of the two original whale diaries, plus a durable revision side table. */
export class WhaleDiaryMemoryAdapter {
  constructor({directory,personaId='bigfish',sourceFiles=[]}){
    this.personaId=personaId;this.store=new EventStore(join(directory,'diary.sqlite'),personaId);
    try{
    this.sourceFiles=sourceFiles.map(s=>{if(!isAbsolute(s.path)||!['owner','private'].includes(s.visibility))throw Error('invalid diary binding');return {...s};});
    const binding=this.sourceFiles.map(s=>({path:s.path,visibility:s.visibility,personaId}));
    const saved=this.store.get('bindings');if(saved&&stable(saved)!==stable(binding))throw Error('diary binding changed; explicit migration required');this.store.set('bindings',binding);
    }catch(error){this.store.close();throw error;}
  }
  async health(){return {ready:true,capabilities};}
  scan(){
    for(const source of this.sourceFiles){
      let stat;try{stat=lstatSync(source.path);}catch(error){if(error.code==='ENOENT')continue;throw error;}
      if(!stat.isFile()||stat.isSymbolicLink()||realpathSync(source.path).toLowerCase()!==source.path.toLowerCase()||stat.size>2*1024*1024)throw Error('unsafe diary source');
      const key='source:'+digest(source.path),previous=this.store.get(key)||{paragraphs:[],seen:{}};
      const paragraphs=readFileSync(source.path,'utf8').replace(/\r\n/g,'\n').split(/\n\s*\n/).map(p=>p.trim()).filter(Boolean);
      if(paragraphs.length>2000||paragraphs.some(p=>p.length>30000))throw Error('diary source too large');
      const events=[],next=[],records=new Map(this.store.records().map(r=>[r.itemId,r]));
      const sourceId=digest(source.path).slice(0,20),now=new Date().toISOString();
      for(let i=0;i<paragraphs.length;i++){
        const text=paragraphs[i],hash=digest(normalized(text));let identity=previous.seen[hash];
        if(identity){next.push({hash,...(typeof identity==='string'?{itemId:identity}:identity)});continue;}
        const old=previous.paragraphs[i],oldStillPresent=old&&paragraphs.some(p=>digest(normalized(p))===old.hash);
        // An unambiguous same-position edit keeps the item; all other new paragraphs get stable content IDs.
        const itemId=old&&!oldStillPresent?old.itemId:'diary:'+sourceId+':'+hash.slice(0,32),record=records.get(itemId);
        const sourceParents=old?.eventId?[old.eventId]:[];
        const eventId='diary:'+digest(sourceId+hash+stable(sourceParents));
        previous.seen[hash]={itemId,eventId};next.push({hash,itemId,eventId});
        if(record?.deleted)continue; // Re-reading an old file is never an explicit restore.
        const parents=sourceParents;
        if(this.store.events().some(e=>e.eventId===eventId))continue;
        events.push({eventId,itemId,personaId:this.personaId,origin:'diary',operation:'upsert',parents,occurredAt:now,
          value:{kind:'episode',text,visibility:source.visibility,certainty:'candidate',evidenceRefs:['diary:'+sourceId+':'+hash]}});
      }
      if(events.length)this.store.append(events);
      this.store.set(key,{paragraphs:next,seen:previous.seen});
    }
  }
  async pull(cursor='0'){this.scan();const events=this.store.events(),offset=Number(cursor);if(!/^\d+$/.test(cursor)||!Number.isSafeInteger(offset)||offset>events.length)throw Error('invalid diary cursor');return {events:events.slice(offset),nextCursor:String(events.length)};}
  async push(events){this.store.append(events);return {ackedEventIds:events.map(e=>e.eventId)};}
  async recall(query,tokenBudget){this.scan();return selectValues(this.store.records(),query,tokenBudget);}
  close(){this.store.close();}
}
