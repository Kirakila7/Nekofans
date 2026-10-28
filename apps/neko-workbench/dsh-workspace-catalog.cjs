'use strict';
// Read the native logical corpus. Never parse another profile's files or
// create/resume an agent merely to populate a sidebar.
async function readDshWorkspaceCatalog(ctx, { offset = 0, limit = 80 } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error('会话分页无效');
  const records = (await ctx.sessionQuery.listSessions()).filter(row => row?.header?.id && !row.header.parentSession);
  const page = records.slice(offset, offset + limit), sessions = new Array(page.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, page.length) }, async () => {
    while (cursor < page.length) {
      const index = cursor++, header = page[index].header;
      let title = '', updatedAt = Number(header.createdAt) || 0, observation;
      try {
        observation = await ctx.sessionQuery.observeSession(String(header.id));
        title = String(observation.projections?.values?.title || '');
        const last = observation.events?.at(-1);
        updatedAt = Number(last?.timestamp || last?.createdAt) || updatedAt;
      } catch { /* Keep an unavailable record visible rather than inventing text. */ }
      finally { observation?.[Symbol.dispose]?.(); }
      sessions[index] = { id: String(header.id), provider: 'dsh', title: title.slice(0, 160) || 'DSH 会话 ' + String(header.id).slice(0, 8),
        cwd: typeof header.cwd === 'string' ? header.cwd.slice(0, 4096) : '', updatedAt, status: ctx.agents.get(String(header.id))?.status === 'running' ? 'active' : 'idle' };
    }
  }));
  return { sessions, nextOffset: offset + limit < records.length ? offset + limit : null, status: 'ready' };
}
module.exports = { readDshWorkspaceCatalog };
