'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const prefs = require('../../apps/neko-workbench/main-agent-preferences.cjs');
const appearance = require('../../apps/neko-workbench/pet-appearance.js');
const {createMainAgentWindows} = require('../../apps/neko-workbench/main-agent-windows.cjs');

class Window extends EventEmitter {
  constructor(options = {}) {
    super();
    if (Number.isFinite(options.x)) this.bounds = {x:options.x, y:options.y, width:options.width, height:options.height};
  }
  bounds = {x: -422, y: 400, width: 340, height: 280};
  webContents = Object.assign(new EventEmitter(), {isLoading: () => false, send: () => {}});
  destroyed = false;
  visible = true;
  getBounds() { return this.bounds; }
  setBounds(bounds) { this.bounds = bounds; }
  setPosition(x, y) { this.setBounds({...this.bounds, x, y}); this.emit('move'); }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  hide() { this.visible = false; }
  show() { this.visible = true; }
  showInactive() { this.show(); }
  focus() {}
  close() { this.destroyed = true; this.emit('closed'); }
}

function setup(initial, {workbench = async () => {}, nativeMenu = () => {}, reduceMotion = () => true,
  cursor = {x:-5,y:795}, visits = () => {}} = {}) {
  const state = {preferences: {...appearance.normalizePreferences(), mainAgent: prefs.normalize(initial, true)},
    actors: [{id:'main'}]};
  const pet = new Window();
  const windows = {};
  let count = 0;
  const display = () => ({workArea: {x:-800,y:0,width:800,height:800}});
  const controller = createMainAgentWindows({
    BrowserWindow: Window,
    screen: {getDisplayMatching: display, getDisplayNearestPoint: display, getCursorScreenPoint: () => cursor},
    options: () => ({}), getPet: () => pet, getState: () => state, appearance,
    loadLocalFile: async (window, query) => { windows[query.view] = window; },
    save: () => { count++; }, publish: () => {}, update: () => { count++; },
    actions: {workbench, nativeMenu, visits, canRoam: () => true, onError: error => { throw error; }},
    isQuitting: () => false, reduceMotion,
  });
  return {controller, pet, windows, state, writes: () => count};
}

test('the icon menu respects saved shortcuts, clamps to the current monitor, and keeps native actions available', async () => {
  let visited = false, openedNative = false;
  const {controller, windows, pet} = setup({shortcuts:['visits'],compactMenu:true}, {
    visits: () => { visited = true; },
    nativeMenu: window => { assert.equal(window,pet); openedNative = true; },
  });
  controller.openMenu();
  const first = windows['main-agent-menu'];
  assert.deepEqual(first.getBounds(),{x:-300,y:607,width:300,height:180});
  assert.deepEqual((await controller.call(first,'read')).items,[{id:'visits',label:'串门'}]);
  await assert.rejects(controller.call(first,'menu-action',{id:'chat'}),/未知右键菜单操作/);
  await assert.rejects(controller.call(first,'edit',{key:'roam',value:'often'}),/未知右键菜单操作/);
  await controller.call(first,'menu-action',{id:'visits'});
  assert.equal(visited,true);
  assert.equal(first.isDestroyed(),true);
  controller.openMenu({keyboard:true});
  const second = windows['main-agent-menu'];
  await controller.call(second,'menu-action',{id:'more'});
  assert.equal(openedNative,true);
  controller.openMenu();
  const third = windows['main-agent-menu'];
  third.emit('blur');
  assert.equal(third.isDestroyed(),true);
});

test('guide roaming updates actual pet bounds and schedules the selected cadence after closing', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const {controller, windows, pet} = setup({guideRevision:2,guide:{step:2,status:'paused'}},{reduceMotion:()=>false});
  t.after(() => controller.dispose());
  controller.openGuide();
  const guide = windows['main-agent-guide'];
  await assert.rejects(controller.call(guide,'walk-preview'),/不方便走动/);
  await controller.call(guide,'edit',{key:'roam',value:'often'});
  const before = pet.getBounds().x;
  await controller.call(guide,'walk-preview');
  assert.equal(Math.abs(before-pet.getBounds().x),24);
  const preview = pet.getBounds().x;
  t.mock.timers.tick(30000);
  assert.equal(pet.getBounds().x,preview,'an open guide defers automatic roaming');
  guide.close();
  t.mock.timers.tick(29999);
  assert.equal(pet.getBounds().x,preview);
  t.mock.timers.tick(1);
  assert.equal(Math.abs(preview-pet.getBounds().x),24);
});

test('upgrades preserve existing click behavior and new profiles start at the first bubble', () => {
  const existing = prefs.normalize();
  assert.equal(existing.guide.status,'paused');
  assert.equal(existing.single,'chat');
  assert.equal(existing.double,'workbench');
  assert.deepEqual(prefs.normalize(null,true).guide,{status:'pending',step:0});
  const options = prefs.normalize({shortcuts:['chat','chat','wrong','dress','visits','memory','hide','size','voice'], guide:{step:50,status:'broken'}});
  assert.deepEqual(options.shortcuts,['chat','dress','visits','memory','hide','size']);
  assert.deepEqual(options.guide,{status:'paused',step:7});
  const oldVoice = prefs.normalize({guide:{status:'paused',step:5}, shortcuts:['voice','dress']});
  assert.deepEqual(oldVoice.guide,{status:'paused',step:5});
  assert.deepEqual(oldVoice.shortcuts,['dress']);
  assert.equal(prefs.normalize({guide:{status:'finished',step:8}}).guide.step,7);
});

test('guide pauses, resumes, and advances to completion only after workbench opens or the user continues', async () => {
  let shouldFail = true;
  const {controller, windows, state, pet, writes} = setup({guide:{status:'paused',step:7}}, {
    workbench: async () => { if (shouldFail) throw Error('offline'); },
  });
  controller.openGuide();
  let guide = windows['main-agent-guide'];
  assert.equal(guide.getBounds().y, 157);
  assert.ok(guide.getBounds().x < 0);
  await assert.rejects(controller.call(pet,'edit',{key:'double',value:'none'}),/请从主 Agent/);
  await assert.rejects(controller.call(guide,'edit',{key:'single',value:'none'}),/这一步/);
  await assert.rejects(controller.openWorkbench(),/offline/);
  assert.deepEqual(state.preferences.mainAgent.guide,{status:'pending',step:6});
  guide.close();
  assert.deepEqual(state.preferences.mainAgent.guide,{status:'paused',step:6});
  controller.openGuide();
  guide = windows['main-agent-guide'];
  shouldFail = false;
  await controller.openWorkbench();
  await controller.call(guide,'guide-next',{step:6});
  assert.deepEqual(state.preferences.mainAgent.guide,{status:'pending',step:7});
  await controller.call(guide,'guide-next',{step:7});
  assert.deepEqual(state.preferences.mainAgent.guide,{status:'finished',step:7});
  assert.equal(guide.isDestroyed(),true);
  assert.ok(writes() > 0);
});

test('settings list current selectable appearances and reuse the main actor override', async () => {
  const {controller, windows, pet, state} = setup();
  controller.openSettings('appearance');
  const window = windows['main-agent-settings'];
  const snapshot = await controller.call(window,'read');
  assert.deepEqual(snapshot.models.map(model => model.id), appearance.choices.map(model => model.id));
  await controller.call(window,'appearance',{id:appearance.CAT});
  assert.equal(state.actors[0].appearanceId,appearance.CAT);
  assert.equal((await controller.call(window,'read')).scale,.65);
  await controller.call(window,'size',{scale:.8});
  assert.equal(state.actors[0].appearanceScale,.8);
  await assert.rejects(controller.call(pet,'shortcut',{id:'hide'}),/请从主 Agent/);
  await controller.call(window,'edit',{key:'shortcuts',value:['hide','dress']});
  await controller.call(pet,'shortcut',{id:'hide'});
  assert.equal(controller.isHidden(),true);
  assert.equal(pet.isVisible(),false);
  controller.showPet();
  assert.equal(pet.isVisible(),true);
});
