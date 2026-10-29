'use strict';
const fs=require('node:fs'),path=require('node:path');
const base=__dirname,file=path.join(base,'b0-skin/packages/dsh-client-ui-white-label/lib/client.js');
const source=fs.readFileSync(path.join(base,'workspace-shell-source.js'),'utf8');
const css=fs.readFileSync(path.join(base,'workspace-shell-source.css'),'utf8');
const preview=fs.readFileSync(path.join(base,'chatroom-preview-source.js'),'utf8');
const previewCss=fs.readFileSync(path.join(base,'chatroom-preview-source.css'),'utf8');
const block='// @neko-workspace-shell:start\nconst WORKSPACE_SHELL_CSS = '+JSON.stringify(css)+' + '+JSON.stringify(previewCss)+';\n'+preview+'\n'+source+'\n// @neko-workspace-shell:end\n';
let code=fs.readFileSync(file,'utf8');
if(code.includes('// @neko-workspace-shell:start'))code=code.replace(/\/\/ @neko-workspace-shell:start[\s\S]*?\/\/ @neko-workspace-shell:end\n/,block);
else code=code.replace('// @neko-side-rail:start',block+'\n// @neko-side-rail:start');
// Account styles are embedded separately in the same client bundle.
const accountCss=fs.readFileSync(path.join(base,'account-habitat-source.css'),'utf8');
const accountPattern=/^const ACCOUNT_HABITAT_CSS = (?:"(?:[^"\\]|\\.)*");$/m;
if(!accountPattern.test(code)) throw new Error('Missing account habitat CSS constant');
code=code.replace(accountPattern,()=> 'const ACCOUNT_HABITAT_CSS = '+JSON.stringify(accountCss)+';');
fs.writeFileSync(file,code);
