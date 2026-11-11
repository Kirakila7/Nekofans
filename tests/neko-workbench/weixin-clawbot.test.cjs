'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { createWeixinClawBot } = require('../../apps/neko-workbench/weixin-clawbot.cjs');

function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.ok(predicate(), 'expected ClawBot state was not reached');
}

test('Weixin QR and PIN bind only the owner, preserve the cursor and reply once', async (t) => {
  let credential = null, sync = null, polls = 0;
  const prompts = [], replies = [];
  const incoming = (id, sender, extra = {}) => ({
    message_id: id, from_user_id: sender, message_type: 1, context_token: 'reply-context',
    item_list: [{ type: 1, text_item: { text: '小窝晚安' } }], ...extra,
  });
  const messages = [
    incoming('foreign', 'someone-else'),
    incoming('group', 'owner', { group_id: 'room' }),
    incoming('media', 'owner', { item_list: [{ type: 2 }] }),
    incoming('same-owner', 'owner'),
    incoming('same-owner', 'owner'),
  ];
  const controller = createWeixinClawBot({
    pollDelayMs: 1,
    secretStore: {
      available: () => true, get: async () => credential,
      set: async (value) => { credential = value; },
      clear: async () => { credential = null; },
    },
    syncStore: { read: () => sync, write: (value) => { sync = value; } },
    onMessage: async (text) => { prompts.push(text); return '晚安，灯还亮着。'; },
    fetch: async (url, options) => {
      switch (url.pathname.split('/').at(-1)) {
        case 'get_bot_qrcode':
          assert.equal(options.method, 'POST');
          assert.equal(url.searchParams.get('bot_type'), '3');
          assert.deepEqual(JSON.parse(options.body), { local_token_list: [] });
          assert.equal(options.headers.Authorization, undefined);
          return Response.json({ qrcode: 'fixture-qr', qrcode_img_content: 'https://example.invalid/test-pairing' });
        case 'get_qrcode_status':
          assert.equal(url.searchParams.get('qrcode'), 'fixture-qr');
          if (url.searchParams.get('verify_code') !== '123456') return Response.json({ status: 'need_verifycode' });
          return Response.json({ status: 'confirmed', bot_token: 'fake', ilink_bot_id: 'bot-fixture', ilink_user_id: 'owner' });
        case 'getupdates':
          assert.equal(options.headers.Authorization, 'Bearer fake');
          assert.equal(options.redirect, 'error');
          if (polls++ === 0) return Response.json({ ret: 0, msgs: messages, get_updates_buf: 'next-cursor' });
          assert.equal(JSON.parse(options.body).get_updates_buf, 'next-cursor');
          return waitForAbort(options.signal);
        case 'sendmessage':
          replies.push(JSON.parse(options.body).msg);
          return Response.json({ ret: 0 });
        default: throw Error('Unexpected test request');
      }
    },
  });
  t.after(() => controller.dispose());
  const qr = await controller.begin();
  assert.match(qr.qrImage, /^data:image\/png;base64,/);
  await until(() => controller.snapshot().phase === 'pin');
  assert.throws(() => controller.pin('abcd'), /验证码/);
  controller.pin('123456');
  await until(() => polls >= 2);
  assert.deepEqual(prompts, ['小窝晚安']);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].to_user_id, 'owner');
  assert.equal(replies[0].context_token, 'reply-context');
  assert.equal(replies[0].item_list[0].text_item.text, '晚安，灯还亮着。');
  assert.deepEqual(sync.seen, ['same-owner']);
  assert.equal(controller.snapshot().bound, true);
  assert.equal(JSON.stringify(controller.snapshot()).includes('fake'), false);
  await controller.disconnect();
  assert.equal(credential, null);
  assert.deepEqual(controller.snapshot(), { phase: 'unbound', bound: false });
});

test('Weixin rejects a returned API origin outside Tencent before saving a binding', async (t) => {
  let saved = false;
  const controller = createWeixinClawBot({
    secretStore: { available: () => true, set: async () => { saved = true; } },
    syncStore: {}, onMessage: async () => null, renderQr: async () => 'fixture-image',
    fetch: async (url) => url.pathname.endsWith('get_bot_qrcode')
      ? Response.json({ qrcode: 'fixture-qr', qrcode_img_content: 'fixture-link' })
      : Response.json({ status: 'confirmed', baseurl: 'https://weixin.qq.com.example.invalid',
        bot_token: 'fake', ilink_bot_id: 'bot-fixture', ilink_user_id: 'owner' }),
  });
  t.after(() => controller.dispose());
  await controller.begin();
  await until(() => controller.snapshot().phase === 'error');
  assert.equal(saved, false);
  assert.equal(controller.snapshot().bound, false);
});
