'use strict';
const fs=require('node:fs'),path=require('node:path');
const {patchVisibleAvatarUi}=require('./visible-avatar-ui-patch.cjs');
const base=__dirname,file=path.join(base,'b0-skin/packages/dsh-client-ui-white-label/lib/client.js');
const source=fs.readFileSync(path.join(base,'workspace-shell-source.js'),'utf8');
const css=fs.readFileSync(path.join(base,'workspace-shell-source.css'),'utf8');
const avatarTheme=fs.readFileSync(path.join(base,'avatar-theme-source.js'),'utf8');
// Reuse the original dsh-pet reply bubble, scoped to our companion so it
// cannot affect unrelated DSH UI. The shell CSS positions it at the pet.
const bubbleCss=fs.readFileSync(path.join(base,'../original/bubble.css'),'utf8').replace(/\.pet-bubble/g,'.neko-companion-dock .pet-bubble');
// lobby-composer.js is UMD. Inside the bundle factory `module` exists, so shadow it (and globalThis) to keep the
// bundle's own exports intact; the page CSP has no unsafe-eval, so this is plain text wrapping.
const composer=fs.readFileSync(path.join(base,'../lobby-composer.js'),'utf8');
const composerBlock='const WORKBENCH_LOBBY_COMPOSER = (function (module, globalThis) {\n'+composer+'\nreturn globalThis.WorkbenchLobbyComposer;\n})(undefined, {});\n';
const preview=fs.readFileSync(path.join(base,'chatroom-preview-source.js'),'utf8');
const previewCss=fs.readFileSync(path.join(base,'chatroom-preview-source.css'),'utf8');
const nativeComposer=fs.readFileSync(path.join(base,'native-composer-source.js'),'utf8');
const ourHome=fs.readFileSync(path.join(base,'our-home-ui-source.js'),'utf8');
const home=fs.readFileSync(path.join(base,'yui-home-ui-source.js'),'utf8');
const homeTextures=fs.readFileSync(path.join(base,'yui-home-textures-source.js'),'utf8');
const homeCss=fs.readFileSync(path.join(base,'yui-home-ui-source.css'),'utf8');
const block='// @neko-workspace-shell:start\nconst WORKSPACE_SHELL_CSS = '+JSON.stringify(css)+' + '+JSON.stringify(bubbleCss)+' + '+JSON.stringify(previewCss)+' + '+JSON.stringify(homeCss)+';\n'+composerBlock+homeTextures+'\n'+home+'\n'+ourHome+'\n'+preview+'\n'+nativeComposer+'\n'+source+'\n// @neko-workspace-shell:end\n';
let code=fs.readFileSync(file,'utf8');
const avatarThemePattern=/\/\/ @neko-avatar-theme:start[\s\S]*?\/\/ @neko-avatar-theme:end/;
if(!avatarThemePattern.test(code))throw Error('Missing avatar theme source markers');
code=code.replace(avatarThemePattern,()=>avatarTheme.trimEnd());
if(code.includes('// @neko-workspace-shell:start'))code=code.replace(/\/\/ @neko-workspace-shell:start[\s\S]*?\/\/ @neko-workspace-shell:end\n/,()=>block);
else code=code.replace('// @neko-side-rail:start',()=>block+'\n// @neko-side-rail:start');
// Account styles are embedded separately in the same client bundle.
const accountCss=fs.readFileSync(path.join(base,'account-habitat-source.css'),'utf8');
const accountPattern=/^const ACCOUNT_HABITAT_CSS = (?:"(?:[^"\\]|\\.)*");$/m;
if(!accountPattern.test(code)) throw new Error('Missing account habitat CSS constant');
code=code.replace(accountPattern,()=> 'const ACCOUNT_HABITAT_CSS = '+JSON.stringify(accountCss)+';');
code=code.replace(/mountHome: stage => mountYuiHome\(stage, \{ avatar: builtinSrc(?:, posterSrc: ACCOUNT_PET_ART.still)? \}\)/g,'mountHome: stage => mountYuiHome(stage, { avatar: builtinSrc, posterSrc: ACCOUNT_PET_ART.still })');
code=code.replace(/nativeComposerBindings: \{ getSelection: \(\) => ctx\.uiWorkspace\?\.selection\?\.getSnapshot\?\.\(\), getMainSessionId: \(\) => ctx\.uiWorkspace\?\.mainReference\?\.sessionId, getBinding: id => ctx\.uiWorkspace\?\.sessions\?\.binding\?\.\(id\), getShell: \(_binding, id\) => ctx\.get\?\.\('conversation'\)\?\.input\?\.shell\?\.\(id\), subscribeSelection: callback => ctx\.uiWorkspace\?\.selection\?\.subscribe\?\.\(callback\) \}/g,'nativeComposerBindings: createNativeComposerDshBindings(ctx)');
fs.writeFileSync(file,patchVisibleAvatarUi(code));
