const {EventEmitter}=require('node:events');
const {randomUUID}=require('node:crypto');
const bigfish=require('./neko-bigfish.json');
function localBase(value){
  const url=new URL(value||'http://127.0.0.1:48911');
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw new Error('请填写本机 N.E.K.O. 服务地址，例如 http://127.0.0.1:48911');
  return url.origin;
}
class NekoChat extends EventEmitter{
  constructor({fetchImpl=globalThis.fetch,WebSocketImpl=globalThis.WebSocket,timeout=120000}={}){super();this.fetch=fetchImpl;this.WebSocket=WebSocketImpl;this.timeout=timeout;this.generation=0;}
  async connect(config){
    this.close();const generation=++this.generation,controller=new AbortController();this.connectionAbort=controller;this.baseUrl=localBase(config.baseUrl);this.emit('connection',{connection:'connecting',error:''});
    try{
      const response=await this.fetch(this.baseUrl+'/api/characters',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(6000)])});
      if(!response.ok)throw new Error('N.E.K.O. 角色读取失败（'+response.status+'）');
      let data=await response.json(),names=Object.keys(data['猫娘']||{});
      const character=config.character||'大肥鱼';
      if(generation!==this.generation)return;
      if(character==='大肥鱼'&&!names.includes(character)){
        const created=await this.fetch(this.baseUrl+'/api/characters/catgirl',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(bigfish),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
        const result=await created.json();
        if(generation!==this.generation)return;
        if(!created.ok||!result.success)throw new Error('N.E.K.O. 大肥鱼角色创建失败，请在原界面检查。');
        if(result.character_name!==character)throw new Error('N.E.K.O. 角色名称发生冲突，请在聊天设置中选择。');
        names=[...names,character];this.emit('profile-created',{character,memoryServerReloaded:result.memory_server_reloaded===true});
      }
      if(!character||!names.includes(character))throw new Error('没有找到 N.E.K.O. 角色，请在设置中选择。');
      if(generation!==this.generation)return;
      this.character=character;this.emit('characters',{names,character});
      const socket=new this.WebSocket(this.baseUrl.replace(/^http:/,'ws:')+'/ws/'+encodeURIComponent(character));this.socket=socket;
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{socket.close();reject(new Error('N.E.K.O. 连接超时'));},7000);
        socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
        socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('N.E.K.O. 连接失败'));},{once:true});
      });
      if(generation!==this.generation){socket.close();return;}
      socket.addEventListener('message',event=>{if(generation!==this.generation||typeof event.data!=='string')return;try{this.receive(JSON.parse(event.data));}catch{}});
      socket.addEventListener('close',()=>{if(generation!==this.generation)return;this.fail(new Error('N.E.K.O. 连接已断开'));this.emit('connection',{connection:'disconnected',error:'N.E.K.O. 连接已断开'});});
      this.ping=setInterval(()=>{if(socket.readyState===1)socket.send(JSON.stringify({action:'ping'}));},25000);
      this.emit('connection',{connection:'ready',error:''});
    }catch(error){if(generation!==this.generation)return;this.emit('connection',{connection:'disconnected',error:error.message.startsWith('N.E.K.O.')||error.message.startsWith('没有找到')?error.message:'N.E.K.O. 未启动，右键可重新连接。'});throw error;}
  }
  send(text,{environmentContext}={}){
    if(this.socket?.readyState!==1)throw new Error('N.E.K.O. 未连接，右键可以重新连接。');
    if(this.pending)throw new Error('我还在回复，等我一下。');
    const requestId='dshpet-'+randomUUID();
    this.pending={requestId,text:'',turnId:null,timer:setTimeout(()=>this.fail(new Error('N.E.K.O. 回复超时，请在原界面查看后重试。')),this.timeout)};
    const data=typeof environmentContext==='string'&&environmentContext?text+'\n\n'+environmentContext.slice(0,18000):text;
    this.socket.send(JSON.stringify({action:'stream_data',input_type:'text',data,request_id:requestId,render_language:'zh-CN'}));
    this.emit('start',{requestId});return {requestId,character:this.character};
  }
  receive(message){
    const pending=this.pending;
    if(message.type==='catgirl_switched'){this.emit('connection',{connection:'disconnected',error:'N.E.K.O. 角色已切换，右键重新连接。'});this.fail(new Error('N.E.K.O. 角色已切换。'));return;}
    if(!pending)return;
    if(message.request_id&&message.request_id!==pending.requestId)return;
    if(message.type==='gemini_response'){
      if(message.turn_id&&pending.turnId&&message.turn_id!==pending.turnId)return;
      if(message.turn_id)pending.turnId=message.turn_id;
      if(typeof message.text==='string'){pending.text+=message.text;this.emit('reply',{requestId:pending.requestId,text:pending.text});}
    }
    if(message.type==='response_discarded'&&!message.will_retry){this.fail(new Error('N.E.K.O. 未能完成这次回复，请重试。'));return;}
    if(message.type==='response_discarded'&&message.will_retry){pending.text='';pending.turnId=null;return;}
    if(message.type==='session_failed'){this.fail(new Error('N.E.K.O. 会话启动失败，请检查原界面的模型设置。'));return;}
    if(message.type==='status'){
      let status;try{status=typeof message.message==='string'?JSON.parse(message.message):message.message;}catch{}
      if(/(?:ERROR|FAILED|INSUFFICIENT|QUOTA_EXCEEDED|UNAUTHORIZED|API_KEY_MISSING)/u.test(status?.code||'')){this.fail(new Error('N.E.K.O. 暂时无法回复（'+status.code+'），请在原界面检查。'));return;}
    }
    if(message.type==='system'&&message.data==='turn end'){
      if(message.turn_id&&pending.turnId&&message.turn_id!==pending.turnId)return;
      if(!pending.text.trim())return;
      clearTimeout(pending.timer);this.pending=null;this.emit('complete',{requestId:pending.requestId,text:pending.text});
    }
  }
  fail(error){if(!this.pending)return;clearTimeout(this.pending.timer);this.pending=null;this.emit('failure',error);}
  close(){this.generation++;this.connectionAbort?.abort();this.connectionAbort=null;clearInterval(this.ping);this.fail(new Error('N.E.K.O. 连接已关闭'));this.socket?.close();this.socket=null;}
}
module.exports={NekoChat,localBase};
