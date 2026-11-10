'use strict';
// N.E.K.O. is the owning Electron shell. Load the existing Desktop profile
// through DSH's exported profile-boot API, as the official desktop host does.
const path=require('node:path'),{createRequire,registerHooks}=require('node:module');
const {pathToFileURL,fileURLToPath}=require('node:url'),fs=require('node:fs');
function desktopOptions(runtime,patchFile,environment){
  const root=path.dirname(path.dirname(runtime.modulesDir));
  const installAnchor=path.join(root,'node_modules/@deepseek-ai/dsh/package.json');
  return {root,installAnchor,profileDir:path.join(runtime.dshHomeDir,'profiles',runtime.dshProfile),
    source:path.join(runtime.desktopResources,'runtime/primary-runtime'),
    options:{environment,profile:runtime.dshProfile,patchFiles:[patchFile],args:['--no-open','--host','127.0.0.1','--port','0'],
      packageManager:{command:runtime.desktopExecutable,args:['--expose-internals',path.join(runtime.desktopResources,'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs')],
        env:{ELECTRON_RUN_AS_NODE:'1',DSH_DESKTOP_NODE_EXECUTABLE:runtime.desktopExecutable,PATH:path.join(runtime.desktopResources,'runtime/bin')+path.delimiter+(process.env.PATH||'')}}}};
}
// Let the official boot package create its standard desktop profile for a
// genuinely new installation. Existing directories use the non-migrating
// reader: even a damaged or partially created profile must not be replaced.
function loadDesktopProfile(boot,runtime,cfg){
  if(!fs.existsSync(cfg.profileDir))boot.initProfile(cfg.profileDir,boot.PROFILE_TEMPLATES.web.bundles);
  return boot.loadProfileDirectory('dsh',cfg.profileDir,cfg.installAnchor);
}
// Match the official desktop host's ASAR-aware Office engine resolution.
function officeResolution(root){
  const archive=path.dirname(root);if(path.basename(archive)!=='app.asar')return;
  const source=pathToFileURL(path.join(root,'node_modules/@deepseek-ai/libreoffice-kit-')).href;
  const destination=pathToFileURL(path.join(archive+'.unpacked',path.relative(archive,root),'node_modules/@deepseek-ai/libreoffice-kit-')).href;
  registerHooks({resolve(specifier,context,next){const result=next(specifier,context);if(!result.url.startsWith('file:'))return result;
    if(!/^@deepseek-ai\/libreoffice-kit-(?:darwin|win32|linux)-/.test(specifier)&&!/\/node_modules\/@deepseek-ai\/libreoffice-kit-(?:darwin|win32|linux)-[^/]+\//.test(new URL(result.url).pathname))return result;
    const canonical=pathToFileURL(fs.realpathSync(fileURLToPath(result.url))).href;
    if(!canonical.startsWith(source)){if(canonical.startsWith(pathToFileURL(archive+'/').href))throw Error('Office engine resolved outside its package');return result;}
    return {...result,url:pathToFileURL(fs.realpathSync(fileURLToPath(destination+canonical.slice(source.length)))).href};}});
}
async function start(){
  const {resolveRuntimePaths}=require('./runtime-config.cjs'),runtime=resolveRuntimePaths();
  if(!runtime.sharedDsh||runtime.dshProfile!=='desktop')throw Error('Shared desktop host requires the existing desktop profile');
  process.env.DSH_CLIENT_VERSION ||= JSON.parse(fs.readFileSync(path.join(runtime.desktopResources,'app.asar/package.json'),'utf8')).version;
  const root=path.dirname(path.dirname(runtime.modulesDir)),load=createRequire(path.join(root,'package.json'));
  const moduleFor=name=>import(pathToFileURL(load.resolve(name)).href);
  officeResolution(root);
  const boot=await moduleFor('@deepseek-ai/dsh-app-boot');
  const {runProfile}=await moduleFor('@deepseek-ai/dsh/profile-boot');
  const cfg=desktopOptions(runtime,process.argv[2],boot.loadLayeredEnv('dsh'));
  const profile=loadDesktopProfile(boot,runtime,cfg);boot.reportSkippedBundles('dsh',profile);
  const {ctx}=await runProfile({...cfg.options,resolvedProfile:{profile,installAnchor:cfg.installAnchor}});
  const dependencies=await moduleFor('@deepseek-ai/dsh-tool-workspace-dependencies');
  await ctx.plugin(dependencies,{source:cfg.source,root:path.join(runtime.dshHomeDir,'dsh-runtimes/dsh-primary-runtime')});
  const office=await moduleFor('@deepseek-ai/dsh-skill-office');
  const manifest=load.resolve('@deepseek-ai/libreoffice-kit/package.json');
  const physical=manifest.includes('.asar/')?manifest.replace('.asar/','.asar.unpacked/'):manifest;
  await ctx.plugin(office,{assetRoot:path.join(path.dirname(cfg.source),'office-skills'),node:path.join(cfg.source,'dependencies/node/bin/node'),cli:path.join(path.dirname(physical),'lib/cli.js')});
}
if(require.main===module)start().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={desktopOptions,loadDesktopProfile};
