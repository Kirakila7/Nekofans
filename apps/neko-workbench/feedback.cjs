'use strict';
// Public project contacts. Requests select a fixed ID, never a renderer URL.
const contacts=Object.freeze({author:'Acekira',email:'acekira3@gmail.com',qqGroup:'1130382639',bilibili:'https://space.bilibili.com/142818715',github:'https://github.com/Kirakila7/Nekofans',issues:'https://github.com/Kirakila7/Nekofans/issues/new'});
function createFeedback({openExternal,copyText}){
  return async input=>{
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['action','target'].includes(k)))throw Error('未知反馈操作');
    const {action,target}=input;
    if(action==='copy'&&['email','qqGroup'].includes(target)){await copyText(contacts[target]);return {ok:true};}
    if(action==='open'&&['email','bilibili','github','issues'].includes(target)){
      await openExternal(target==='email'?'mailto:'+contacts.email+'?subject='+encodeURIComponent('Nekofans 使用反馈'):contacts[target]);return {ok:true};
    }
    throw Error('未知反馈操作');
  };
}
module.exports={contacts,createFeedback};
