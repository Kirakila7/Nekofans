(() => {
  'use strict';

  const iconPaths = {
    message: 'M20 11.5a8 8 0 0 1-8 8H4l1.8-3A8 8 0 1 1 20 11.5Z',
    mic: 'M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0ZM5 11a7 7 0 0 0 14 0M12 18v4',
    shirt: 'm8 4-6 3 2 5 3-1v9h10v-9l3 1 2-5-6-3a4 4 0 0 1-8 0Z',
    window: 'M3 4h18v16H3zM3 9h18M9 9v11',
    book: 'M6 4h13v16H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm3 5h6m-6 4h6',
    door: 'M5 20V4h11v16m-6-12 6-4v16l-6-2zm2 5h1m4 7h3',
    volume: 'M4 10h4l4-4v12l-4-4H4zm11-1a4 4 0 0 1 0 6m2-8a7 7 0 0 1 0 10',
    resize: 'M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4M8 16l8-8',
    eye: 'M3 12s3-5 9-5 9 5 9 5-3 5-9 5-9-5-9-5zm9-2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM4 4l16 16',
    face: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM8 10h.1m7.9 0h.1M8 14q4 4 8 0',
    cursor: 'm5 3 14 10-7 1-3 7z',
    spark: 'm12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5Z',
    back: 'm13 6-6 6 6 6m-6-6h13',
    close: 'm6 6 12 12m0-12L6 18',
    check: 'm4 12 5 5L20 6',
    upload: 'M3 14v6h18v-6m-9 2V4m-5 5 5-5 5 5',
    list: 'M8 6h12M8 12h12M8 18h12M4 6h.1M4 12h.1M4 18h.1',
    friends: 'M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2m18 0v-2a4 4 0 0 0-3-4M13 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0zm3-3a3.5 3.5 0 0 1 0 7',
    create: 'm14 4 6 6-3 3-2-2-8 8-3-3 8-8-2-2 3-3z',
    game: 'M7 7h10q3 0 4 8a2 2 0 0 1-3 2l-3-2H9l-3 2a2 2 0 0 1-3-2q1-8 4-8zm1 2v4m-2-2h4m5 0h.1m2 1h.1',
  };
  const shortcuts = {
    chat:['聊天','message'], voice:['语音设置','mic'], dress:['装扮','shirt'],
    workbench:['工作台','window'], memory:['记忆','book'], visits:['串门','door'],
    sound:['音效','volume'], size:['大小','resize'], hide:['隐藏','eye'],
  };
  const tabs = {
    appearance:['形象与装扮','shirt','今天想让哪位小伙伴陪你？'],
    persona:['称呼与性格','face','这点小习惯，我记着就好。'],
    touch:['桌宠交互','cursor','你习惯怎么点，我就怎么配合。'],
    menu:['快捷与右键','list','常用的放身边，其他的右键再找。'],
    connect:['聊天与语音','message','哪里没接上，我们就在这里看看。'],
    guide:['新手引导','spark','刚见面那会儿的事，还能再聊一遍。'],
  };
  const personality = {curious:'温柔好奇', playful:'活泼黏人', quiet:'安静靠谱'};
  const roaming = {still:'安静待着', occasional:'偶尔走动', often:'常常走动'};
  const replies = {quiet:'安静陪着', poke:'被戳时回应', all:'互动都回应', custom:'自己挑'};
  const gestures = {poke:'戳一下', pet:'在头上停留', drop:'拖动放下'};
  const quotes = {
    curious:'你忙你的，我在旁边陪着。遇到好玩的，分我看看。',
    playful:'那我就多来找你玩啦。嫌我闹的时候，告诉我就好。',
    quiet:'嗯，我就在这儿。你叫我，我就过来。',
  };
  function gestureReply(settings, id) {
    const responds = settings.response === 'all' || settings.response === 'poke' && id === 'poke'
      || settings.response === 'custom' && settings.gestures.includes(id);
    if (!responds) return '';
    const lines = {
      curious: {poke:'嗯？你戳我啦。我在听。', pet:'摸到了，嘿。', drop:'好，我就在这儿。'},
      playful: {poke:'哎呀，被你戳到啦。', pet:'再待一小会儿嘛。', drop:'到啦。这个位置不错！'},
      quiet: {poke:'嗯，我在。', pet:'我陪你待会儿。', drop:'我在这儿。'},
    };
    const name = settings.name ? settings.name + '，' : '';
    return name + (lines[settings.personality] || lines.curious)[id];
  }
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
  })[c]);
  const icon = name => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${iconPaths[name]}"></path></svg>`;
  const iconButton = (name, label, attrs) => `<button type="button" class="agent-icon" aria-label="${esc(label)}" title="${esc(label)}" ${attrs}>${icon(name)}</button>`;
  const button = (name, label, attrs) => `<button type="button" class="agent-button" ${attrs}>${icon(name)}${esc(label)}</button>`;
  const row = (label, control, hint = '') => `<div class="agent-row"><div>${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</div>${control}</div>`;
  const select = (key, label, options, current) => `<select data-pref="${key}" aria-label="${esc(label)}">${Object.entries(options).map(([id, text]) =>
    `<option value="${id}" ${current === id ? 'selected' : ''}>${text}</option>`).join('')}</select>`;
  const checkbox = (key, label, current) => `<label class="agent-check"><input type="checkbox" data-pref="${key}" ${current ? 'checked' : ''}>${esc(label)}</label>`;

  function quickActions(parent, onAction) {
    const element = document.createElement('div');
    element.className = 'agent-quick';
    element.setAttribute('aria-label', '桌宠快捷按钮');
    element.hidden = true;
    parent.append(element);
    element.addEventListener('click', event => {
      const id = event.target.closest('[data-quick]')?.dataset.quick;
      if (id) onAction(id);
    });
    let key = '';
    return {
      element,
      show(visible) { element.hidden = !visible || !element.childElementCount; },
      update(ids, muted) {
        const next = ids.join(',') + muted;
        if (next === key) return;
        key = next;
        element.innerHTML = ids.filter(id => Object.hasOwn(shortcuts, id)).map(id => {
          const [label, glyph] = shortcuts[id];
          return iconButton(glyph, id === 'sound' ? (muted ? '开启音效' : '静音') : label, `data-quick="${id}"`);
        }).join('');
        if (!element.childElementCount) element.hidden = true;
      },
    };
  }

  function mount(host, guide, initialTab, api) {
    document.body.classList.add(guide ? 'agent-guide-body' : 'agent-settings-body');
    let tab = Object.hasOwn(tabs, initialTab) ? initialTab : 'persona';
    let previewMode = 'desktop', data, draftName, busy = false, notice = '';
    let undo, savedFocus;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const statusText = () => data.ready ? '聊天已连接' : '聊天还没接上，可以稍后再来。';
    const choiceGroup = (key, options, current) => `<div class="agent-choices">${Object.entries(options).map(([id, label]) =>
      `<button type="button" class="agent-button" data-pref-button="${key}" data-value="${id}" aria-pressed="${id === current}">${label}</button>`).join('')}</div>`;
    const checks = (key, options, selected, icons = false) => `<div class="agent-choices agent-checks">${Object.entries(options).map(([id, item]) => {
      const [label, glyph] = Array.isArray(item) ? item : [item];
      return `<label ${icons ? `title="${label}"` : ''}><input type="checkbox" data-list="${key}" value="${id}" aria-label="${label}" ${selected.includes(id) ? 'checked' : ''}
        ${key === 'shortcuts' && !selected.includes(id) && selected.length >= 6 ? 'disabled' : ''}>${icons ? icon(glyph) : label}</label>`;
    }).join('')}</div>`;
    const nameField = () => `<div class="agent-name"><input data-name aria-label="希望被称呼的名字" maxlength="20" placeholder="悄悄告诉我一个称呼…" value="${esc(draftName ?? data.prefs.name)}">
      ${guide ? '' : iconButton('check','保存称呼','data-action="name"')}</div>`;

    function modelMedia(model, detailed = false) {
      if (!model?.source) return '';
      if (model.id === 'dsh-original') return `<video src="assets/idle.webm" muted loop playsinline ${detailed && !reduced.matches ? 'autoplay' : 'preload="metadata"'} aria-hidden="true"></video>`;
      return `<img src="${esc(model.source)}" alt="" draggable="false">`;
    }

    function preview() {
      const prefs = data.prefs;
      const current = data.activeModel === 'custom' ? data.custom : data.models.find(model => model.id === data.activeModel);
      const switcher = tab === 'menu' ? `<div class="agent-preview-switch">${button('cursor','桌宠效果',`data-preview="desktop" aria-pressed="${previewMode === 'desktop'}"`)}
        ${button('list','右键菜单',`data-preview="menu" aria-pressed="${previewMode === 'menu'}"`)}</div>` : '<small>桌面效果</small>';
      const compact = [...prefs.shortcuts.map(id => shortcuts[id][0]), '主 Agent 设置', '显示桌宠', '退出'];
      const full = ['开始养鱼','形象','养鱼','打开工作台','串门','说话显示时长','设置','鱼的记忆','重新连接工作台','主 Agent 设置','显示桌宠','退出'];
      const pet = `<div class="agent-speech" aria-live="polite">${esc(tab === 'appearance' ? '挑一身你喜欢的吧。小习惯也都记着。' : quotes[prefs.personality])}</div>
        ${tab === 'menu' ? `<div class="agent-preview-quick">${prefs.shortcuts.map(id => `<span aria-label="${shortcuts[id][0]}" title="${shortcuts[id][0]}">${icon(shortcuts[id][1])}</span>`).join('')}</div>` : ''}
        <div class="agent-model-stage" style="--model-scale:${data.scale};--model-facing:${prefs.mirror ? -1 : 1}">${modelMedia(current, true)}</div>
        <small>${esc(current?.label)}</small>
        ${tab === 'touch' ? `<div class="agent-preview-quick">${iconButton('cursor','试试戳一下','data-test-gesture="poke"')}${iconButton('face','试试在头上停留','data-test-gesture="pet"')}${iconButton('resize','试试拖动放下','data-test-gesture="drop"')}</div>` : ''}`;
      return `<aside class="agent-preview" aria-label="桌宠预览">${switcher}<div class="agent-preview-body">${tab === 'menu' && previewMode === 'menu'
        ? `<ul class="agent-menu-sample">${(prefs.compactMenu ? compact : full).map(label => `<li>${esc(label)}</li>`).join('')}</ul>` : pet}</div></aside>`;
    }

    function page() {
      const prefs = data.prefs;
      switch (tab) {
        case 'appearance': {
          const models = data.custom ? [...data.models, {...data.custom, id:'custom'}] : data.models;
          const scale = data.followsDefaultSize ? 'default' : String(data.scale);
          return `<h3>已有形象</h3><div class="agent-models">${models.map(model => `<button type="button" class="agent-model" aria-pressed="${model.id === data.activeModel}"
            data-model="${esc(model.id)}"><span>${modelMedia(model)}</span>${esc(model.label)}</button>`).join('')}</div>
            ${checkbox('follow', '跟随主角色默认形象', !data.appearanceId)}
            ${row('桌宠大小', `<select data-size aria-label="桌宠大小">${[['default','默认大小'],['0.4','40%'],['0.55','55%'],['0.65','65%'],['0.8','80%'],['1','100%']].map(([id, label]) =>
              `<option value="${id}" ${id === scale ? 'selected' : ''}>${label}</option>`).join('')}</select>`)}
            ${row('显示方向',checkbox('mirror','左右翻转',prefs.mirror))}
            ${row('自己的动图',iconButton('upload','导入自定义动图','data-action="import"'),'GIF / 动态 WebP · 最大 4 MB')}`;
        }
        case 'persona':
          return `<h3>我怎么叫你</h3>${nameField()}<h3>陪你的方式</h3>${choiceGroup('personality',personality,prefs.personality)}
            ${row('平时走动',select('roam','平时走动',roaming,prefs.roam))}`;
        case 'touch':
          return row('左键单击',select('single','左键单击',{chat:'打开聊天',poke:'戳一下',none:'不触发操作'},prefs.single))
            + row('左键双击',select('double','左键双击',{workbench:'打开工作台',chat:'打开聊天',none:'不触发操作'},prefs.double))
            + row('按住拖动','<small>移动桌宠，松手保存位置。</small>')
            + row('互动时开口',select('response','互动时开口',replies,prefs.response))
            + (prefs.response === 'custom' ? checks('gestures',gestures,prefs.gestures) : '');
        case 'menu':
          return `<h3>悬停按钮 <small>${prefs.shortcuts.length} / 6</small></h3>${checks('shortcuts',shortcuts,prefs.shortcuts)}
            ${row('右键菜单',checkbox('compactMenu','只显示常用功能',prefs.compactMenu))}
            <p>主 Agent 设置、显示桌宠和退出始终保留。</p>`;
        case 'connect':
          return row('聊天模型',button('message','打开聊天设置','data-action="chat-settings"'),statusText())
            + row('语音与本地 N.E.K.O.',button('mic','打开连接设置','data-action="voice-settings"'),'语音能力取决于当前连接。');
        case 'guide':
          return `<p>从桌面气泡学会聊天、装扮和打开工作台。</p>
            <div class="agent-choices">${button('spark',data.prefs.guide.status === 'finished' ? '重看新手引导' : '继续新手引导','data-action="guide-open"')}
            ${data.prefs.guide.status === 'finished' ? '' : button('back','从头再来','data-action="guide-restart"')}</div>`;
        default:
          return '';
      }
    }

    function guideContent() {
      const prefs = data.prefs;
      switch (prefs.guide.step) {
        case 0: return `<h1>唔，终于见面啦。</h1><p>我是大肥鱼，以后就赖在这儿陪你了。我该怎么叫你呀？</p>${nameField()}`;
        case 1: return `<h1>${esc(prefs.name || '伙伴')}，我平时这样陪你，好不好？</h1>${choiceGroup('personality',personality,prefs.personality)}<p>${quotes[prefs.personality]}</p>`;
        case 2: return `<h1>窝安好了。我能偶尔去溜达一圈吗？</h1>${choiceGroup('roam',roaming,prefs.roam)}`;
        case 3: return `<h1>你戳我、摸我脑袋的时候，要我搭句话吗？</h1>${choiceGroup('response',replies,prefs.response)}${prefs.response === 'custom' ? checks('gestures',gestures,prefs.gestures) : ''}`;
        case 4: return `<h1>想跟我聊聊天？</h1><p>用工作台账号，或者到聊天设置里选个模型。晚点弄也行。</p>${button('message','聊天设置','data-action="chat-settings"')}<small>${statusText()}</small>`;
        case 5: return `<h1>想直接喊我一声吗？</h1><p>有语音连接的话，就去设置看看。喜欢打字，我们也可以慢慢聊。</p>${button('mic','打开连接设置','data-action="voice-settings"')}`;
        case 6: return `<h1>把常用的小按钮挑出来吧。</h1><p>以后鼠标挪过来，它们就待在我旁边。最多放六个哦。</p>${checks('shortcuts',shortcuts,prefs.shortcuts,true)}`;
        case 7: return `<h1>对了，还有个热闹地方。</h1><p>双击我，就能打开 Nekofans 工作台。找朋友聊聊天，捣鼓自己的小游戏，也能玩玩大家做的。碰到好玩的，记得带我一起呀。</p>
          <div class="agent-guide-features"><span>${icon('friends')}朋友聊天</span><span>${icon('create')}制作游戏</span><span>${icon('game')}游玩游戏</span></div>`;
        default: return `<h1>好啦，${esc(prefs.name || '伙伴')}。</h1><p>右键能调我的小习惯。想找朋友或玩游戏，就去工作台。你忙你的，我在这儿。</p>`;
      }
    }

    function render() {
      if (!data) return;
      const focus = document.activeElement;
      savedFocus = focus && host.contains(focus) ? Object.entries(focus.dataset).find(([key]) => key !== 'value') : null;
      const focusValue = focus?.dataset.value || (focus?.dataset.list && focus.value);
      if (guide) {
        const step = data.prefs.guide.step;
        host.innerHTML = `<main class="agent-guide" aria-label="大肥鱼的新手引导">
          <header>${iconButton('back','上一步',`data-action="guide-back" ${step ? '' : 'disabled'}`)}
          <span class="agent-dots" aria-label="第 ${step + 1} 步，共 9 步">${Array.from({length:9},(_,i) => `<i class="${i === step ? 'active' : ''}"></i>`).join('')}</span>
          ${iconButton('close','稍后继续','data-action="close"')}</header>
          <div class="agent-guide-content">${guideContent()}</div>
          <footer><span role="status">${esc(notice)}</span>
          ${step === 7 ? iconButton('window','打开 Nekofans 工作台','data-action="workbench"') : ''}
          ${iconButton('check',step === 8 ? '开始陪伴' : '下一步','data-action="guide-next"')}</footer></main>`;
      } else {
        const [label,, hint] = tabs[tab];
        host.innerHTML = `<main class="agent-settings">
          <header class="agent-header"><div><h1>主 Agent 设置</h1><p>有些小习惯，咱们慢慢调。</p></div>${iconButton('close','关闭设置','data-action="close"')}</header>
          <div class="agent-layout"><nav aria-label="主 Agent 设置分类">${Object.entries(tabs).map(([id,[title,glyph]]) => button(glyph,title,`data-tab="${id}" aria-current="${tab === id ? 'page' : 'false'}"`)).join('')}</nav>
          <section class="agent-page" aria-label="${label}"><h2>${label}</h2><p>${hint}</p><div class="agent-columns"><div>${page()}</div>${preview()}</div></section></div>
          <footer class="agent-footer"><span role="status">${esc(notice || '更改即时保存')}</span>${undo ? button('back','撤销上次修改','data-action="undo"') : ''}</footer>
          </main>`;
      }
      if (savedFocus) {
        const [key, value] = savedFocus;
        const next = [...host.querySelectorAll('button,input,select')].find(el => Object.hasOwn(el.dataset,key)
          && el.dataset[key] === value && (!focusValue || (el.dataset.value || el.value) === focusValue));
        next?.focus({preventScroll:true});
      }
    }

    async function run(method, payload, nextUndo) {
      if (busy) return false;
      busy = true;
      try {
        const next = await api.call(method,payload);
        if (next?.prefs) data = next;
        if (nextUndo) undo = nextUndo;
        notice = nextUndo ? '记住啦。' : '';
        return true;
      } catch (error) {
        notice = error.message.replace(/^Error invoking remote method '[^']+': Error: /,'');
        return false;
      } finally {
        busy = false;
        render();
      }
    }
    function edit(key,value) {
      return run('edit',{key,value},guide ? null : ['edit',{key,value:data.prefs[key]}]);
    }
    host.addEventListener('input',event => { if ('name' in event.target.dataset) draftName = event.target.value; });
    host.addEventListener('click',async event => {
      const target = event.target.closest('button');
      if (!target || busy) return;
      const {tab: nextTab, preview: nextPreview, prefButton, value, model, action} = target.dataset;
      if (nextTab) { tab = nextTab; render(); return; }
      if (nextPreview) { previewMode = nextPreview; render(); return; }
      if (target.dataset.testGesture) {
        const speech = host.querySelector('.agent-speech');
        speech.textContent = gestureReply(data.prefs,target.dataset.testGesture) || '这次我动一下，安静陪你。';
        return;
      }
      if (prefButton) { await edit(prefButton,value); return; }
      if (model) { await run('appearance',{id:model},['appearance',{id:data.appearanceId}]); return; }
      if (action === 'name') { if (await edit('name',draftName ?? data.prefs.name)) { draftName = undefined; render(); } return; }
      if (action === 'undo') {
        const [method,payload] = undo;
        if (await run(method,payload)) { undo = undefined; notice = '已撤销。'; render(); }
        return;
      }
      if (action === 'guide-next') {
        if (data.prefs.guide.step === 0 && draftName !== undefined) {
          if (!await edit('name',draftName)) return;
          draftName = undefined;
        }
        await run(action,{step:data.prefs.guide.step});
      } else if (action === 'guide-restart') await run('guide-open',{restart:true});
      else if (action) await run(action);
    });
    host.addEventListener('change',async event => {
      const input = event.target;
      if (input.dataset.pref === 'follow') {
        await run('appearance',{id:input.checked ? null : data.activeModel},['appearance',{id:data.appearanceId}]);
      } else if ('size' in input.dataset) {
        await run('size',{scale:input.value === 'default' ? null : Number(input.value)},['size',{scale:data.followsDefaultSize ? null : data.scale}]);
      } else if (input.dataset.list) {
        const key = input.dataset.list, current = data.prefs[key];
        await edit(key,input.checked ? [...current,input.value] : current.filter(id => id !== input.value));
      } else if (input.dataset.pref) {
        await edit(input.dataset.pref,input.type === 'checkbox' ? input.checked : input.value);
      }
    });
    document.addEventListener('keydown',event => {
      if (event.isComposing) return;
      if (event.key === 'Escape') void run('close');
      if (event.key === 'Enter' && 'name' in event.target.dataset) {
        event.preventDefault();
        host.querySelector(`[data-action="${guide ? 'guide-next' : 'name'}"]`).click();
      }
    });
    // The main process supplies the initial snapshot after the file URL commits.
    const stopState = api.onState(next => { if (!busy || !data) { data = next; render(); } });
    const stopTab = api.onTab(next => { if (Object.hasOwn(tabs,next)) { tab = next; render(); } });
    window.addEventListener('focus',() => { if (data && !busy) void run('read'); });
    window.addEventListener('unload',() => { stopState(); stopTab(); },{once:true});
  }

  window.MainAgentUI = {mount, quickActions, gestureReply};
})();
