// Historical v0.7 aggregation; unused since v0.9 NEKO companion routing.
// Keep the root session's real state intact; only its pet presentation aggregates children.
function projectMainWork(actors,now=Date.now()){
  const main=actors.find(a=>a.id==='main');if(!main)return;
  const children=actors.filter(a=>a.id!=='main'&&a.metadataReady),active=children.filter(a=>a.active);
  const team=main.teamWork||{running:false,sessionIds:[],until:0};
  let next=main.work;
  if(active.length){
    if(!team.running)team.sessionIds=[];
    team.running=true;team.until=0;
    team.sessionIds=[...new Set([...team.sessionIds,...active.map(a=>a.sessionId)])];
    next={state:'working',task:null};
  }else{
    if(team.running){
      team.running=false;
      const ended=children.filter(a=>team.sessionIds.includes(a.sessionId));
      team.result=main.work.state==='error'||ended.some(a=>a.status==='error')?'error':ended.some(a=>a.status==='success')?'success':null;
      team.until=team.result?now+10000:0;
    }
    if(main.active)team.until=0;
    else if(team.until>now)next={state:team.result,task:null};
  }
  const previous=main.displayWork;
  if(!previous||previous.state!==next.state||previous.task!==next.task)main.displayWork={state:next.state,task:next.task??null,tick:(previous?.tick||0)+1};
  main.teamWork=team;main.activeChildren=active.length;
}
module.exports={projectMainWork};
