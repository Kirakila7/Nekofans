'use strict';
const ID=/^[a-zA-Z0-9_-]{1,100}$/;
function authorizeSpeak({senderId,enabled,expected,input}){
  if(senderId!=='main'||!enabled||typeof expected!=='string'||!expected||!input||Array.isArray(input)||typeof input!=='object'||input.text!==expected||typeof input.requestId!=='string'||!ID.test(input.requestId))throw new Error('语音请求无效');
}
function authorizeStop({senderId,isSettings,input}){
  if(isSettings)return;
  if(senderId!=='main'||!input||Array.isArray(input)||typeof input!=='object'||typeof input.requestId!=='string'||!ID.test(input.requestId))throw new Error('语音请求无效');
}
module.exports={authorizeSpeak,authorizeStop};
