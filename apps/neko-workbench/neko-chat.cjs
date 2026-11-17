const {EventEmitter}=require('node:events');
const {randomUUID}=require('node:crypto');
function localBase(value){
  const url=new URL(value||'http://127.0.0.1:48911');
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw new Error('请填写本机 N.E.K.O. 服务地址，例如 http://127.0.0.1:48911');
  return url.origin;
}
class NekoChat extends EventEmitter{
  constructor({fetchImpl=globalThis.fetch,WebSocketImpl=globalThis.WebSocket,timeout=120000}={}){super();this.fetch=fetchImpl;this.WebSocket=WebSocketImpl;this.timeout=timeout;this.generation=0;}
  async listCharacters(value,signal=AbortSignal.timeout(6000)){
    const baseUrl=localBase(value);
    let response;
    try{
      response=await this.fetch(baseUrl+'/api/characters',{signal,redirect:'error'});
    }catch(error){
      if(signal.aborted)throw error;
      throw new Error('N.E.K.O. 未连接，请检查本机服务地址和运行状态。');
    }
    if(!response.ok)throw new Error('N.E.K.O. 角色读取失败（'+response.status+'）');
    const data=await response.json().catch(()=>null);
    const characters=data?.['猫娘'];
    if(!characters||typeof characters!=='object'||Array.isArray(characters))throw new Error('N.E.K.O. 返回了无法识别的角色列表。');
    return Object.keys(characters);
  }
  async connect(config){
    this.close();const generation=++this.generation,controller=new AbortController();this.connectionAbort=controller;
    this.emit('connection',{connection:'connecting',error:''});
    try{
      const baseUrl=localBase(config.baseUrl),character=config.character;
      const names=await this.listCharacters(baseUrl,AbortSignal.any([controller.signal,AbortSignal.timeout(6000)]));
      if(generation!==this.generation)return;
      if(!names.includes(character))throw new Error('没有找到已绑定的 N.E.K.O. 角色，请在设置中重新选择。');
      this.character=character;
      const socket=new this.WebSocket(baseUrl.replace(/^http:/,'ws:')+'/ws/'+encodeURIComponent(character));this.socket=socket;
      socket.addEventListener('message',event=>{if(generation!==this.generation||typeof event.data!=='string')return;try{this.receive(JSON.parse(event.data));}catch{}});
      socket.addEventListener('close',()=>{
        if(generation!==this.generation)return;
        this.textSessionReady=false;
        clearInterval(this.ping);
        this.fail(new Error('N.E.K.O. 连接已断开'));
        this.emit('connection',{connection:'disconnected',error:'N.E.K.O. 连接已断开'});
      });
      await new Promise((resolve,reject)=>{
        const listeners=new AbortController();
        const options={once:true,signal:listeners.signal};
        const finish=error=>{
          clearTimeout(timer);
          listeners.abort();
          if(error)reject(error);else resolve();
        };
        const timer=setTimeout(()=>finish(new Error('N.E.K.O. 连接超时')),7000);
        socket.addEventListener('open',()=>finish(),options);
        socket.addEventListener('error',()=>finish(new Error('N.E.K.O. 连接失败')),options);
        socket.addEventListener('close',()=>finish(new Error('N.E.K.O. 连接已断开')),options);
        controller.signal.addEventListener('abort',()=>finish(controller.signal.reason),options);
      });
      if(generation!==this.generation){socket.close();return;}
      this.ping=setInterval(()=>{if(socket.readyState===1)socket.send(JSON.stringify({action:'ping'}));},25000);
      this.emit('connection',{connection:'ready',error:''});
    }catch(error){if(generation!==this.generation)return;this.close();this.emit('connection',{connection:'disconnected',error:error.message.startsWith('N.E.K.O.')||error.message.startsWith('没有找到')?error.message:'N.E.K.O. 未启动，右键可重新连接。'});throw error;}
  }
  send(text,{environmentContext}={}){
    if(this.socket?.readyState!==1)throw new Error('N.E.K.O. 未连接，右键可以重新连接。');
    if(this.pending)throw new Error('我还在回复，等我一下。');
    const requestId='dshpet-'+randomUUID();
    const data=typeof environmentContext==='string'&&environmentContext?text+'\n\n'+environmentContext.slice(0,18000):text;
    this.pending={requestId,text:'',turnId:null,data,timer:setTimeout(()=>this.fail(new Error('N.E.K.O. 回复超时，请在原界面查看后重试。')),this.timeout)};
    try{
      if(this.textSessionReady)this.sendPendingText();
      else this.socket.send(JSON.stringify({action:'start_session',input_type:'text',new_session:false,language:'zh-CN'}));
    }catch(error){this.fail(error);throw error;}
    this.emit('start',{requestId});return {requestId,character:this.character};
  }
  sendPendingText(){
    const pending=this.pending;
    if(!pending||pending.data===undefined)return;
    this.socket.send(JSON.stringify({action:'stream_data',input_type:'text',data:pending.data,request_id:pending.requestId,render_language:'zh-CN'}));
    delete pending.data;
  }
  receive(message){
    let status;
    if(message.type==='status'){try{status=typeof message.message==='string'?JSON.parse(message.message):message.message;}catch{}}
    if(message.type==='catgirl_switched'||status?.code==='CHARACTER_SWITCHING_TERMINAL'){
      this.close();
      const error=message.type==='catgirl_switched'
        ?'N.E.K.O. 角色已切换，请在设置中检查原绑定。'
        :'N.E.K.O. 的另一个窗口已接管连接，请从设置重新连接。';
      this.emit('connection',{connection:'reconnect-required',error});
      return;
    }
    if(message.type==='session_started'&&(!message.input_mode||message.input_mode==='text')){
      this.textSessionReady=true;
      try{this.sendPendingText();}catch(error){this.fail(error);}
      return;
    }
    if(message.type==='session_ended_by_server'||message.type==='session_failed')this.textSessionReady=false;
    const pending=this.pending;
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
    if(message.type==='session_ended_by_server'){this.fail(new Error('N.E.K.O. 已结束这次会话，请重试。'));return;}
    if(message.type==='status'){
      if(/(?:ERROR|FAILED|INSUFFICIENT|QUOTA_EXCEEDED|UNAUTHORIZED|API_KEY_MISSING)/u.test(status?.code||'')){this.fail(new Error('N.E.K.O. 暂时无法回复（'+status.code+'），请在原界面检查。'));return;}
    }
    if(message.type==='system'&&message.data==='turn end'){
      if(message.turn_id&&pending.turnId&&message.turn_id!==pending.turnId)return;
      if(!pending.text.trim())return;
      clearTimeout(pending.timer);this.pending=null;this.emit('complete',{requestId:pending.requestId,text:pending.text});
    }
  }
  fail(error){if(!this.pending)return;clearTimeout(this.pending.timer);this.pending=null;this.emit('failure',error);}
  close(){this.generation++;this.connectionAbort?.abort();this.connectionAbort=null;this.textSessionReady=false;clearInterval(this.ping);this.fail(new Error('N.E.K.O. 连接已关闭'));this.socket?.close();this.socket=null;}
}
module.exports={NekoChat,localBase};
