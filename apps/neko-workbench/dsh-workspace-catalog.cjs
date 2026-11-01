'use strict';
// Read the native logical corpus. Never parse another profile's files or
// create/resume an agent merely to populate a sidebar.
async function readDshWorkspaceCatalog(ctx, { offset = 0, limit = 80 } = {}, { isPrivateSession = () => false } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error('会话分页无效');
  const excluded = (id, row) => isPrivateSession(id, row) || isPrivateSession(id, ctx.agents.get(id)?.session);
  const records = (await ctx.sessionQuery.listSessions()).filter(row => row?.header?.id && !row.header.parentSession && !excluded(String(row.header.id), row));
  const page = records.slice(offset, offset + limit), sessions = new Array(page.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, page.length) }, async () => {
    while (cursor < page.length) {
      const index = cursor++, header = page[index].header;
      let title = '', updatedAt = Number(header.createdAt) || 0, observation;
      try {
        observation = await ctx.sessionQuery.observeSession(String(header.id));
        if (excluded(String(header.id), observation)) continue;
        title = String(observation.projections?.values?.title || '');
        const last = observation.events?.at(-1);
        updatedAt = Number(last?.timestamp || last?.createdAt) || updatedAt;
      } catch { /* Keep an unavailable record visible rather than inventing text. */ }
      finally { observation?.[Symbol.dispose]?.(); }
      if (excluded(String(header.id), observation)) continue;
      sessions[index] = { id: String(header.id), provider: 'dsh', title: title.slice(0, 160) || 'DSH 会话 ' + String(header.id).slice(0, 8),
        cwd: typeof header.cwd === 'string' ? header.cwd.slice(0, 4096) : '', updatedAt, status: ctx.agents.get(String(header.id))?.status === 'running' ? 'active' : 'idle' };
    }
  }));
  // Ownership can be learned after an earlier worker finishes. Recheck the
  // current header, live agent and remembered privacy before crossing the bridge.
  const publicSessions = sessions.filter((row, index) => row && !excluded(row.id, page[index]));
  const end = offset + page.length;
  const nextOffset = end < records.length
    ? records.slice(0, end).filter(row => !excluded(String(row.header.id), row)).length : null;
  return { sessions: publicSessions, nextOffset, status: 'ready' };
}

async function checkDshWorkspaceSession(ctx, id, { isPrivateSession } = {}) {
  if (typeof id !== 'string' || !id || id.length > 240 || typeof isPrivateSession !== 'function') throw Error('工作会话不可用');
  const excluded = row => isPrivateSession(id, row) || isPrivateSession(id, ctx.agents.get(id)?.session);
  const row = (await ctx.sessionQuery.listSessions()).find(row => String(row?.header?.id) === id);
  if (!row || row.header.parentSession || excluded(row)) throw Error('工作会话不可用');
  let observation;
  try {
    observation = await ctx.sessionQuery.observeSession(id);
    if (!observation || observation.header?.parentSession || excluded(observation)) throw Error('工作会话不可用');
    return { allowed: true };
  } finally { observation?.[Symbol.dispose]?.(); }
}

// Revalidate only IDs already held by the host. No titles or private IDs are
// exported, and checking cached pages never resumes or observes an agent.
async function publicDshWorkspaceSessionIds(ctx, ids, { isPrivateSession } = {}) {
  if (!Array.isArray(ids) || ids.length > 100100 || ids.some(id => typeof id !== 'string' || !id || id.length > 240)
      || typeof isPrivateSession !== 'function') throw Error('工作会话检查无效');
  if (!ids.length) return [];
  const requested = new Set(ids);
  const records = await ctx.sessionQuery.listSessions();
  return records.filter(row => {
    const id = String(row?.header?.id || '');
    return requested.has(id) && !row.header.parentSession
      && !isPrivateSession(id, row) && !isPrivateSession(id, ctx.agents.get(id)?.session);
  }).map(row => String(row.header.id));
}
module.exports = { readDshWorkspaceCatalog, checkDshWorkspaceSession, publicDshWorkspaceSessionIds };
