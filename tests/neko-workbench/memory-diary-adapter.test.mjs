import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { WhaleDiaryMemoryAdapter } from '../../apps/neko-workbench/memory/diary-adapter.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'neko-diary-adapter-'));
  const source = join(directory, 'synthetic-diary.txt');
  const instances = new Set();
  const create = (sourceFiles = [{ path: source, visibility: 'private' }]) => {
    const adapter = new WhaleDiaryMemoryAdapter({ directory: join(directory, 'ledger'), sourceFiles });
    instances.add(adapter);
    return adapter;
  };
  t.after(() => {
    for (const instance of instances) instance.close();
    assert.equal(dirname(directory), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  return { source, create, close(adapter) { instances.delete(adapter); adapter.close(); } };
}

test('diary import remains a candidate with evidence and does not change the source across replay or restart', async t => {
  const { source, create, close } = fixture(t);
  const original = Buffer.from('合成日记第一段\r\n\r\n合成日记第二段\r\n', 'utf8');
  writeFileSync(source, original);
  const first = create();
  const initial = await first.pull();
  assert.equal(initial.events.length, 2);
  for (const event of initial.events) {
    assert.equal(event.value.kind, 'episode');
    assert.equal(event.value.certainty, 'candidate');
    assert.equal(event.value.visibility, 'private');
    assert.equal(event.value.evidenceRefs.length, 1);
    assert(!JSON.stringify(event).includes(source));
  }
  assert.deepEqual(await first.pull(initial.nextCursor), { events: [], nextCursor: initial.nextCursor });
  close(first);
  const reopened = create();
  assert.deepEqual((await reopened.pull()).events, initial.events);
  assert.deepEqual(readFileSync(source), original);
});

test('diary revisions preserve identity and a tombstone survives rereading the original source', async t => {
  const { source, create } = fixture(t);
  writeFileSync(source, '合成旧段落');
  const adapter = create();
  const original = (await adapter.pull()).events[0];
  writeFileSync(source, '合成修订段落');
  const revised = (await adapter.pull('1')).events[0];
  assert.equal(revised.itemId, original.itemId);
  assert.deepEqual(revised.parents, [original.eventId]);
  await adapter.push([{ eventId: 'synthetic-delete', itemId: revised.itemId,
    personaId: 'bigfish', origin: 'user', operation: 'delete', parents: [revised.eventId],
    occurredAt: '2026-11-01T00:00:00Z' }]);
  writeFileSync(source, '合成旧段落');
  assert.deepEqual((await adapter.pull('3')).events, []);
  assert.equal(adapter.store.records()[0].deleted, true);
  assert.equal(readFileSync(source, 'utf8'), '合成旧段落');
});

test('diary binding rejects relative paths, public imports and implicit rebinding', t => {
  const { source, create } = fixture(t);
  assert.throws(() => create([{ path: 'relative.txt', visibility: 'private' }]), /invalid diary binding/);
  assert.throws(() => create([{ path: source, visibility: 'public' }]), /invalid diary binding/);
  create();
  assert.throws(() => create([{ path: source, visibility: 'owner' }]), /explicit migration required/);
});
