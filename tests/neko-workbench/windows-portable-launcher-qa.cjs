'use strict';
// Opt-in native extractor checks, with tiny synthetic archives and no app launch.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
if(process.platform!=='win32')throw Error('Windows extractor QA requires Windows');
const python=process.env.NEKO_ARCHIVE_PYTHON,stub=process.env.NEKO_LAUNCHER_STUB,output=process.env.NEKO_PACKAGE_QA_OUTPUT;
if(!python||!stub||!output)throw Error('Set NEKO_ARCHIVE_PYTHON, NEKO_LAUNCHER_STUB and NEKO_PACKAGE_QA_OUTPUT');
fs.mkdirSync(output,{recursive:true});
const dir=fs.mkdtempSync(path.join(output,'extractor-'));
function fixture(name,entries,corrupt=false){
  const input=path.join(dir,name+'.json'),zip=path.join(dir,name+'.zip'),exe=path.join(dir,name+'.exe');
  fs.writeFileSync(input,JSON.stringify(entries));
  const py=spawnSync(python,['-I','-B','-c','import sys,json,zipfile; z=zipfile.ZipFile(sys.argv[2],"x",zipfile.ZIP_DEFLATED); [z.writestr(k,v) for k,v in json.load(open(sys.argv[1],encoding="utf-8")).items()]; z.close()',input,zip],{encoding:'utf8',windowsHide:true});
  assert.equal(py.status,0,py.stderr);
  const data=fs.readFileSync(zip),footer=Buffer.alloc(48);footer.write('NEKOSFX1');footer.writeBigInt64LE(BigInt(data.length),8);crypto.createHash('sha256').update(data).digest().copy(footer,16);if(corrupt)data[0]^=1;
  fs.writeFileSync(exe,Buffer.concat([fs.readFileSync(stub),data,footer]));
  const target=path.join(dir,name+'-extracted'),result=spawnSync(exe,['--extract-only',target],{encoding:'utf8',windowsHide:true,timeout:30000});
  return {target,result};
}
const long='长路径/'+('segment-a-'.repeat(12))+'/'+('segment-b-'.repeat(12))+'/'+('segment-c-'.repeat(12))+'/完整工具依赖.txt';
const good=fixture('long-path',{'NEKOfuns.exe':'synthetic executable placeholder',[long]:'preserved'});
assert.equal(good.result.status,0,good.result.stderr);assert.equal(fs.readFileSync(path.join(good.target,long),'utf8'),'preserved');
const traversal=fixture('traversal',{'NEKOfuns.exe':'fixture','../outside.txt':'must not escape'});
assert.notEqual(traversal.result.status,0);assert(!fs.existsSync(path.join(dir,'outside.txt')));assert(!fs.existsSync(traversal.target));
const corrupt=fixture('corrupt',{'NEKOfuns.exe':'fixture'},true);assert.notEqual(corrupt.result.status,0);assert(!fs.existsSync(corrupt.target));
const existing=spawnSync(path.join(dir,'long-path.exe'),['--extract-only',good.target],{encoding:'utf8',windowsHide:true,timeout:30000});
assert.notEqual(existing.status,0);assert.equal(fs.readFileSync(path.join(good.target,long),'utf8'),'preserved');
console.log(JSON.stringify({ok:true,longPaths:true,traversalRejected:true,corruptionRejected:true,existingTargetPreserved:true,output:dir}));
