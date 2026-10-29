'use strict';
(() => {
  const api = window.screenShare, $ = id => document.getElementById(id);
  const sources = $('sources'), status = $('status'), preview = $('preview'), form = $('settings-form');
  let snapshot, stream, timer, captureEpoch = 0, seq = 0, signature, loaded = false, renderedRecords = '', sending = false, pendingForce = false, consentRecipient;
  const canvas = document.createElement('canvas'), small = document.createElement('canvas'); small.width = 24; small.height = 14;
  const context = canvas.getContext('2d', { alpha: false }), smallContext = small.getContext('2d', { willReadFrequently: true });
  const call = (method, value) => api.call(method, value);
  function message(error) { status.textContent = error?.message || '操作未完成，请重试'; }
  function release() {
    captureEpoch++; clearInterval(timer); timer = null; signature = null; pendingForce = false;
    if (stream) { const old = stream; stream = null; for (const track of old.getTracks()) track.stop(); }
    preview.srcObject = null; preview.hidden = true;
  }
  function settingsMode() { $('custom-settings').hidden = form.elements.mode.value !== 'custom'; }
  function render(value) {
    snapshot = value; const sharing = value.phase === 'sharing';
    if (!sharing && stream) release();
    $('start').disabled = sharing || sending; $('start').textContent = value.phase === 'paused' ? '继续共享' : '开始共享';
    $('pause').disabled = !sharing; $('stop').disabled = value.phase === 'idle'; $('send').disabled = !sharing; sources.disabled = sharing;
    $('share-context').disabled = sharing;
    const model = value.vision?.effective?.model || '未配置';
    let recipient = '尚未配置视觉服务';
    try { recipient = value.vision.effective.protocol + ' · ' + new URL(value.vision.effective.baseUrl).href.replace(/\/+$/, '') + ' · ' + model; } catch {}
    if (consentRecipient !== undefined && consentRecipient !== recipient) $('share-context').checked = false;
    consentRecipient = recipient;
    $('recipient').textContent = recipient;
    $('model').textContent = model + (value.capability === 'responded' ? ' · 图片请求已收到文字回复' : ' · 图片请求未收到回复');
    status.textContent = value.error || (sharing ? '● 正在共享：' + value.source.name + ' · 已请求 ' + value.requests + '/' + value.limit + ' 次'
      : value.phase === 'paused' ? '已暂停，画面不会继续发送' : '尚未共享');
    if (!loaded && value.vision) {
      const config = value.vision.settings;
      for (const field of ['mode', 'protocol', 'baseUrl', 'model']) form.elements[field].value = config[field] || '';
      settingsMode(); loaded = true;
    }
    const key = JSON.stringify(value.records);
    if (key !== renderedRecords) {
      renderedRecords = key; const list = $('records'); list.replaceChildren();
      for (const record of value.records) {
        const card = document.createElement('article'), text = document.createElement('p'), meta = document.createElement('small');
        text.textContent = record.text;
        meta.textContent = new Date(record.capturedAt).toLocaleTimeString() + (record.question ? ' · 你的提问：' + record.question : ' · 画面反馈');
        card.append(text, meta); list.append(card);
      }
      if (!value.records.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = '开始共享后，反馈会出现在这里和主角色气泡中。'; list.append(empty); }
      list.scrollTop = list.scrollHeight;
    }
    $('streaming').hidden = !value.reply?.streaming; $('streaming').textContent = value.reply?.streaming ? value.reply.text : '';
  }
  async function refresh() {
    $('refresh').disabled = true;
    try {
      const rows = await call('sources'), previous = sources.value; sources.replaceChildren();
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '请选择一个窗口或屏幕'; sources.append(placeholder);
      for (const row of rows) { const option = document.createElement('option'); option.value = row.id; option.textContent = (row.id.startsWith('screen:') ? '屏幕 · ' : '窗口 · ') + row.name; sources.append(option); }
      if (rows.some(row => row.id === previous)) sources.value = previous;
    } catch (error) { message(error); }
    finally { $('refresh').disabled = false; }
  }
  async function sample(force = false) {
    if (!stream || snapshot?.phase !== 'sharing' || !preview.videoWidth) return;
    if (sending) { if (force) pendingForce = true; return; }
    smallContext.drawImage(preview, 0, 0, small.width, small.height);
    const pixels = smallContext.getImageData(0, 0, small.width, small.height).data;
    let distance = 0; if (signature) for (let i = 0; i < pixels.length; i += 4) distance += Math.abs(pixels[i] - signature[i]) + Math.abs(pixels[i+1] - signature[i+1]) + Math.abs(pixels[i+2] - signature[i+2]);
    if (!force && signature && distance / (small.width * small.height * 3) < 3) return;
    signature = new Uint8ClampedArray(pixels);
    const scale = Math.min(1, 1280 / preview.videoWidth, 720 / preview.videoHeight);
    canvas.width = Math.max(1, Math.round(preview.videoWidth * scale)); canvas.height = Math.max(1, Math.round(preview.videoHeight * scale));
    context.drawImage(preview, 0, 0, canvas.width, canvas.height);
    const epoch = captureEpoch; sending = true;
    try { await call('frame', { image: canvas.toDataURL('image/jpeg', .75), generation: snapshot.generation, seq: ++seq, capturedAt: Date.now(), width: canvas.width, height: canvas.height }); }
    catch (error) { if (epoch === captureEpoch) { release(); void call('capture-error').catch(() => {}); message(error); } }
    finally { sending = false; if (pendingForce) { pendingForce = false; void sample(true); } }
  }
  $('refresh').addEventListener('click', () => void refresh());
  $('start').addEventListener('click', async () => {
    if ($('start').disabled) return;
    release(); const epoch = captureEpoch; let begun = false; $('start').disabled = true;
    try {
      const effective = snapshot?.vision?.effective;
      if (!effective?.protocol || !effective?.baseUrl || !effective?.model) throw new Error('请先配置视觉服务并确认接收方');
      const target = { protocol: effective.protocol, baseUrl: new URL(effective.baseUrl).href.replace(/\/+$/, ''), model: effective.model };
      const contextConsent = $('share-context').checked ? { ...target } : null;
      const state = await call('start', { sourceId: sources.value, target, contextConsent });
      if (epoch !== captureEpoch) return; begun = true; render(state); seq = 0;
      const captured = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: { frameRate: 2, width: 1280, height: 720 } });
      if (epoch !== captureEpoch || snapshot.phase !== 'sharing') { for (const track of captured.getTracks()) track.stop(); return; }
      stream = captured; preview.srcObject = captured; preview.hidden = false; await preview.play();
      captured.getVideoTracks()[0].addEventListener('ended', () => { if (stream === captured) { release(); void call('capture-error').catch(message); } }, { once: true });
      await sample(true); if (stream === captured) timer = setInterval(() => void sample(), 1000);
    } catch (error) {
      if (epoch === captureEpoch) { release(); if (begun) await call('capture-error').catch(() => {}); message(error); }
    } finally { if (snapshot?.phase !== 'sharing') $('start').disabled = false; }
  });
  $('pause').addEventListener('click', () => { release(); void call('pause').then(render, message); });
  $('stop').addEventListener('click', () => { release(); $('share-context').checked = false; void call('stop').then(render, message); });
  $('back').addEventListener('click', () => { release(); void call('hide').catch(message); });
  $('question-form').addEventListener('submit', async event => {
    event.preventDefault(); const input = $('question'), text = input.value.trim(); if (!text) return;
    try { await call('ask', { text }); await sample(true); input.value = ''; } catch (error) { message(error); }
  });
  form.elements.mode.addEventListener('change', settingsMode);
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = form.querySelector('button'); button.disabled = true; release();
    try {
      const key = form.elements.clearKey.checked ? { action: 'clear' } : form.elements.key.value.trim() ? { action: 'replace', value: form.elements.key.value } : { action: 'keep' };
      const value = await call('settings', { mode: form.elements.mode.value, protocol: form.elements.protocol.value, baseUrl: form.elements.baseUrl.value, model: form.elements.model.value, key });
      form.elements.key.value = ''; form.elements.clearKey.checked = false; $('share-context').checked = false; render(value); status.textContent = '视觉设置已保存；收到回复后请自行核对画面内容';
    } catch (error) { message(error); } finally { button.disabled = false; }
  });
  const off = api.subscribe(render);
  window.addEventListener('pagehide', () => { release(); off(); void call('pause').catch(() => {}); }, { once: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden && stream) { release(); void call('pause').catch(() => {}); } });
  call('state').then(render, message); void refresh();
})();
