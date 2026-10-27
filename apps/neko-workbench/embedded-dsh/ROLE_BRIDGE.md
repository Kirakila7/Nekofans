# Sidebar roles native bridge (Codex owns host implementation)

Preserve all current v0.11 work: corrected avatar artwork, frame-free fan gallery, global avatar picker/upload, Workbench options, native chat/session/task behavior.

Latest user asks to group the left 插件 / 自动化任务 / 更多 into the active role options, and place three customizable role entries below 新会话: Yui, 大肥鱼, Claude小姐. For now ONLY 大肥鱼 is connected. Other two are visible/customizable placeholders, NOT fake active backends. Keep the UI compact.

New separate native bridge, alongside existing window.nekoWorkbench:

window.nekoRoles.getState() -> Promise<RoleState>
window.nekoRoles.selectRole(id) -> Promise<RoleState>; only bigfish succeeds
window.nekoRoles.updateRole(id,{name,avatarId}) -> Promise<RoleState>
window.nekoRoles.uploadAvatar(id) -> Promise<RoleState|null>; native picker, no human timeout, null cancels
window.nekoRoles.subscribe(callback) -> disposer; snapshots pushed when configuration changes

RoleState = {activeId:'bigfish',workspaceSessionId:string|null,roles:[
{id:'yui',name:'Yui',avatarId:'yui',customDataUrl:null,enabled:false},
{id:'bigfish',name:'大肥鱼',avatarId:'bigfish',customDataUrl:null,enabled:true},
{id:'claude',name:'Claude小姐',avatarId:'claude',customDataUrl:null,enabled:false}
]}

IDs/order/count/availability are fixed for this prototype. name is editable 1-24 codepoints. avatarId can be yui/devcat/bigfish/claude/gemini/custom; custom requires a saved uploaded image. Images are data:image/png;base64 only from the host. Config persists independently of main avatar/persona/memory in data/workbench-roles.json. Selecting/configuring a role must not change the global top-left decorative avatar or main-pet persona. Role icons can reuse your existing builtinSrc() and AvatarImg; selecting Bigfish should call selectRole('bigfish') then ctx.uiWorkspace.openSession(returned.workspaceSessionId) to open the existing REAL DSH root session, never create a new fake session. Only Bigfish gets working plugin/automation/more controls; disabled roles get clear 未接入 state and settings, not a connect simulation.

Read SIDEBAR_API.md first. It was researched from the actual installed DSH source in parallel. Public layout.selectPanel('plugins'/'schedules') and uiWorkspace.openSession(id) exist. No arbitrary sidebar insert slot and no wrappers. Recommended integration: mount own portal sibling below native new-conversation row; keep the ORIGINAL global nav (including More) in its React-owned location, fold it with scoped reversible CSS into an anchored role-tools overlay. Do not move React-managed nodes, clone buttons, drop future native menu items or replace the entire Sidebar. Keep native account/session/workspace features. Dispose observer, markers, listeners, own container and styles cleanly. Use stable source-verified selectors, graceful fallback if no sidebar.

Implement in your current white-label package, add role UI/state tests and update package injects if needed. Do not edit main.cjs or preload (Codex does host integration). Only amend current UI code; do not redesign the whole app or regenerate images. Avoid more mockup rounds: export an initial directly integrable client promptly, plus short handoff. No host folder permission or memory writes.
