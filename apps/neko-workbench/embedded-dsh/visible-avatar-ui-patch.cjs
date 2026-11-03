'use strict';

// The older white-label avatar/role components live in the bundle base rather
// than the workspace shell source. Keep this cosmetic patch reproducible when
// the shell is synced, without migrating any native or saved account data.
// Claude娘 is offered and shown again only in the office edition (the shell
// publishes body[data-neko-workbench-edition]); daily keeps 大肥鱼 in her
// place. The Claude role/platform entry stays retired in both editions.
function patchVisibleAvatarUi(source) {
  let code=source;
  function replace(before,after,label) {
    if(code.includes(after))return;
    if(code.split(before).length!==2)throw Error('Avatar UI patch target changed: '+label);
    code=code.replace(before,after);
  }
  // Earlier syncs wrote unconditional fallbacks. Upgrade them in place so a
  // re-sync never stacks a second fallback line on top of the old one.
  function migrate(before,after) {
    if(code.includes(after)||!code.includes(before))return;
    if(code.split(before).length!==2)throw Error('Avatar UI patch migration target changed');
    code=code.replace(before,after);
  }
  const avatarBlock=/const AVATARS = Object\.freeze\(\[[\s\S]*?\n    \]\)/;
  if(!avatarBlock.test(code))throw Error('Avatar UI patch target changed: portraits');
  code=code.replace(avatarBlock,block=>block.replace(/^\s*Object\.freeze\(\{ id: 'claude', name: 'Claude娘' \}\),\r?\n/m,''));
  replace('const AVATAR_IDS = Object.freeze(AVATARS.map((a) => a.id))',"const AVATAR_IDS = Object.freeze([...AVATARS.map((a) => a.id), 'claude'])",'legacy avatar validation');
  const selectable="const SELECTABLE_IDS = Object.freeze([...AVATAR_IDS, 'custom'])";
  replace(selectable,selectable+"\n    const NEKO_OFFICE_AVATARS = Object.freeze([...AVATARS, Object.freeze({ id: 'claude', name: 'Claude娘' })])\n    function nekoOfficeEdition() { return typeof document !== 'undefined' && document.body?.getAttribute('data-neko-workbench-edition') === 'office' }\n    function visibleAvatars() { return nekoOfficeEdition() ? NEKO_OFFICE_AVATARS : AVATARS }\n    function visibleAvatarId(id) { return id === 'claude' && !nekoOfficeEdition() ? 'bigfish' : id }",'edition-aware portraits');
  for(const name of ['builtinSrc','avatarName']){
    const head='function '+name+'(id) {',edition=head+"\n      if (id === 'claude' && !nekoOfficeEdition()) id = 'bigfish'";
    migrate(head+"\n      if (id === 'claude') id = 'bigfish'",edition);
    replace(head,edition,name+' fallback');
  }
  replace("const found = AVATARS.find((a) => a.id === id)","const found = visibleAvatars().find((a) => a.id === id)",'portrait names');
  // Keep a saved Claude娘 choice; each surface maps it for the current edition.
  migrate("let builtinId = avatar.builtinId === 'claude' ? 'bigfish' : SELECTABLE_IDS.includes(avatar.builtinId) ? avatar.builtinId : DEFAULT_AVATAR","let builtinId = SELECTABLE_IDS.includes(avatar.builtinId) ? avatar.builtinId : DEFAULT_AVATAR");
  replace('const current = state.avatar.builtinId','const current = visibleAvatarId(state.avatar.builtinId)','sidebar picker selection');
  replace('const tiles = AVATARS.map((a) => h(PickerTile, {','const tiles = visibleAvatars().map((a) => h(PickerTile, {','sidebar picker portraits');
  replace('const current = snap.state.avatar.builtinId','const current = visibleAvatarId(snap.state.avatar.builtinId)','hero selection');
  replace('...AVATARS.map((a, i) => {','...visibleAvatars().map((a, i) => {','hero portraits');
  replace('const tiles = AVATARS.map((a) =>\n','const tiles = visibleAvatars().map((a) =>\n','role picker portraits');
  replace('...snap.state.roles.map((role) =>',"...snap.state.roles.filter((role) => role.id !== 'claude').map((role) =>",'retired role entry');
  migrate("selected: (role.avatarId === 'claude' ? 'bigfish' : role.avatarId) === a.id,",'selected: visibleAvatarId(role.avatarId) === a.id,');
  replace('selected: role.avatarId === a.id,','selected: visibleAvatarId(role.avatarId) === a.id,','role avatar presentation');
  return code;
}

module.exports={patchVisibleAvatarUi};
