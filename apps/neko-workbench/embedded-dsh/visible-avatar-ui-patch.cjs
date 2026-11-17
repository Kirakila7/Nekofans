'use strict';

// Keep the five user-selected character appearances available in both
// presentations. This changes display choices only: it never modifies saved
// persona/account data or enables an unavailable Claude/Codex provider.
function patchVisibleAvatarUi(source) {
  let code=source.replace(/\r\n/g,'\n');
  const avatars=/const AVATARS = Object\.freeze\(\[[\s\S]*?\n    \]\)/;
  if(!avatars.test(code))throw Error('Avatar UI patch target changed: portraits');
  code=code.replace(avatars,block=>{
    if(block.includes("id: 'claude'"))return block;
    const marker="      Object.freeze({ id: 'gemini', name: 'Gemini小猫' }),";
    if(!block.includes(marker))throw Error('Avatar UI patch target changed: portrait order');
    return block.replace(marker,"      Object.freeze({ id: 'claude', name: 'Claude娘' }),\n"+marker);
  });
  code=code.replace("const AVATAR_IDS = Object.freeze([...AVATARS.map((a) => a.id), 'claude'])","const AVATAR_IDS = Object.freeze(AVATARS.map((a) => a.id))");
  code=code.replace("const NEKO_OFFICE_AVATARS = Object.freeze([...AVATARS, Object.freeze({ id: 'claude', name: 'Claude娘' })])",'const NEKO_OFFICE_AVATARS = AVATARS');
  code=code.replace("function visibleAvatars() { return nekoOfficeEdition() ? NEKO_OFFICE_AVATARS : AVATARS }",'function visibleAvatars() { return AVATARS }');
  code=code.replace("function visibleAvatarId(id) { return id === 'claude' && !nekoOfficeEdition() ? 'bigfish' : id }",'function visibleAvatarId(id) { return id }');
  code=code.replaceAll("      if (id === 'claude' && !nekoOfficeEdition()) id = 'bigfish'\n",'');
  code=code.replace("...snap.state.roles.filter((role) => role.id !== 'claude').map((role) =>",'...snap.state.roles.map((role) =>');
  return code;
}

module.exports={patchVisibleAvatarUi};
