// Executable protocol reference, not a native NEKO/whale adapter or app backend.
const copy = value => structuredClone(value);
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

export class MemoryHub {
  constructor({ personaId, adapters, snapshot, persist = async () => {} }) {
    if (!personaId) throw Error('personaId is required');
    for (const [name, adapter] of Object.entries(adapters)) {
      if (!['diary', 'neko'].includes(name) || adapter.personaId !== personaId) throw Error('adapter persona mismatch');
    }
    if (snapshot && snapshot.personaId !== personaId) throw Error('snapshot persona mismatch');
    this.adapters = adapters;
    this.persist = persist;
    this.state = copy(snapshot || { personaId, mode: 'diary', events: [], cursors: {}, acknowledgements: {} });
    this.queue = Promise.resolve();
  }
  snapshot() { return copy(this.state); }
  serial(task) {
    const job = this.queue.then(task);
    this.queue = job.catch(() => {});
    return job;
  }
  async commit(next) { await this.persist(copy(next)); this.state = next; }
  validate(events, state) {
    const known = new Map(state.events.map(event => [event.eventId, event]));
    for (const event of events) {
      if (event.personaId !== state.personaId) throw Error('event persona mismatch');
      if (!event.eventId || !event.itemId || !Array.isArray(event.parents)) throw Error('invalid event identity');
      if (!['diary', 'neko', 'user'].includes(event.origin)) throw Error('invalid origin');
      if (!['upsert', 'delete', 'restore'].includes(event.operation)) throw Error('invalid operation');
      if (event.operation !== 'delete') {
        const value = event.value;
        if (!value || typeof value.text !== 'string' || value.text.length > 30000) throw Error('invalid value');
        if (!['owner', 'private'].includes(value.visibility)) throw Error('invalid visibility');
        if (!['candidate', 'inferred', 'user-confirmed'].includes(value.certainty)) throw Error('invalid certainty');
        if (value.priority !== undefined && (!Number.isInteger(value.priority) || value.priority < 0 || value.priority > 100)) throw Error('invalid priority');
        if (value.pinned !== undefined && typeof value.pinned !== 'boolean') throw Error('invalid pin');
      }
      const old = known.get(event.eventId);
      if (old && stable(old) !== stable(event)) throw Error('eventId collision');
      if (old) continue;
      for (const parentId of event.parents) {
        const parent = known.get(parentId);
        if (!parent || parent.itemId !== event.itemId) throw Error('missing or foreign parent');
        if (parent.operation === 'delete' && event.operation === 'upsert') throw Error('explicit restore required');
      }
      known.set(event.eventId, event);
    }
    return [...known.values()];
  }
  add(events) {
    return this.serial(async () => {
      const next = copy(this.state);
      next.events = this.validate(copy(events), next);
      await this.commit(next);
    });
  }
  records() {
    const groups = new Map();
    for (const event of this.state.events) {
      const group = groups.get(event.itemId) || [];
      group.push(event); groups.set(event.itemId, group);
    }
    return [...groups].map(([itemId, events]) => {
      const superseded = new Set(events.flatMap(event => event.parents));
      const heads = events.filter(event => !superseded.has(event.eventId));
      const deleted = heads.some(event => event.operation === 'delete');
      return { itemId, createdAt: events[0].occurredAt, heads: copy(heads), conflict: heads.length !== 1, deleted,
        ...(deleted ? { previousValue: copy([...events].reverse().find(event => event.value)?.value) } : {}),
        value: heads.length === 1 && !deleted ? copy(heads[0].value) : null };
    });
  }
  async ready(name) {
    const adapter = this.adapters[name];
    if (!adapter) throw Error('adapter not configured');
    const result = await adapter.health();
    if (!result.ready) throw Error(result.reason || 'adapter offline');
    const capability = result.capabilities;
    if (capability?.protocol !== 1 || !['pull', 'push', 'idempotency', 'tombstones', 'privateMemory'].every(key => capability[key] === true)) {
      throw Error('compatible private-memory bridge required');
    }
    return adapter;
  }
  async syncOne(name) {
    const adapter = await this.ready(name);
    const incoming = await adapter.pull(this.state.cursors[name]);
    if (typeof incoming.nextCursor !== 'string') throw Error('invalid cursor');
    let next = copy(this.state);
    next.events = this.validate(copy(incoming.events), next);
    next.cursors[name] = incoming.nextCursor;
    next.acknowledgements[name] = [...new Set([...(next.acknowledgements[name] || []), ...incoming.events.map(event => event.eventId)])];
    await this.commit(next); // Cursor moves only after the incoming batch is durable.
    const acknowledged = new Set(this.state.acknowledgements[name]);
    const pending = this.state.events.filter(event => !acknowledged.has(event.eventId));
    if (!pending.length) return;
    const response = await adapter.push(copy(pending));
    const sent = new Set(pending.map(event => event.eventId));
    if (!Array.isArray(response.ackedEventIds) || new Set(response.ackedEventIds).size !== response.ackedEventIds.length || response.ackedEventIds.some(id => !sent.has(id))) throw Error('invalid acknowledgement');
    next = copy(this.state);
    next.acknowledgements[name] = [...new Set([...acknowledged, ...response.ackedEventIds])];
    await this.commit(next);
    if (response.ackedEventIds.length !== pending.length) throw Error('delivery incomplete; retry pending events');
  }
  sync() {
    return this.serial(async () => {
      const results = {};
      for (const name of Object.keys(this.adapters)) {
        try { await this.syncOne(name); results[name] = { ok: true }; }
        catch (error) { results[name] = { ok: false, error: error.message }; }
      }
      return results;
    });
  }
  switchTo(mode) {
    return this.serial(async () => {
      if (!['diary', 'neko'].includes(mode)) throw Error('unknown mode');
      await this.ready(mode);
      await this.commit(copy(this.state)); // Persist a recoverable source checkpoint.
      await this.syncOne(mode);
      if (this.records().some(record => record.conflict)) throw Error('resolve conflicts before switching');
      const next = copy(this.state); next.mode = mode;
      await this.commit(next);
      return this.snapshot();
    });
  }
}
