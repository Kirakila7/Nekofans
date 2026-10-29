(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.NekoTtsPlayer=api;})(globalThis,function(){
  'use strict';
  // Bridge: speak(text, requestId), stop(requestId), onEvent(handler)->unsubscribe.
  // The caller creates the ID before requesting synthesis, so the first PCM
  // frame is accepted even if it arrives before the IPC invocation resolves.
  function createPlayer({bridge,context,createId,onState=()=>{},schedule=setTimeout,cancel=clearTimeout}) {
    if(!bridge||!context||typeof bridge.onEvent!=='function')throw new TypeError('invalid TTS player dependencies');
    const makeId=createId||(()=>globalThis.crypto.randomUUID());
    let current=null,closed=false,generation=0;
    function notify(type,id){try{onState({type,requestId:id});}catch{}}
    function disposeTurn(turn){
      if(!turn||turn.disposed)return;turn.disposed=true;
      for(const timer of turn.timers)cancel(timer);turn.timers.clear();
      for(const source of turn.sources){try{source.onended=null;source.stop();source.disconnect();}catch{}}turn.sources.clear();
    }
    function end(turn,type){if(current!==turn)return;disposeTurn(turn);current=null;notify(type,turn.id);}
    function maybeFinish(turn){if(current===turn&&turn.complete&&turn.sources.size===0)end(turn,'ended');}
    function decode(pcm,rate){
      if(typeof pcm!=='string'||pcm.length>4*1024*1024||!Number.isInteger(rate)||rate!==48000)throw new Error('invalid audio frame');
      const binary=globalThis.atob(pcm);if(!binary.length||binary.length%2)throw new Error('invalid audio frame');
      const buffer=context.createBuffer(1,binary.length/2,rate),out=buffer.getChannelData(0);
      for(let i=0;i<out.length;i++){let n=binary.charCodeAt(i*2)|(binary.charCodeAt(i*2+1)<<8);if(n&0x8000)n-=65536;out[i]=n/32768;}
      return buffer;
    }
    function receive(event){
      const turn=current;if(!turn||turn.disposed||event?.requestId!==turn.id)return;
      if(event.type==='audio'){
        if(turn.complete)return;
        try{
          const buffer=decode(event.pcm,event.sampleRate),source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);
          const start=Math.max(context.currentTime+0.03,turn.nextTime);turn.nextTime=start+buffer.duration;turn.sources.add(source);
          source.onended=()=>{turn.sources.delete(source);try{source.disconnect();}catch{}maybeFinish(turn);};
          source.start(start);
          if(!turn.started&&!turn.startScheduled){turn.startScheduled=true;const timer=schedule(()=>{turn.timers.delete(timer);if(current===turn&&!turn.disposed&&context.state==='running'&&!turn.started){turn.started=true;notify('speaking',turn.id);}},Math.max(0,(start-context.currentTime)*1000));turn.timers.add(timer);}
        }catch{void bridge.stop(turn.id).catch(()=>{});end(turn,'error');}
      }else if(event.type==='ended'){turn.complete=true;maybeFinish(turn);}
      else if(event.type==='error'||event.type==='stopped')end(turn,event.type);
    }
    const off=bridge.onEvent(receive);
    async function stopTurn(){const turn=current;if(!turn)return;end(turn,'stopped');try{await bridge.stop(turn.id);}catch{}}
    async function stop(){generation++;await stopTurn();}
    async function speak(text){
      if(closed)throw new Error('player closed');if(typeof text!=='string'||!text.trim())throw new Error('empty speech');
      const token=++generation;await stopTurn();if(closed)throw new Error('player closed');if(token!==generation)return null;
      const id=makeId();if(typeof id!=='string'||!id)throw new Error('invalid request id');
      const turn={id,nextTime:context.currentTime,sources:new Set(),timers:new Set(),started:false,startScheduled:false,complete:false,disposed:false};current=turn;notify('queued',id);
      try{if(context.state!=='running')await context.resume();if(current!==turn)return id;await bridge.speak(text,id);}
      catch(error){if(current===turn)end(turn,'error');throw error;}return id;
    }
    async function close(){if(closed)return;closed=true;await stop();off?.();}
    return Object.freeze({speak,stop,close});
  }
  return Object.freeze({createPlayer});
});
