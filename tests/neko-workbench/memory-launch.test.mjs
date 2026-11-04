import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {memoryLaunch} from '../../apps/neko-workbench/memory/neko-adapter.mjs';

test('bundled direct Python initializes .pth dependencies with literal Unicode/space paths, without uv',t=>{
  const dir=mkdtempSync(join(tmpdir(),'neko-memory-中文 空格-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const libs=join(dir,'libs'),extra=join(libs,'extra');mkdirSync(extra,{recursive:true});
  writeFileSync(join(libs,'fixture.pth'),'extra\n');writeFileSync(join(extra,'fixture.py'),'VALUE="direct-runtime-ready"\n');
  writeFileSync(join(dir,'entry_sibling.py'),'VALUE="adjacent-module-ready"\n');
  writeFileSync(join(dir,'workbench_server.py'),'import fixture,entry_sibling,sys\nprint(fixture.VALUE)\nassert entry_sibling.VALUE=="adjacent-module-ready"\nassert len(sys.argv)==1\n');
  const python=process.env.NEKO_TEST_PYTHON;
  // The executable path can be verified structurally without a Python runtime;
  // the packaged-runtime acceptance also executes this launch in native tests.
  const direct=python||process.execPath;
  const launch=memoryLaunch({directory:dir,env:{NEKO_WORKBENCH_MEMORY_PYTHON_DIRECT:direct,NEKO_WORKBENCH_MEMORY_PYTHON_LIBS:libs}});
  assert.equal(launch.command,direct);assert.equal(launch.args.at(-2),libs);assert.equal(launch.args.at(-1),join(dir,'workbench_server.py'));
  if(python){const run=spawnSync(launch.command,launch.args,{encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/direct-runtime-ready/);}
});

test('incomplete direct runtime fails explicitly and existing configured uv launches stay unchanged',()=>{
  assert.throws(()=>memoryLaunch({directory:tmpdir(),env:{NEKO_WORKBENCH_MEMORY_PYTHON_DIRECT:'relative.exe'}}),/不完整/);
  const launch=memoryLaunch({directory:tmpdir(),python:'configured-python',uv:'fixture-uv',env:{}});
  assert.equal(launch.command,'fixture-uv');assert.deepEqual(launch.args.slice(0,7),['run','--no-project','--offline','--no-python-downloads','--python','configured-python','python']);
});
