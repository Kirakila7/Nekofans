'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const marker=/\n?\[\[neko-media:([A-Za-z0-9_-]{1,6000})\]\]/g;
function splitMessage(text){
 const attachments=[];
 const clean=String(text||'').replace(marker,(original,encoded)=>{
  try{
   const values=JSON.parse(Buffer.from(encoded,'base64url').toString());
   if(!Array.isArray(values)||!values.length||values.length>4)return original;
   if(!values.every(v=>/^[a-f0-9]{64}$/.test(v?.id)&&typeof v.name==='string'&&['image/png','image/jpeg','image/gif','image/webp'].includes(v.mime)))return original;
   for(const v of values)attachments.push({id:v.id,name:v.name.slice(0,100),mime:v.mime,kind:v.kind==='sticker'?'sticker':'image'});
   return '';
  }catch{return original;}
 });
 return {text:attachments.length?clean.trim():clean,attachments};
}
function mime(bytes){if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';if(/^GIF8[79]a$/.test(bytes.subarray(0,6).toString()))return 'image/gif';if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';throw Error('仅支持 PNG、JPEG、GIF 和 WebP 图片');}
function createCompanionMedia(dataDir){
 const dir=path.join(dataDir,'media');
 function file(id){if(!/^[a-f0-9]{64}$/.test(id))throw Error('图片标识无效');if(fs.existsSync(dir)&&fs.lstatSync(dir).isSymbolicLink())throw Error('图片目录无效');const target=path.join(dir,id+'.bin');if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw Error('图片文件无效');return target;}
 function read(id){const bytes=fs.readFileSync(file(id));if(bytes.length>4*1024*1024)throw Error('图片过大');return {dataUrl:'data:'+mime(bytes)+';base64,'+bytes.toString('base64')};}
 function prepare(text,input){if(!Array.isArray(input)||input.length>4)throw Error('每条消息最多附加四张图片');let total=0;const attachments=input.map(v=>{if(!v||typeof v.dataUrl!=='string'||v.dataUrl.length>6*1024*1024)throw Error('图片无效或过大');const match=/^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(v.dataUrl);if(!match)throw Error('图片格式无效');const bytes=Buffer.from(match[2],'base64');total+=bytes.length;if(bytes.length>4*1024*1024||total>12*1024*1024)throw Error('单图最多 4MB，每条消息最多 12MB');const type=mime(bytes);if(type!=='image/'+match[1])throw Error('图片内容与格式不符');const id=crypto.createHash('sha256').update(bytes).digest('hex'),target=file(id);fs.mkdirSync(dir,{recursive:true,mode:0o700});try{fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}return {id,mime:type,name:String(v.name||'图片').replace(/[\r\n\0]/g,'').slice(0,100),kind:v.kind==='sticker'?'sticker':'image'};});const result=String(text||'').trim()+(attachments.length?'\n[[neko-media:'+Buffer.from(JSON.stringify(attachments)).toString('base64url')+']]':'');if(result.length>8000)throw Error('消息文字过长，请减少一些文字');return result;}
 function modelText(text){const parsed=splitMessage(text);return parsed.text+(parsed.attachments.length?'\n[用户附加了图片或表情包。当前账号聊天线路不提供图片内容，请勿编造图片内容；可结合附带文字回应。]':'');}
 function wrapFetch(fetcher,protocol){return async(url,init)=>{if(typeof init?.body!=='string')return fetcher(url,init);const body=JSON.parse(init.body);if(!Array.isArray(body.messages))return fetcher(url,init);let imageCount=0,imageBytes=0;body.messages=body.messages.slice().reverse().map(message=>{if(message.role!=='user'||typeof message.content!=='string')return message;const parsed=splitMessage(message.content);if(!parsed.attachments.length)return message;const blocks=[{type:'text',text:parsed.text||'看看我发来的图片'}];for(const attachment of parsed.attachments){if(protocol==='anthropic'&&attachment.mime==='image/gif'){blocks.push({type:'text',text:'[用户发送了 GIF 表情包，当前协议无法直接读取此格式]'});continue;}if(imageCount>=4){blocks.push({type:"text",text:"[较早图片已保留在聊天记录中]"});continue;}const {dataUrl}=read(attachment.id);imageBytes+=dataUrl.length*3/4;if(imageBytes>12*1024*1024)continue;imageCount++;blocks.push(protocol==='anthropic'?{type:'image',source:{type:'base64',media_type:attachment.mime,data:dataUrl.split(',')[1]}}:{type:'image_url',image_url:{url:dataUrl}});}return {...message,content:blocks};}).reverse();return fetcher(url,{...init,body:JSON.stringify(body)});};}
 return {prepare,read,modelText,wrapFetch,splitMessage};
}
module.exports={createCompanionMedia,splitMessage};
