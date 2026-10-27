'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {importAppearanceImage}=require('../../apps/neko-workbench/pet-appearance-import.cjs');
const {validCustom}=require('../../apps/neko-workbench/pet-appearance.js');
test('native import preserves a real GIF and safe first frame, rejects active formats, oversized headers and invalid decode',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'neko-appearance-import-'));
 try{
  const base=path.resolve(__dirname,'../../apps/neko-workbench/assets/neko-cat'),png=fs.readFileSync(path.join(base,'still.png'));let decoded=0;
  const decodePoster=async()=>{decoded++;return{width:512,height:512,stillDataUrl:'data:image/png;base64,'+png.toString('base64')};};
  const value=await importAppearanceImage(path.join(base,'cat-idle-cat4-3.gif'),decodePoster);assert(validCustom(value));assert(value.dataUrl.startsWith('data:image/gif;base64,'));assert(value.stillDataUrl.startsWith('data:image/png;base64,'));
  const svg=path.join(dir,'fake.png');fs.writeFileSync(svg,'<svg onload="alert(1)"></svg>');await assert.rejects(importAppearanceImage(svg,decodePoster),/GIF 或 WebP/);assert.equal(decoded,1);
  const huge=fs.readFileSync(path.join(base,'cat-idle-cat4-3.gif'));huge.writeUInt16LE(9000,6);fs.writeFileSync(svg,huge);await assert.rejects(importAppearanceImage(svg,decodePoster),/2048/);assert.equal(decoded,1);
  fs.writeFileSync(svg,png);await assert.rejects(importAppearanceImage(svg,decodePoster),/GIF 或 WebP/);
  await assert.rejects(importAppearanceImage(path.join(base,'cat-idle-cat4-3.gif'),async()=>{throw Error('invalid image');}),/invalid image/);
  const staticWebP=Buffer.from('RIFF'+String.fromCharCode(12,0,0,0)+'WEBPVP8 '+String.fromCharCode(0,0,0,0),'binary');fs.writeFileSync(svg,staticWebP);await assert.rejects(importAppearanceImage(svg,decodePoster),/不是多帧/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
