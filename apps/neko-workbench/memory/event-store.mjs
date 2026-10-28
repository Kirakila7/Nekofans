import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemoryHub } from '../framework/reference/memory-hub.mjs';

export const capabilities = Object.freeze({protocol:1,pull:true,push:true,idempotency:true,tombstones:true,privateMemory:true});
export const stable = value => JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export function validateEvents(events, personaId, existing=[]) {
  // Transport batches are bounded by the adapter. A durable history is not a
  // request batch and must still reopen after it grows past that batch size.
  if(!Array.isArray(events))throw Error('invalid memory batch');
  for(const e of events){
    if(!e||typeof e!=='object'||typeof e.eventId!=='string'||!e.eventId||e.eventId.length>240||typeof e.itemId!=='string'||!e.itemId||e.itemId.length>240||!Array.isArray(e.parents)||e.parents.length>100||e.parents.some(id=>typeof id!=='string')||new Set(e.parents).size!==e.parents.length||e.parents.includes(e.eventId)||!Number.isFinite(Date.parse(e.occurredAt)))throw Error('invalid memory event');
    if(e.operation!=='delete'&&(!['fact','preference','episode','summary'].includes(e.value?.kind)||!Array.isArray(e.value?.evidenceRefs)||e.value.evidenceRefs.length>256||e.value.evidenceRefs.some(r=>typeof r!=='string'||r.length>1000)||!e.value.text?.trim()))throw Error('invalid memory value');
  }
  return new MemoryHub({personaId,adapters:{},snapshot:{personaId,mode:'diary',events:existing,cursors:{},acknowledgements:{}}}).validate(events,{personaId,events:existing});
}

/** A separate business database; never changes app.sqlite or the original diaries. */
export class EventStore {
  constructor(file,personaId='bigfish'){
    mkdirSync(dirname(file),{recursive:true,mode:0o700});this.personaId=personaId;
    this.db=new DatabaseSync(file);try{
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
      const owner=this.get('personaId');if(owner&&owner!==personaId)throw Error('memory persona mismatch');this.set('personaId',personaId);
    }catch(error){this.db.close();throw error;}
  }
  get(key){const row=this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);return row?JSON.parse(row.value):undefined;}
  set(key,value){this.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  events(){return this.db.prepare('SELECT body FROM events ORDER BY seq').all().map(r=>JSON.parse(r.body));}
  append(events){
    this.db.exec('BEGIN IMMEDIATE');try{
      const all=validateEvents(events,this.personaId,this.events()),insert=this.db.prepare('INSERT OR IGNORE INTO events(id,body) VALUES(?,?)');
      for(const event of all)insert.run(event.eventId,stable(event));this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  records(){return new MemoryHub({personaId:this.personaId,adapters:{},snapshot:{personaId:this.personaId,mode:'diary',events:this.events(),cursors:{},acknowledgements:{}}}).records();}
  close(){this.db.close();}
}
export function selectValues(records,query,budget){
  if(!Number.isInteger(budget)||budget<1)return [];
  const tokens=new Set((String(query).toLowerCase().match(/[a-z0-9]+|[\p{Script=Han}]/gu)||[]));
  const values=records.filter(r=>r.value&&!r.deleted&&!r.conflict&&(r.value.certainty!=='candidate'||['episode','summary'].includes(r.value.kind))).map(r=>r.value);
  const ranked=values.map((v,i)=>({v,i,score:[...tokens].filter(t=>v.text.toLowerCase().includes(t)).length})).sort((a,b)=>b.score-a.score||b.i-a.i);
  let used=0;return ranked.flatMap(({v})=>{const cost=JSON.stringify(v).length;if(used+cost>budget*2)return [];used+=cost;return [structuredClone(v)];});
}
