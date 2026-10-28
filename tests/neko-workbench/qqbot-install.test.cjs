'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { install, resolveNpmLaunch, runNpmInstall } = require('../../apps/neko-workbench/vendor/dsh-qqbot-workbench/install.cjs');

function fixture(t, code = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'neko-QQ 中文 & 空格-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20}));
  const bin = path.join(root,'Node with spaces');
  const npm = path.join(bin,'node_modules/npm');
  const cli = path.join(npm,'bin/npm-cli.js');
  fs.mkdirSync(path.dirname(cli),{recursive:true});
  fs.writeFileSync(path.join(npm,'package.json'),JSON.stringify({name:'npm',version:'0.0.0-fixture'}));
  fs.writeFileSync(cli,code);
  return {root,bin,cli};
}

test('npm installer executes a CLI in a Chinese, spaced path without a shell',async t => {
  const f = fixture(t,`require('node:fs').writeFileSync('proof.json',JSON.stringify({
    args:process.argv.slice(2),cwd:process.cwd(),app:process.env.QQBOT_APPID,
    secret:process.env.QQBOT_SECRET,electron:process.env.ELECTRON_RUN_AS_NODE
  }));`);
  const env = {...process.env,npm_execpath:f.cli,QQBOT_APPID:'private-id',QQBOT_SECRET:'private-secret',
    ELECTRON_RUN_AS_NODE:'0',DSH_DESKTOP_NODE_EXECUTABLE:process.execPath};
  await runNpmInstall(f.root,{env});
  const proof = JSON.parse(fs.readFileSync(path.join(f.root,'proof.json'),'utf8'));
  assert.deepEqual(proof.args,['ci','--ignore-scripts','--no-audit','--no-fund','--legacy-peer-deps','--omit=dev']);
  assert.equal(fs.realpathSync(proof.cwd),fs.realpathSync(f.root));
  assert.equal(proof.app,'');
  assert.equal(proof.secret,'');
  assert.equal(proof.electron,undefined);
  assert.equal(env.QQBOT_SECRET,'private-secret','the caller environment is unchanged');
  assert.equal(env.ELECTRON_RUN_AS_NODE,'0');
});

test('npm CLI is discovered beside Node and through Windows-style PATH layouts',t => {
  const f = fixture(t);
  const absentRuntime = path.join(f.root,'elsewhere','node.exe');
  const local = resolveNpmLaunch({env:{},execPath:path.join(f.bin,'node.exe'),electronVersion:undefined});
  assert.equal(local.args[0],fs.realpathSync(f.cli));
  const fromPath = resolveNpmLaunch({env:{Path:`"${f.bin}"`},execPath:absentRuntime,electronVersion:undefined});
  assert.equal(fromPath.args[0],fs.realpathSync(f.cli));
  const invalidLocal = path.join(f.root,'node_modules/npm/bin/npm-cli.js');
  fs.mkdirSync(path.dirname(invalidLocal),{recursive:true});
  fs.writeFileSync(invalidLocal,'throw Error("must not execute");');
  assert.throws(() => resolveNpmLaunch({env:{PATH:'.'},execPath:absentRuntime,electronVersion:undefined}),
    error => error.code === 'QQ_NPM_MISSING' && !error.message.includes(f.root));
});

test('npm CLI is discovered in Unix Node prefixes and npm symlinks',t => {
  const f = fixture(t);
  const prefix = path.join(f.root,'prefix');
  const npm = path.join(prefix,'lib/node_modules/npm');
  fs.mkdirSync(path.dirname(npm),{recursive:true});
  fs.cpSync(path.dirname(path.dirname(f.cli)),npm,{recursive:true});
  const launch = resolveNpmLaunch({env:{},execPath:path.join(prefix,'bin/node'),electronVersion:undefined});
  assert.equal(launch.args[0],fs.realpathSync(path.join(npm,'bin/npm-cli.js')));
  if (process.platform !== 'win32') {
    const links = path.join(f.root,'links');
    fs.mkdirSync(links);
    fs.symlinkSync(f.cli,path.join(links,'npm'));
    assert.equal(resolveNpmLaunch({env:{PATH:links},execPath:path.join(f.root,'missing/node'),electronVersion:undefined}).args[0],fs.realpathSync(f.cli));
  }
});

test('Electron runs the npm CLI in Node mode; an explicit external Node does not',t => {
  const f = fixture(t);
  const env = {npm_execpath:f.cli,ELECTRON_RUN_AS_NODE:'0'};
  const electron = resolveNpmLaunch({env,execPath:process.execPath,electronVersion:'44.7.0'});
  assert.equal(electron.command,process.execPath);
  assert.equal(electron.env.ELECTRON_RUN_AS_NODE,'1');
  const explicitSame = resolveNpmLaunch({env:{...env,DSH_DESKTOP_NODE_EXECUTABLE:process.execPath},
    execPath:process.execPath,electronVersion:'44.7.0'});
  assert.equal(explicitSame.env.ELECTRON_RUN_AS_NODE,'1');
  const otherElectron = path.join(f.root,'other-electron.exe');
  fs.writeFileSync(otherElectron,'fixture');
  const external = resolveNpmLaunch({env:{...env,DSH_DESKTOP_NODE_EXECUTABLE:process.execPath},
    execPath:otherElectron,electronVersion:'44.7.0'});
  assert.equal(external.command,fs.realpathSync(process.execPath));
  assert.equal(external.env.ELECTRON_RUN_AS_NODE,undefined);
});

test('invalid explicit npm and Node paths fail clearly without exposing values',t => {
  const f = fixture(t);
  const marker = 'PRIVATE_REGISTRY_TOKEN';
  for (const value of [path.join(f.root,marker,'npm-cli.js'),'npm-cli.js',path.join(f.bin,'npm.cmd'),f.root]) {
    assert.throws(() => resolveNpmLaunch({env:{npm_execpath:value,PATH:f.bin}}),
      error => error.code === 'QQ_NPM_INVALID' && !error.message.includes(f.root) && !error.message.includes(marker));
  }
  const foreignCli = path.join(f.root,'foreign/bin/npm-cli.js');
  fs.mkdirSync(path.dirname(foreignCli),{recursive:true});
  fs.writeFileSync(foreignCli,'');
  fs.writeFileSync(path.join(f.root,'foreign/package.json'),'{"name":"not-npm"}');
  assert.throws(() => resolveNpmLaunch({env:{npm_execpath:foreignCli}}),{code:'QQ_NPM_INVALID'});
  for (const value of [path.join(f.root,marker,'node.exe'),'node',f.root]) {
    assert.throws(() => resolveNpmLaunch({env:{npm_execpath:f.cli,DSH_DESKTOP_NODE_EXECUTABLE:value}}),
      error => error.code === 'QQ_NODE_INVALID' && !error.message.includes(f.root) && !error.message.includes(marker));
  }
});

test('cancellation before install neither runs npm nor creates a profile',async t => {
  const f = fixture(t,'require("node:fs").writeFileSync("unexpected","started");');
  const root = path.join(f.root,'not-created');
  const controller = new AbortController();
  controller.abort(Error('private abort detail'));
  await assert.rejects(install(root,'unused',{signal:controller.signal,env:{npm_execpath:f.cli}}),
    error => error.name === 'AbortError' && error.code === 'ABORT_ERR' && !error.message.includes('private'));
  assert.equal(fs.existsSync(root),false);
});

test('cancellation stops an active installer without surfacing command output',async t => {
  const f = fixture(t,'require("node:fs").writeFileSync("started",String(process.pid)); setInterval(()=>{},1000);');
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = runNpmInstall(f.root,{signal:controller.signal,env:{...process.env,npm_execpath:f.cli}});
  const rejected = assert.rejects(pending,error => error.name === 'AbortError' && error.code === 'ABORT_ERR');
  const marker = path.join(f.root,'started');
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,10));
  assert(fs.existsSync(marker),'fixture installer started');
  const pid = Number(fs.readFileSync(marker,'utf8'));
  controller.abort();
  await rejected;
  let exited = false;
  while (Date.now() < deadline) {
    try { process.kill(pid,0); } catch (error) { if (error.code === 'ESRCH') { exited = true; break; } throw error; }
    await new Promise(resolve => setTimeout(resolve,10));
  }
  assert(exited,'installer process terminates after cancellation');
});

test('installation failure exposes a safe error without child stdout or stderr',async t => {
  const f = fixture(t,'console.log("PRIVATE_STDOUT");console.error("PRIVATE_STDERR");process.exit(2);');
  await assert.rejects(runNpmInstall(f.root,{env:{...process.env,npm_execpath:f.cli}}),error => {
    assert.equal(error.code,'QQ_NPM_INSTALL_FAILED');
    assert(!error.message.includes('PRIVATE'));
    assert(!error.message.includes(f.root));
    assert.equal(error.stdout,undefined);
    assert.equal(error.stderr,undefined);
    return true;
  });
});

test('installed npm CLI can be executed with Node without invoking a batch file',async () => {
  const launch = resolveNpmLaunch();
  const result = await execFile(launch.command,[launch.args[0],'--version'],
    {env:launch.env,windowsHide:true,timeout:10000});
  assert.match(result.stdout.trim(),/^\d+\.\d+\.\d+/);
});
