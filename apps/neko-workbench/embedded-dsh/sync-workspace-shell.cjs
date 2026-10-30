'use strict';
const fs=require('node:fs'),path=require('node:path');
const base=__dirname,file=path.join(base,'b0-skin/packages/dsh-client-ui-white-label/lib/client.js');
const source=fs.readFileSync(path.join(base,'workspace-shell-source.js'),'utf8');
const css=fs.readFileSync(path.join(base,'workspace-shell-source.css'),'utf8');
// lobby-composer.js is UMD. Inside the bundle factory `module` exists, so shadow it (and globalThis) to keep the
// bundle's own exports intact; the page CSP has no unsafe-eval, so this is plain text wrapping.
const composer=fs.readFileSync(path.join(base,'../lobby-composer.js'),'utf8');
const composerBlock='const WORKBENCH_LOBBY_COMPOSER = (function (module, globalThis) {\n'+composer+'\nreturn globalThis.WorkbenchLobbyComposer;\n})(undefined, {});\n';
const block='// @neko-workspace-shell:start\nconst WORKSPACE_SHELL_CSS = '+JSON.stringify(css)+';\n'+composerBlock+source+'\n// @neko-workspace-shell:end\n';
let code=fs.readFileSync(file,'utf8');
if(code.includes('// @neko-workspace-shell:start'))code=code.replace(/\/\/ @neko-workspace-shell:start[\s\S]*?\/\/ @neko-workspace-shell:end\n/,()=>block);
else code=code.replace('// @neko-side-rail:start',()=>block+'\n// @neko-side-rail:start');
fs.writeFileSync(file,code);
