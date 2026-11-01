'use strict';
const fs=require('node:fs'),path=require('node:path');
const base=__dirname,file=path.join(base,'b0-skin/packages/dsh-client-ui-white-label/lib/client.js');
const source=fs.readFileSync(path.join(base,'workspace-shell-source.js'),'utf8');
const css=fs.readFileSync(path.join(base,'workspace-shell-source.css'),'utf8');
// lobby-composer.js is UMD. Inside the bundle factory `module` exists, so shadow it (and globalThis) to keep the
// bundle's own exports intact; the page CSP has no unsafe-eval, so this is plain text wrapping.
const composer=fs.readFileSync(path.join(base,'../lobby-composer.js'),'utf8');
const composerBlock='const WORKBENCH_LOBBY_COMPOSER = (function (module, globalThis) {\n'+composer+'\nreturn globalThis.WorkbenchLobbyComposer;\n})(undefined, {});\n';
const preview=fs.readFileSync(path.join(base,'chatroom-preview-source.js'),'utf8');
const previewCss=fs.readFileSync(path.join(base,'chatroom-preview-source.css'),'utf8');
const nativeComposer=fs.readFileSync(path.join(base,'native-composer-source.js'),'utf8');
const home=fs.readFileSync(path.join(base,'yui-home-ui-source.js'),'utf8');
const homeTextures=fs.readFileSync(path.join(base,'yui-home-textures-source.js'),'utf8');
const homeCss=fs.readFileSync(path.join(base,'yui-home-ui-source.css'),'utf8');
const block='// @neko-workspace-shell:start\nconst WORKSPACE_SHELL_CSS = '+JSON.stringify(css)+' + '+JSON.stringify(previewCss)+' + '+JSON.stringify(homeCss)+';\n'+composerBlock+homeTextures+'\n'+home+'\n'+preview+'\n'+nativeComposer+'\n'+source+'\n// @neko-workspace-shell:end\n';
let code=fs.readFileSync(file,'utf8');
if(code.includes('// @neko-workspace-shell:start'))code=code.replace(/\/\/ @neko-workspace-shell:start[\s\S]*?\/\/ @neko-workspace-shell:end\n/,()=>block);
else code=code.replace('// @neko-side-rail:start',()=>block+'\n// @neko-side-rail:start');
// Account styles and the adapter source are embedded together in the same client bundle.
const accountCss=fs.readFileSync(path.join(base,'account-habitat-source.css'),'utf8');
const accountJs=fs.readFileSync(path.join(base,'account-habitat-source.js'),'utf8');
const accountBlock=/\/\/ @neko-account-habitat:start\n([\s\S]*?)\/\/ @neko-account-habitat:end\n/;
const accountMatch=accountBlock.exec(code);
if(!accountMatch) throw new Error('Missing account habitat block');
const artLine=(accountMatch[1].match(/^const ACCOUNT_PET_ART = .*$/m)||[])[0];
if(!artLine) throw new Error('Missing account habitat art constant');
code=code.replace(accountBlock,()=> '// @neko-account-habitat:start\n'+artLine+'\nconst ACCOUNT_HABITAT_CSS = '+JSON.stringify(accountCss)+';\n'+accountJs+'\n// @neko-account-habitat:end\n');
fs.writeFileSync(file,code);
