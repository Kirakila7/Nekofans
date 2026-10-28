'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createTtsController } = require('../../apps/neko-workbench/tts-runtime.cjs');

function setup() {
  const children = [], events = [];
  const spawnImpl = (exe, args, options) => {
    const p = new EventEmitter(); p.stdin = new PassThrough(); p.stdout = new PassThrough(); p.exitCode = null; p.killed = false;
    p.kill = () => { p.killed = true; p.exitCode = 0; return true; };
    p.args = { exe, args, options }; children.push(p); return p;
  };
  const controller = createTtsController({ repositoryRoot: '/source', python: '/runtime/python', spawnImpl, onEvent: e => events.push(e), timeoutMs: 1000 });
  return { children, events, controller };
}
test('streams private PCM with caller request id and finishes once', () => {
  const { children, events, controller } = setup();
  assert.equal(controller.speak('你好', 'r1'), 'r1');
  assert.equal(children[0].args.exe, '/runtime/python');
  assert.equal(children[0].args.options.stdio[0], 'pipe');
  children[0].stdout.write(JSON.stringify({ type:'audio', pcm:'AQI=', sampleRate:48000 }) + '\n');
  children[0].stdout.write(JSON.stringify({ type:'ended' }) + '\n');
  children[0].emit('close', 0);
  assert.deepEqual(events, [{ requestId:'r1', type:'audio', pcm:'AQI=', sampleRate:48000 }, { requestId:'r1', type:'ended' }]);
});
test('stopping old request prevents late data reaching next request', () => {
  const { children, events, controller } = setup();
  controller.speak('旧语音', 'old'); controller.speak('新语音', 'new');
  controller.stop('old');
  children[0].stdout.write(JSON.stringify({type:'audio',pcm:'AQI=',sampleRate:48000}) + '\n');
  children[1].stdout.write(JSON.stringify({type:'audio',pcm:'AgM=',sampleRate:48000}) + '\n');
  controller.stop('new'); controller.stop('new');
  assert.deepEqual(events.map(x => [x.requestId,x.type]), [['old','stopped'],['new','audio'],['new','stopped']]);
  assert.ok(children.every(p => p.killed));
});
test('startup failures and malformed data end without falling back to a test tone', () => {
  const { children, events, controller } = setup();
  controller.speak('测试', 'a'); children[0].emit('error', new Error('ENOENT'));
  controller.speak('测试', 'b'); children[1].stdout.write('not-json\n');
  assert.deepEqual(events.map(x=>x.type), ['error','error']);
  assert.ok(events.every(x=>!('pcm' in x)));
  controller.close();
  assert.throws(() => controller.speak('测试','c'));
});
