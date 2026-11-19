// The desktop host is a NEKO companion. The DSH root stays in the embedded DSH UI.
function migrateChatRouting(state){
  let main=state.actors.find(a=>a.id==='main');
  const knownBackend=['chat-api','deepseek-account'].includes(main.chatBackend)||main.chatBackend===null;
  const legacyLocalChat=main.chatBackend==='neko'||!knownBackend&&state.neko?.enabled===true;
  if(!knownBackend&&main.chatBackend!=='neko'){
    state.dshRoot={...main,id:'dsh-root',name:'DSH 主会话',present:false};
    const index=state.actors.indexOf(main);
    main={id:'main',name:main.name||'大肥鱼',chatBackend:'chat-api',sessionId:null,status:'idle',present:true,messages:[],work:{state:null,task:null,tick:0},workFlags:{goalRound:false,closing:null}};
    state.actors[index]=main;
  }
  state.dshRoot={id:'dsh-root',name:'DSH 主会话',sessionId:state.rootId,status:'idle',...state.dshRoot,
    messages:Array.isArray(state.dshRoot?.messages)?state.dshRoot.messages:[]};
  state.dshRoot.active=false;state.dshRoot.work={state:null,task:null,tick:0};state.dshRoot.workFlags={goalRound:false,closing:null};
  for(const actor of state.actors){delete actor.teamWork;delete actor.displayWork;delete actor.activeChildren;}
  state.neko={baseUrl:'http://127.0.0.1:48911',character:'大肥鱼',...state.neko,connection:'disabled',error:''};
  state.neko.character||='大肥鱼';
  if(legacyLocalChat){
    if(main.messages?.length)state.neko.history=main.messages;
    state.neko.chatMoved=true;
    main.chatBackend=null;
    main.messages=[];
    main.chatReply=null;
    main.lastUserMessage=null;
    main.status='idle';
    main.active=false;
    main.currentActivity='';
    main.work={state:null,task:null,tick:0};
  }
  state.neko.enabled=false;
  state.version=7;
}
function actorBySession(state,id){return state.actors.find(a=>a.id!=='main'&&a.sessionId===id)||(id&&state.dshRoot?.sessionId===id?state.dshRoot:undefined);}
module.exports={migrateChatRouting,actorBySession};
