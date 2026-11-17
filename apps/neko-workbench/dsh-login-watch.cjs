'use strict';

function createDshLoginWatch({getAccount,emit}){
 let active=null,disposed=false;
 function start(){
  if(disposed||active)return;
  let account;try{account=getAccount();}catch{return;}
  if(typeof account?.watch!=='function')return;
  const operation=new AbortController();active=operation;
  void(async()=>{
   try{for await(const state of account.watch(operation.signal)){
    if(disposed||operation.signal.aborted||active!==operation)break;
    const attempt=state?.attempt;
    if(attempt?.phase==='waiting-browser'&&typeof attempt.id==='string'&&attempt.id.length>0&&attempt.id.length<=160&&typeof attempt.authorizeUrl==='string'&&attempt.authorizeUrl.length<=16384){
     emit('dsh-login-attempt',{id:attempt.id,phase:'waiting-browser',authorizeUrl:attempt.authorizeUrl});
    }
   }}catch{}finally{if(active===operation)active=null;}
  })();
 }
 return Object.freeze({start,dispose(){disposed=true;active?.abort();active=null;}});
}

module.exports={createDshLoginWatch};
