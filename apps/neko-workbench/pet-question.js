'use strict';
const form=window.WorkbenchQuestions.mount({host:document.getElementById('questions'),onAction:value=>window.taskQuestions.action(value),onVisibility:(open,q)=>{if(!open&&q)void window.taskQuestions.action({type:'hide',sessionId:q.sessionId,key:q.key,revision:q.revision}).catch(()=>{});}});
const stop=window.taskQuestions.subscribe(value=>{form.update(value);if(value?.reveal)form.show();});window.addEventListener('unload',()=>{stop();form.dispose();},{once:true});
