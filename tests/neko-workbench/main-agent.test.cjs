'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const prefs = require('../../apps/neko-workbench/main-agent-preferences.cjs');
const appearance = require('../../apps/neko-workbench/pet-appearance.js');
const {createMainAgentWindows} = require('../../apps/neko-workbench/main-agent-windows.cjs');

class Window extends EventEmitter {
  bounds = {x: -422, y: 400, width: 340, height: 280};
  webContents = Object.assign(new EventEmitter(), {isLoading: () => false, send: () => {}});
  destroyed = false;
  visible = true;
  getBounds() { return this.bounds; }
  setBounds(bounds) { this.bounds = bounds; }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  hide() { this.visible = false; }
  show() { this.visible = true; }
  showInactive() { this.show(); }
  close() { this.destroyed = true; this.emit('closed'); }
}

function setup(initial, {workbench = async () => {}} = {}) {
  const state = {preferences: {...appearance.normalizePreferences(), mainAgent: prefs.normalize(initial, true)},
    actors: [{id:'main'}]};
  const pet = new Window();
  const windows = {};
  let count = 0;
  const controller = createMainAgentWindows({
    BrowserWindow: Window,
    screen: {getDisplayMatching: () => ({workArea: {x:-800,y:0,width:800,height:800}})},
    options: () => ({}), getPet: () => pet, getState: () => state, appearance,
    loadLocalFile: async (window, query) => { windows[query.view] = window; },
    save: () => { count++; }, publish: () => {}, update: () => { count++; },
    actions: {workbench, onError: error => { throw error; }},
    isQuitting: () => false, reduceMotion: () => true,
  });
  return {controller, pet, windows, state, writes: () => count};
}

test('upgrades preserve existing click behavior and new profiles start at the first bubble', () => {
  const existing = prefs.normalize();
  assert.equal(existing.guide.status,'paused');
  assert.equal(existing.single,'chat');
  assert.equal(existing.double,'workbench');
  assert.deepEqual(prefs.normalize(null,true).guide,{status:'pending',step:0});
  const options = prefs.normalize({shortcuts:['chat','chat','wrong','dress','visits','memory','hide','size','voice'], guide:{step:50,status:'broken'}});
  assert.deepEqual(options.shortcuts,['chat','dress','visits','memory','hide','size']);
  assert.deepEqual(options.guide,{status:'paused',step:8});
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
  assert.deepEqual(state.preferences.mainAgent.guide,{status:'pending',step:7});
  guide.close();
  assert.deepEqual(state.preferences.mainAgent.guide,{status:'paused',step:7});
  controller.openGuide();
  guide = windows['main-agent-guide'];
  shouldFail = false;
  await controller.openWorkbench();
  await controller.call(guide,'guide-next',{step:7});
  assert.deepEqual(state.preferences.mainAgent.guide,{status:'pending',step:8});
  await controller.call(guide,'guide-next',{step:8});
  assert.deepEqual(state.preferences.mainAgent.guide,{status:'finished',step:8});
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
