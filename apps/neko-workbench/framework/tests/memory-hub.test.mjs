import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryHub } from '../reference/memory-hub.mjs';
const capabilities = { protocol: 1, pull: true, push: true, idempotency: true, tombstones: true, privateMemory: true };
class Replica {
  constructor(personaId = 'bigfish') { this.personaId = personaId; this.events = []; this.online = true; this.capabilities = { ...capabilities }; this.pushes = 0; }
  async health() { return { ready: this.online, capabilities: this.capabilities, reason: 'offline' }; }
  async pull(cursor = '0') { return { events: structuredClone(this.events.slice(Number(cursor))), nextCursor: String(this.events.length) }; }
  async push(events) { this.pushes++; for (const event of events) if (!this.events.some(old => old.eventId === event.eventId)) this.events.push(structuredClone(event)); return { ackedEventIds: events.map(event => event.eventId) }; }
}
function event(id, parents = [], options = {}) {
  return { eventId: id, itemId: 'preference-1', personaId: 'bigfish', origin: 'diary', operation: 'upsert', parents,
    occurredAt: '2026-10-26T00:00:00Z', value: { kind: 'preference', text: 'quiet evenings', visibility: 'private', certainty: 'user-confirmed', evidenceRefs: ['message-1'] }, ...options };
}
function fixture(options = {}) {
  const diary = new Replica(), neko = new Replica(); let durable;
  const hub = new MemoryHub({ personaId: 'bigfish', adapters: { diary, neko }, persist: async state => { durable = state; }, ...options });
  return { diary, neko, hub, durable: () => durable };
}
test('two-way replay is idempotent and survives restart', async () => {
  const f = fixture(); f.diary.events.push(event('first'));
  assert((await f.hub.sync()).neko.ok); await f.hub.sync(); await f.hub.sync();
  assert.equal(f.hub.snapshot().events.length, 1); assert.equal(f.neko.events.length, 1); assert.equal(f.diary.events.length, 1);
  const restored = new MemoryHub({ personaId: 'bigfish', adapters: { diary: f.diary, neko: f.neko }, snapshot: f.durable() });
  await restored.sync(); assert.equal(restored.snapshot().events.length, 1);
});
test('offline target keeps mode and local memories; resumes later', async () => {
  const { hub, neko } = fixture(); neko.online = false;
  await hub.add([event('local')]); await assert.rejects(hub.switchTo('neko'), /offline/);
  assert.equal(hub.snapshot().mode, 'diary'); assert.equal(hub.records().length, 1);
  const results = await hub.sync(); assert(results.diary.ok); assert(!results.neko.ok);
  neko.online = true; await hub.switchTo('neko'); assert.equal(hub.snapshot().mode, 'neko'); assert.equal(neko.events.length, 1);
});
test('concurrent edits preserve both branches until explicit merge', async () => {
  const { hub, diary, neko } = fixture(); await hub.add([event('base')]); await hub.sync();
  diary.events.push(event('left', ['base'], { value: { ...event('x').value, text: 'left edit' } }));
  neko.events.push(event('right', ['base'], { origin: 'neko', value: { ...event('x').value, text: 'right edit' } }));
  await hub.sync(); const row = hub.records()[0]; assert(row.conflict); assert.equal(row.heads.length, 2); assert.equal(row.value, null);
  await assert.rejects(hub.switchTo('neko'), /conflicts/); assert.equal(hub.snapshot().mode, 'diary');
  await hub.add([event('merged', ['left', 'right'], { origin: 'user' })]); await hub.switchTo('neko'); assert(!hub.records()[0].conflict);
});
test('tombstone does not resurrect on replay; restore is explicit', async () => {
  const { hub } = fixture(); await hub.add([event('base'), event('removed', ['base'], { operation: 'delete', value: undefined })]);
  await hub.add([event('base')]); assert(hub.records()[0].deleted);
  await assert.rejects(hub.add([event('bad', ['removed'])]), /restore/);
  await hub.add([event('restored', ['removed'], { operation: 'restore', origin: 'user' })]); assert(!hub.records()[0].deleted);
});
test('role boundaries, immutable event IDs and private target capabilities', async () => {
  assert.throws(() => new MemoryHub({ personaId: 'bigfish', adapters: { diary: new Replica('other') } }), /persona/);
  const { hub, neko } = fixture(); await assert.rejects(hub.add([event('foreign', [], { personaId: 'other' })]), /persona/);
  await hub.add([event('one')]); await assert.rejects(hub.add([event('one', [], { origin: 'neko' })]), /collision/);
  neko.capabilities.privateMemory = false; assert(!(await hub.sync()).neko.ok); assert.equal(neko.pushes, 0);
});
test('failed durable write does not commit events or source cursor', async () => {
  const diary = new Replica(); diary.events.push(event('one'));
  const hub = new MemoryHub({ personaId: 'bigfish', adapters: { diary }, persist: async () => { throw Error('disk full'); } });
  assert(!(await hub.sync()).diary.ok); assert.equal(hub.snapshot().events.length, 0); assert.equal(hub.snapshot().cursors.diary, undefined);
});
test('duplicate acknowledgements cannot falsely complete a mode switch', async () => {
  const { hub, neko } = fixture();
  await hub.add([event('one'), event('two', ['one'])]);
  neko.push = async () => ({ ackedEventIds: ['one', 'one'] });
  await assert.rejects(hub.switchTo('neko'), /acknowledgement/);
  assert.equal(hub.snapshot().mode, 'diary');
  assert.deepEqual(hub.snapshot().acknowledgements.neko, []);
});
