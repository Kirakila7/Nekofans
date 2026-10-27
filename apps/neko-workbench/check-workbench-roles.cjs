'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { createRolesStore } = require('./workbench-roles.cjs');

// Real PNG fixtures, including a 2x2 RGBA image encoded independently with Pillow.
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const SECOND_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGPU2PLwPwMDAwMTiABhACk/AsAL3DtrAAAAAElFTkSuQmCC';
const defaults = {
  activeId: 'bigfish',
  roles: [
    { id: 'yui', name: 'Yui', avatarId: 'yui', customDataUrl: null, enabled: false },
    { id: 'bigfish', name: '大肥鱼', avatarId: 'bigfish', customDataUrl: null, enabled: true },
    { id: 'claude', name: 'Claude小姐', avatarId: 'claude', customDataUrl: null, enabled: false },
  ],
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-workbench-roles-'));
let checks = 0;
function check(name, run) {
  run();
  checks++;
  console.log(`PASS ${name}`);
}
function file(name) { return path.join(root, name); }
function role(store, id) { return store.get().roles.find(item => item.id === id); }
function writeJson(name, value) { fs.writeFileSync(file(name), JSON.stringify(value)); }
function pngWithComment(byteLength) {
  const original = Buffer.from(PIXEL.split(',')[1], 'base64');
  const payload = Buffer.concat([Buffer.from('Comment\0'), Buffer.alloc(byteLength, 0x61)]);
  const chunk = Buffer.alloc(12 + payload.length);
  chunk.writeUInt32BE(payload.length);
  chunk.write('tEXt', 4, 'ascii');
  payload.copy(chunk, 8);
  // Use Node's encoder checksum, independently of the store's decoder/checksum implementation.
  chunk.writeUInt32BE(zlib.crc32(chunk.subarray(4, chunk.length - 4)), chunk.length - 4);
  return 'data:image/png;base64,' + Buffer.concat([original.subarray(0, 33), chunk, original.subarray(33)]).toString('base64');
}

try {
  check('defaults contain exactly three fixed role slots; only bigfish can be selected', () => {
    const store = createRolesStore(file('initial.json'));
    assert.deepEqual(store.get(), defaults);
    assert.throws(() => store.select('yui'), /暂未接入/);
    assert.throws(() => store.select('claude'), /暂未接入/);
    assert.deepEqual(store.select('bigfish'), defaults);
    assert.throws(() => store.select('another'), /未知角色/);
  });

  check('custom names and avatars persist separately and snapshots cannot mutate the store', () => {
    const store = createRolesStore(file('personal.json'));
    const updated = store.update('yui', { name: '  结衣  ', avatarId: 'gemini' });
    assert.equal(updated.roles[0].name, '结衣');
    assert.equal(updated.roles[0].avatarId, 'gemini');
    assert.deepEqual(updated.roles[1], defaults.roles[1]);
    updated.roles[0].name = '外部篡改';
    updated.roles.push({ id: 'unexpected' });
    assert.equal(store.get().roles.length, 3);
    assert.equal(role(store, 'yui').name, '结衣');
    const uploaded = store.upload('claude', PIXEL);
    assert.equal(uploaded.roles[2].avatarId, 'custom');
    assert.equal(uploaded.roles[2].customDataUrl, PIXEL);
    store.update('claude', { avatarId: 'devcat' });
    store.update('claude', { avatarId: 'custom', name: '小克' });
    assert.deepEqual(createRolesStore(file('personal.json')).get(), store.get());
    assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith('.tmp')), []);
  });

  check('patches cannot enable, replace, reorder or route a role', () => {
    const store = createRolesStore(file('patches.json'));
    const snapshot = store.update('yui', { enabled: true, enable: true, id: 'bigfish', activeId: 'yui', model: 'anything', roles: [], unknown: 1 });
    assert.deepEqual(snapshot, defaults);
    assert.throws(() => store.select('yui'), /暂未接入/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file('patches.json'), 'utf8')), defaults);
    assert.throws(() => store.update('yui', { customDataUrl: PIXEL }), /上传/);
    assert.equal(role(store, 'yui').customDataUrl, null);
  });

  check('saved fields recover independently while injected availability and extra roles are discarded', () => {
    writeJson('mixed.json', {
      activeId: 'yui', unknown: true,
      roles: [
        { id: 'claude', name: '\u0000broken', avatarId: 'custom', customDataUrl: PIXEL, enabled: true, backend: 'enabled' },
        { id: 'yui', name: '  已保存的结衣 ', avatarId: 'custom', customDataUrl: 'invalid', enabled: true },
        { id: 'surprise', name: 'Injected', enabled: true },
        { id: 'bigfish', name: '工作鱼', avatarId: 'unknown', customDataUrl: null, enabled: false },
      ],
    });
    const store = createRolesStore(file('mixed.json'));
    assert.deepEqual(store.get(), {
      activeId: 'bigfish',
      roles: [
        { id: 'yui', name: '已保存的结衣', avatarId: 'yui', customDataUrl: null, enabled: false },
        { id: 'bigfish', name: '工作鱼', avatarId: 'bigfish', customDataUrl: null, enabled: true },
        { id: 'claude', name: 'Claude小姐', avatarId: 'custom', customDataUrl: PIXEL, enabled: false },
      ],
    });
    assert.throws(() => store.select('claude'), /暂未接入/);
    store.select('bigfish');
    assert.deepEqual(JSON.parse(fs.readFileSync(file('mixed.json'), 'utf8')), store.get());
  });

  check('missing, damaged and unexpected top-level configuration falls back predictably', () => {
    for (const [index, content] of ['{broken', 'null', '[]', '{"roles":{}}', '{"roles":[null,42,"yui"]}'].entries()) {
      const target = file(`damaged-${index}.json`);
      fs.writeFileSync(target, content);
      assert.deepEqual(createRolesStore(target).get(), defaults);
    }
    assert.deepEqual(createRolesStore(file('missing.json')).get(), defaults);
  });

  check('invalid names, role identifiers and avatars are rejected without partial updates', () => {
    const store = createRolesStore(file('invalid.json'));
    for (const name of ['', '   ', '字'.repeat(25), 'hello\nworld', '\tname', 'bad\u007fname', 'bad\u202ename', null, 123]) {
      assert.throws(() => store.update('bigfish', { name }));
      assert.deepEqual(store.get(), defaults);
    }
    assert.equal(store.update('bigfish', { name: '字'.repeat(24) }).roles[1].name.length, 24);
    const before = store.get();
    assert.throws(() => store.update('bigfish', { name: '部分更新', avatarId: 'unknown' }), /头像/);
    assert.throws(() => store.update('yui', { avatarId: 'custom' }), /上传/);
    assert.throws(() => store.update('unknown', { name: 'x' }), /未知角色/);
    assert.throws(() => store.upload('unknown', PIXEL), /未知角色/);
    assert.throws(() => store.update('bigfish', []), /格式/);
    assert.deepEqual(store.get(), before);
  });

  check('uploads reject other image formats, fake signatures, corrupt PNG and oversized data', () => {
    const store = createRolesStore(file('images.json'));
    const corrupt = Buffer.from(PIXEL.split(',')[1], 'base64');
    corrupt[45] ^= 1;
    const invalidImages = [
      'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
      'data:image/png;base64,' + Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]).toString('base64'),
      'data:image/png;base64,' + corrupt.toString('base64'),
      pngWithComment(1024 * 1024),
      PIXEL + '!',
      PIXEL.replace('base64,', 'base64,\n'),
      null,
    ];
    for (const image of invalidImages) {
      assert.throws(() => store.upload('bigfish', image), /PNG.*1 MB/);
      assert.deepEqual(store.get(), defaults);
    }
    const nearLimit = pngWithComment(1024 * 1024 - 256);
    assert.equal(store.upload('yui', nearLimit).roles[0].customDataUrl, nearLimit);
    assert.equal(store.upload('bigfish', PIXEL).roles[1].customDataUrl, PIXEL);
    // A replacement is observable and survives a new process-independent store instance.
    assert.equal(store.upload('bigfish', SECOND_PIXEL).roles[1].customDataUrl, SECOND_PIXEL);
    assert.equal(role(createRolesStore(file('images.json')), 'bigfish').customDataUrl, SECOND_PIXEL);
  });

  check('a failed atomic save leaves the in-memory state intact', () => {
    const target = file('cannot-be-a-config');
    fs.mkdirSync(target);
    const store = createRolesStore(target);
    assert.throws(() => store.update('bigfish', { name: '未保存' }));
    assert.deepEqual(store.get(), defaults);
    assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith('.tmp')), []);
  });

  check('role edits leave existing external session and memory files byte-for-byte unchanged', () => {
    const external = file('existing-workbench');
    fs.mkdirSync(path.join(external, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(external, 'memory'), { recursive: true });
    const existing = [path.join(external, 'sessions', 'conversation.json'), path.join(external, 'memory', 'notes.md')];
    fs.writeFileSync(existing[0], '{"sessionId":"existing","messages":["不要改我的会话"]}\n');
    fs.writeFileSync(existing[1], '保留已有记忆\n');
    const fingerprint = () => existing.map(target => ({
      target, sha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
      mtimeMs: fs.statSync(target).mtimeMs,
    }));
    const before = fingerprint();
    const store = createRolesStore(path.join(external, 'role-settings.json'));
    store.update('bigfish', { name: '新名字', avatarId: 'claude' });
    store.upload('yui', PIXEL);
    store.select('bigfish');
    assert.deepEqual(fingerprint(), before);
    assert.deepEqual(fs.readdirSync(path.join(external, 'sessions')), ['conversation.json']);
    assert.deepEqual(fs.readdirSync(path.join(external, 'memory')), ['notes.md']);
  });

  console.log(`Role store: ${checks} offline checks passed; temporary fixtures only.`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
