// The desktop host is a NEKO companion. The DSH root stays in the embedded DSH UI.
function migrateChatRouting(state){
  const main=state.actors.find(a=>a.id==='main');
  if(!['neko','chat-api','deepseek-account'].includes(main.chatBackend)){
    state.dshRoot={...main,id:'dsh-root',name:'DSH 主会话',present:false};
    const index=state.actors.indexOf(main);
    state.actors[index]={id:'main',name:main.name||'大肥鱼',chatBackend:state.neko?.enabled===true?'neko':'chat-api',sessionId:null,status:'idle',present:true,messages:[],work:{state:null,task:null,tick:0},workFlags:{goalRound:false,closing:null}};
  }
  state.dshRoot={id:'dsh-root',name:'DSH 主会话',sessionId:state.rootId,status:'idle',...state.dshRoot,
    messages:Array.isArray(state.dshRoot?.messages)?state.dshRoot.messages:[]};
  state.dshRoot.active=false;state.dshRoot.work={state:null,task:null,tick:0};state.dshRoot.workFlags={goalRound:false,closing:null};
  for(const actor of state.actors){delete actor.teamWork;delete actor.displayWork;delete actor.activeChildren;}
  state.neko={baseUrl:'http://127.0.0.1:48911',character:'',...state.neko,connection:'disconnected',error:''};
  state.neko.enabled=state.neko.enabled===true;
  state.version=7;
}
function actorBySession(state,id){return state.actors.find(a=>a.id!=='main'&&a.sessionId===id)||(id&&state.dshRoot?.sessionId===id?state.dshRoot:undefined);}
function bindNekoCharacter(state,{baseUrl,character}){
  const {neko}=state;
  if(neko.baseUrl===baseUrl&&neko.character===character)return;
  const actor=state.actors.find(a=>a.id==='main');
  const active=actor.chatBackend==='neko';
  const history=neko.historyByCharacter||={};
  if(neko.character)history[JSON.stringify([neko.baseUrl,neko.character])]=active?actor.messages:(neko.history||[]);
  neko.baseUrl=baseUrl;
  neko.character=character;
  neko.history=history[JSON.stringify([baseUrl,character])]||[];
  actor.nekoCharacter=character;
  if(active){
    actor.messages=neko.history;
    actor.chatReply=null;
    actor.lastUserMessage=null;
    actor.notice=null;
    actor.task=null;
    actor.currentActivity='';
    actor.status='idle';
    actor.active=false;
  }
}
module.exports={migrateChatRouting,actorBySession,bindNekoCharacter};
