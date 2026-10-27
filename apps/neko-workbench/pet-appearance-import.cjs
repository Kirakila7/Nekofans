'use strict';
const fs=require('node:fs'),path=require('node:path');
const {MAX_CUSTOM_BYTES,validCustom}=require('./pet-appearance.js');
function rasterMime(bytes){
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(/^GIF8[79]a/.test(bytes.subarray(0,6).toString()))return 'image/gif';
  if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  return null;
}
function animationFrames(bytes,mime=rasterMime(bytes)){
  if(mime==='image/webp'){
    let count=0;for(let pos=12;pos+8<=bytes.length;){const length=bytes.readUInt32LE(pos+4),end=pos+8+length;if(end>bytes.length)return 0;if(bytes.subarray(pos,pos+4).toString()==='ANMF')count++;pos=end+(length%2);}return count;
  }
  if(mime!=='image/gif'||bytes.length<13)return 0;
  let pos=13+((bytes[10]&128)?3*(2**((bytes[10]&7)+1)):0),count=0;
  const blocks=()=>{while(pos<bytes.length){const size=bytes[pos++];if(!size)return true;if(pos+size>bytes.length)return false;pos+=size;}return false;};
  while(pos<bytes.length&&count<=10000){const tag=bytes[pos++];if(tag===59)return count;if(tag===33){pos++;if(!blocks())return 0;}else if(tag===44){if(pos+9>bytes.length)return 0;const packed=bytes[pos+8];pos+=9;if(packed&128)pos+=3*(2**((packed&7)+1));pos++;if(!blocks())return 0;count++;}else return 0;}
  return 0;
}
async function importAppearanceImage(file,decodePoster){
  let fd;
  try{
    fd=fs.openSync(file,'r');const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size===0||stat.size>MAX_CUSTOM_BYTES)throw Error('请选择不超过 4 MB 的图片');
    const bytes=fs.readFileSync(fd),mime=rasterMime(bytes);if(!['image/gif','image/webp'].includes(mime))throw Error('请选择会动的 GIF 或 WebP');
    const frameCount=animationFrames(bytes,mime);if(frameCount<2||frameCount>10000)throw Error('这张图片不是多帧动图，请选择动画 GIF 或 WebP');
    const headerSize=mime==='image/png'&&bytes.length>=24?{width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)}:mime==='image/gif'&&bytes.length>=10?{width:bytes.readUInt16LE(6),height:bytes.readUInt16LE(8)}:null;
    if(headerSize&&(headerSize.width>2048||headerSize.height>2048))throw Error('图片长宽需在 1～2048 像素之间');
    const dataUrl=`data:${mime};base64,${bytes.toString('base64')}`,size=await decodePoster(dataUrl);if(size.width<1||size.height<1||size.width>2048||size.height>2048)throw Error('图片长宽需在 1～2048 像素之间');
    const value={animated:true,frameCount,name:path.basename(file,path.extname(file)),stillDataUrl:size.stillDataUrl,dataUrl};if(!validCustom(value))throw Error('图片格式无效');return value;
  }finally{if(fd!==undefined)fs.closeSync(fd);}
}
module.exports={rasterMime,animationFrames,importAppearanceImage};
