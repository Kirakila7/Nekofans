'use strict';
const { currentTaskFromTodo } = require('./original/work-status.cjs');
const { cleanPrompt, historyContext } = require('./pet-context.js');
const SOURCE = 'dsh-task-session';
const text = blocks => (blocks || []).filter(block => block?.type === 'text').map(block => block.text || '').join('\n');
const short = value => Array.from(cleanPrompt(value).trim()).slice(0, 240).join('');
const ownEvents = observation => (observation.events || []).slice(observation.inheritedEventCount || 0);
const human = event => event?.type === 'user/message' && event.data?.source?.kind === 'user'
  && Array.isArray(event.data.content) && event.data.content.some(block => block?.type === 'text'
    ? !!cleanPrompt(block.text).trim() : typeof block?.type === 'string');

// Tracks only real human-owned task sessions. Ordinary forks may have a parent;
// the native origin, own descriptor or catalog identity classifies subagents.
function createTaskSessionTracker({ emit, getAgent = () => null, observeSession,
  getLiveJobs = () => undefined } = {}) {
  const records = new Map(), excluded = new Set(), restoring = new Map();
  let closed = false, lastRoster = null;
  const idOf = value => typeof value === 'string' && value.length > 0 ? value : null;
  function fresh(header) {
    return { sessionId: header.id, header, title: '', promptTask: '', currentTask: null,
      human: false, status: undefined, jobs: new Map(), settled: new Set(), outcomes: new Map(), liveOutcomes: new Set(), batchStart: null, createdAt: header.createdAt };
  }
  function roster() {
    if (closed) return;
    const sessionIds = [...records.values()].filter(record => record.human && !excluded.has(record.sessionId)).map(record => record.sessionId);
    const key = JSON.stringify(sessionIds);
    if (key !== lastRoster) { lastRoster = key; emit('task-roster', { source: SOURCE, sessionIds }); }
  }
  function exclude(id) {
    if (!idOf(id)) return;
    excluded.add(id); records.delete(id); roster();
  }
  function inspect(session) {
    const id = idOf(session?.id || session?.header?.id);
    if (!id || closed) return null;
    if (session.header?.origin === 'subagent') { exclude(id); return null; }
    if (excluded.has(id)) return null;
    let record = records.get(id);
    if (!record) { record = fresh({ ...session.header, id }); records.set(id, record); }
    return record;
  }
  function apply(record, event, live = false) {
    // A new turn starts a new result only after the prior background batch
    // ended. Active siblings must retain an earlier failed/killed result.
    if ((human(event) || event.type === 'turn/start') && record.jobs.size === 0) {
      record.outcomes.clear(); record.liveOutcomes.clear();
      record.batchStart = `${event.type}:${event.seq ?? event.time}`;
    }
    if (event.type === 'session/title') record.title = short(event.data?.title);
    if (human(event)) {
      record.human = true; record.promptTask = short(text(event.data.content)); record.currentTask = null;
    }
    if (event.type === 'todo/write') record.currentTask = currentTaskFromTodo(event);
    if (['job/registered', 'job/settled'].includes(event.type)) {
      const data = event.data || {}, jobId = idOf(data.jobId);
      if (!jobId || typeof data.kind !== 'string' || !data.kind || (data.owner != null && data.owner !== record.sessionId)) return;
      if (event.type === 'job/registered') {
        if (!record.settled.has(jobId) && (data.status == null || ['running', 'stopping'].includes(data.status))) {
          record.jobs.set(jobId, { kind: data.kind, status: data.status || 'running' });
        }
      } else if (typeof data.status === 'string' && data.status && !['running', 'stopping'].includes(data.status)) {
        if (record.settled.has(jobId)) return;
        record.jobs.delete(jobId); record.settled.add(jobId);
        record.outcomes.set(jobId, ['completed', 'killed', 'failed'].includes(data.status) ? data.status : 'unknown');
        if (live) record.liveOutcomes.add(jobId);
      }
    }
  }
  function liveJobs(id) {
    try {
      const jobs = getLiveJobs(id);
      if (!Array.isArray(jobs)) return undefined;
      return new Map(jobs.filter(job => job.owner === id && ['running', 'stopping'].includes(job.status)
        && idOf(job.id) && typeof job.kind === 'string').map(job => [job.id, { kind: job.kind, status: job.status }]));
    } catch { return undefined; }
  }
  function outcome(record) {
    const values = new Set(record.outcomes.values());
    return ['failed', 'killed', 'unknown', 'completed'].find(value => values.has(value)) || null;
  }
  function reconcileJobs(record, jobs) {
    for (const jobId of record.jobs.keys()) {
      if (!jobs.has(jobId) && !record.settled.has(jobId)) {
        record.outcomes.set(jobId, 'unknown'); record.liveOutcomes.add(jobId);
      }
    }
    record.jobs = jobs;
  }
  function publish(record) {
    if (closed || excluded.has(record.sessionId) || !record.human || records.get(record.sessionId) !== record) return;
    const agent = getAgent(record.sessionId);
    const backgroundJobs = record.jobs.size;
    emit('task-meta', { source: SOURCE, sessionId: record.sessionId,
      name: record.title || record.promptTask || '工作台任务', title: record.title,
      task: record.currentTask || record.promptTask || record.title || '',
      running: (record.status ?? agent?.status) === 'running' || backgroundJobs > 0,
      backgroundJobs, outcome: outcome(record), createdAt: record.createdAt });
    roster();
  }
  function onEvent(session, event) {
    const id = idOf(session?.id || session?.header?.id);
    if (!id || closed) return;
    const inherited = session.inheritedEventCount || 0;
    if (Number.isInteger(event.seq) && event.seq < inherited) return;
    if (event.type === 'subagent/descriptor') { exclude(id); return; }
    const record = inspect(session);
    if (!record) return;
    restoring.get(id)?.events.push(event);
    apply(record, event, true); publish(record);
  }
  function onStatus(agent, status) {
    const record = inspect(agent.session || { id: agent.id, header: { id: agent.id } });
    if (!record) return;
    record.status = status; publish(record);
    // A native UI resume can emit running before any new user/message. Check
    // its own durable human history rather than inventing a task from status.
    if (!record.human && status === 'running') void restore(record.sessionId);
  }
  async function restore(id) {
    if (closed || !idOf(id) || excluded.has(id)) return false;
    if (restoring.has(id)) return restoring.get(id).promise;
    const pending = { events: [], promise: null };
    restoring.set(id, pending);
    pending.promise = (async () => {
      let observation;
      try {
        observation = await observeSession(id);
        if (closed || excluded.has(id) || observation.header?.id !== id) return false;
        const events = ownEvents(observation);
        if (observation.header.origin === 'subagent' || events.some(event => event.type === 'subagent/descriptor')) { exclude(id); return false; }
        const record = fresh(observation.header);
        for (const event of events) apply(record, event);
        record.title = short(observation.projections?.values?.title || record.title);
        const previous = records.get(id);
        // Replay source-time facts before consulting a later registry snapshot.
        // Future jobs must not prevent an intervening human/turn from clearing
        // an already-ended batch. Previous live evidence belongs to one batch.
        if (previous?.batchStart === record.batchStart) {
          for (const [jobId, result] of previous.outcomes) record.outcomes.set(jobId, result);
          for (const jobId of previous.liveOutcomes) record.liveOutcomes.add(jobId);
        }
        record.status = previous?.status ?? getAgent(id)?.status;
        const cursor = observation.cursor ?? observation.events?.at(-1)?.seq;
        const tail = [];
        for (const event of pending.events) {
          if (Number.isInteger(cursor) && Number.isInteger(event.seq) && event.seq <= cursor) continue;
          tail.push(event); apply(record, event, true);
        }
        // Old unfinished registrations do not prove a process is running.
        // Keep historical results only for a batch with a matching live job;
        // otherwise retain just evidence actually observed by this process.
        const currentJobs = liveJobs(id) ?? new Map(previous?.jobs || []);
        const continuingBatch = [...currentJobs.keys()].some(jobId => record.jobs.has(jobId));
        if (continuingBatch) reconcileJobs(record, currentJobs);
        else {
          // A live settlement proves this batch just ended here, so retain
          // its historical siblings' results too. Reset boundaries already
          // removed any evidence belonging to an earlier batch.
          if (record.liveOutcomes.size === 0) record.outcomes.clear();
          for (const jobId of previous?.jobs.keys() || []) {
            if (previous.batchStart === record.batchStart && !currentJobs.has(jobId) && !record.settled.has(jobId)) {
              record.outcomes.set(jobId, 'unknown'); record.liveOutcomes.add(jobId);
            }
          }
          record.jobs = currentJobs;
        }
        if (closed || excluded.has(id)) return false;
        records.set(id, record); publish(record); roster();
        if (record.human) emit('session-context', { sessionId: id, title: record.title, ...historyContext({ ...observation, events: [...observation.events, ...tail] }, false) });
        return record.human;
      } catch {
        // Missing/deleted/private-unavailable sessions cannot be reintroduced
        // from a persisted UI id alone. No upstream diagnostic is echoed.
        return false;
      } finally {
        observation?.[Symbol.dispose]?.();
        if (restoring.get(id) === pending) restoring.delete(id);
      }
    })();
    return pending.promise;
  }
  function refresh() {
    if (closed) return;
    for (const record of records.values()) {
      const agent = getAgent(record.sessionId);
      if (agent?.session?.header?.origin === 'subagent') { exclude(record.sessionId); continue; }
      record.status = agent?.status;
      const jobs = liveJobs(record.sessionId);
      if (jobs) reconcileJobs(record, jobs);
      publish(record);
    }
    roster();
  }
  roster();
  return Object.freeze({ onEvent, onStatus, exclude, restore, refresh,
    isSubagent: id => excluded.has(id),
    has: id => !closed && !excluded.has(id) && records.get(id)?.human === true,
    dispose() { closed = true; records.clear(); restoring.clear(); } });
}
module.exports = { SOURCE, createTaskSessionTracker };
