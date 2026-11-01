'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fish-junction-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const allowed=path.join(dir,'allowed'),outside=path.join(dir,'outside');fs.mkdirSync(allowed);fs.mkdirSync(outside);
 const file=path.join(allowed,'diary.md');fs.writeFileSync(file,'safe');fs.writeFileSync(path.join(outside,'diary.md'),'outside');
 let guard;const agent={ctx:{inject(_names,install){const ready={state:2,dispose:async()=>{}};const fiber=Promise.resolve(ready);fiber.state=2;fiber.dispose=ready.dispose;install({tools:{guard(fn){guard=fn}}});return fiber;}}};
 const {createListeningScope}=await import(pathToFileURL(path.resolve(__dirname,'../../apps/neko-workbench/vendor/dsh-bili-whale/lib/read-scope.js')));
 const scope=await createListeningScope(agent,{cwd:dir,files:[file],isWriteAllowed:()=>false});t.after(()=>scope.dispose());return {dir,allowed,outside,file,guard};
}
test('read-only listener rejects a real Windows hard link',async t=>{
 const {file,dir,guard}=await fixture(t);fs.linkSync(file,path.join(dir,'second-link.md'));
 assert.match(guard({name:'write',arguments:{file_path:file}}),/链接/);
});
test('read-only listener rejects a file reported as a symbolic link',async t=>{
 const {file,guard}=await fixture(t),original=fs.lstatSync;
 t.mock.method(fs,'lstatSync',(candidate,...args)=>candidate===file?{isFile:()=>false,isSymbolicLink:()=>true,nlink:1}:original(candidate,...args));
 assert.match(guard({name:'write',arguments:{file_path:file}}),/链接/);
});
test('read-only listener rejects a parent directory redirected by a Windows junction',async t=>{
 const {allowed,outside,file,guard}=await fixture(t);fs.renameSync(allowed,allowed+'-original');fs.symlinkSync(outside,allowed,'junction');
 assert.match(guard({name:'write',arguments:{file_path:file}}),/链接/);
});
