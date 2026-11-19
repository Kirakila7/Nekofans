'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {_electron} = require(process.env.NEKO_PLAYWRIGHT || 'playwright');
const executablePath = process.env.NEKO_WORKBENCH_ELECTRON;
const source = path.resolve(__dirname, '../../apps/neko-workbench');

async function waitFor(predicate, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(80);
  }
  throw Error('Timed out waiting for ' + label);
}

async function launch(profile) {
  const {NEKO_ULTRA_QA_DSH_MODULES: modules = ''} = process.env;
  const env = {...process.env, NEKO_WORKBENCH_DATA_DIR:path.join(profile,'data'),
    NEKO_WORKBENCH_ELECTRON_USER_DATA:path.join(profile,'electron'),
    NEKO_WORKBENCH_WORKSPACE:path.join(profile,'workspaces'),
    NEKO_WORKBENCH_DSH_MODULES:modules,
    NEKO_WORKBENCH_DSH_CLI:modules ? path.join(modules,'dsh-desktop-host/lib/cli.js') : '',
    NEKO_WORKBENCH_DSH_HOME:'', NEKO_WORKBENCH_DSH_CREDENTIALS:'', NEKO_WORKBENCH_DSH_PROFILE:'web',
    PET_OPEN_WORKBENCH:'1', PET_WORKBENCH_ONLY:''};
  delete env.ELECTRON_RUN_AS_NODE;
  return _electron.launch({executablePath,env,args:[source,'--disable-background-networking',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']});
}

const view = (app,name) => waitFor(() => app.windows().find(page => page.url().includes('view='+name)),name);
const goNext = guide => guide.locator('[data-action=guide-next]').click();
const openingStep = (guide, step) => guide.locator(`[aria-label="第 ${step} 步，共 8 步"]`).waitFor();
const livePrefs = pet => pet.evaluate(async () => (await window.pet.call('state')).preferences.mainAgent);

async function clickPet(pet, action) {
  const {x,y,width,height} = await pet.locator('.character').boundingBox();
  const body = [Math.round(x + width / 2), Math.round(y + height * .55)];
  await pet.mouse.move(...body);
  if (action === 'double') await pet.mouse.dblclick(...body);
  else await pet.mouse.click(...body,{button:action === 'menu' ? 'right' : 'left'});
}

function petBounds(app) {
  return app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(window =>
    window.webContents.getURL().includes('view=pet')).getBounds());
}

async function run() {
  const temporary = await fs.realpath(os.tmpdir());
  const profile = await fs.mkdtemp(path.join(temporary,'neko-ultra-qa-'));
  let app;
  try {
    app = await launch(profile);
    const pet = await view(app,'pet');
    const guide = await view(app,'main-agent-guide');
    await guide.locator('[data-name]').fill('小满');
    await goNext(guide);
    await openingStep(guide,2);
    await guide.locator('[data-pref-button=personality][data-value=playful]').click();
    await waitFor(async () => (await livePrefs(pet)).personality === 'playful','live personality');
    await goNext(guide);
    await openingStep(guide,3);
    assert.equal(await guide.locator('[data-action=walk-preview]').isDisabled(),true);
    await guide.locator('[data-pref-button=roam][data-value=often]').click();
    const beforeWalk = await petBounds(app);
    await guide.locator('[data-action=walk-preview]').click();
    await waitFor(async () => Math.abs((await petBounds(app)).x - beforeWalk.x) > 0,'pet walks');
    assert.equal((await petBounds(app)).y,beforeWalk.y);
    await goNext(guide);
    await openingStep(guide,4);

    await guide.locator('[data-pref=single]').selectOption('poke');
    await guide.locator('[data-pref-button=response][data-value=quiet]').click();
    await waitFor(async () => (await livePrefs(pet)).response === 'quiet','quiet mode');
    await clickPet(pet,'single');
    await pet.locator('.character.agent-gesture').waitFor();
    assert.equal(await pet.locator('.pet-bubble').isVisible(),false);
    await guide.locator('[data-pref-button=response][data-value=custom]').click();
    await waitFor(async () => (await livePrefs(pet)).response === 'custom','custom reply mode');
    assert.deepEqual((await livePrefs(pet)).gestures,['poke']);
    await delay(1900);
    await clickPet(pet,'single');
    await pet.getByText('小满，哎呀，被你戳到啦。',{exact:true}).waitFor();
    await goNext(guide);
    await openingStep(guide,5);
    await guide.locator('[data-action=chat-settings]').click();
    const chat = await view(app,'chat-settings');
    await chat.locator('.use-deepseek-account').waitFor();
    assert.equal(await chat.locator('.open-local-neko').count(),0);
    assert.equal(await pet.evaluate(async () => (await window.pet.call('state')).mainChat.backend),'deepseek-account');
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(window =>
      window.webContents.getURL().includes('view=chat-settings')).close());
    await goNext(guide);
    await openingStep(guide,6);
    await guide.locator('[data-list=shortcuts][value=dress]').uncheck();
    await waitFor(async () => !(await livePrefs(pet)).shortcuts.includes('dress'),'remove hover shortcut');
    await guide.locator('[data-list=shortcuts][value=memory]').check();
    await waitFor(async () => (await livePrefs(pet)).shortcuts.includes('memory'),'add hover shortcut');
    assert.equal(await pet.locator('[data-quick=memory]').count(),1);
    assert.equal(await pet.locator('[data-quick=dress]').count(),0);
    await goNext(guide);
    await openingStep(guide,7);
    assert.match(await guide.locator('.agent-guide-features').textContent(),/朋友聊天.*制作游戏.*游玩游戏/s);
    await clickPet(pet,'double');
    await openingStep(guide,8);
    await guide.getByRole('button',{name:'开始陪伴'}).click();
    await waitFor(() => guide.isClosed(),'guide closed');
    console.log('GUIDE_PASS: name and personality in real bubble, walk preview, quiet and custom responses, shortcuts, chat and double-click');

    await clickPet(pet,'menu');
    let menu = await view(app,'main-agent-menu');
    await menu.locator('[data-menu-action=memory]').waitFor();
    assert.equal(await menu.locator('[data-menu-action=guide]').count(),0);
    assert.equal(await menu.locator('.agent-context').evaluate(panel => panel.scrollHeight > panel.clientHeight),false);
    const screenshot = process.env.NEKO_ULTRA_QA_SCREENSHOT;
    if (screenshot) await menu.screenshot({path:screenshot,omitBackground:true});
    await menu.locator('[data-menu-action=settings]').click();
    const settings = await view(app,'main-agent-settings');
    await settings.locator('[data-tab=menu]').click();
    await settings.locator('[data-pref=compactMenu]').check();
    await waitFor(async () => (await livePrefs(pet)).compactMenu,'compact menu preference');
    await settings.locator('[data-preview=menu]').click();
    assert.deepEqual(await settings.locator('.agent-context-preview .agent-context-tile span').allTextContents(),['聊天','记忆']);
    await settings.getByRole('button',{name:'关闭设置'}).click();
    await clickPet(pet,'menu');
    menu = await view(app,'main-agent-menu');
    await menu.locator('[data-menu-action=memory]').waitFor();
    assert.deepEqual(await menu.locator('.agent-context-tile span').allTextContents(),['聊天','记忆']);
    await Promise.all([
      menu.waitForEvent('close'),
      menu.keyboard.press('Escape').catch(error => { if (!/has been closed/.test(error.message)) throw error; }),
    ]);
    await pet.locator('.character').press('Shift+F10');
    menu = await view(app,'main-agent-menu');
    await menu.waitForFunction(() => document.activeElement?.dataset.menuAction === 'settings');
    await menu.locator('[data-menu-action=close]').click();
    await waitFor(() => menu.isClosed(),'keyboard menu closed');
    await clickPet(pet,'menu');
    menu = await view(app,'main-agent-menu');
    await menu.locator('[data-menu-action=chat]').click();
    await pet.locator('.chat').waitFor();
    await pet.locator('.chat input').press('Escape');
    if (process.env.NEKO_ULTRA_QA_DSH_MODULES) {
      const workbench = await waitFor(() => app.windows().find(page => /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(page.url())),'bundled workbench');
      await workbench.waitForFunction(() => !!window.nekoWorkbench?.getState);
      if (process.env.NEKO_WORKBENCH_CHAT_DEPLOYMENT === 'nekofans') {
        const deployment = await workbench.evaluate(async () => {
          const account = await window.nekoWorkbench.getAccounts();
          const channel = await window.nekoWorkbench.lobby({action:'state'});
          return [account.neko.lobby.deployment,channel.state.deployment];
        });
        assert.deepEqual(deployment,['nekofans','nekofans']);
        await workbench.getByRole('button',{name:'聊天室',exact:true}).click({timeout:8000});
        await workbench.getByRole('button',{name:'打开公共聊天室',exact:true}).click({timeout:8000});
        await workbench.getByRole('button',{name:'登录 Nekofans',exact:true}).waitFor({timeout:8000});
        console.log('NEKOFANS_CHAT_PASS: native workbench shows the independent sign-in route');
      }
    }

    await app.close();
    app = await launch(profile);
    const restored = await view(app,'pet');
    const prefs = await livePrefs(restored);
    assert.equal(prefs.name,'小满');
    assert.equal(prefs.personality,'playful');
    assert.equal(prefs.roam,'often');
    assert.equal(prefs.single,'poke');
    assert.equal(prefs.response,'custom');
    assert.deepEqual(prefs.gestures,['poke']);
    assert.deepEqual(prefs.shortcuts,['chat','memory']);
    assert.equal(prefs.compactMenu,true);
    assert.deepEqual(prefs.guide,{status:'finished',step:7});
    console.log('MENU_PASS: icon buttons dispatch actions, compact preview matches, Escape closes, preferences survive restart');
  } finally {
    await app?.close();
    if (path.dirname(await fs.realpath(profile)) === temporary) await fs.rm(profile,{recursive:true,force:true});
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
