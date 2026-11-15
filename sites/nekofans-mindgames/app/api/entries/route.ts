import { getDb } from '../../../db/index';
import { entries } from '../../../db/schema';
import { desc } from 'drizzle-orm';
import { curated, categories, type Entry } from '../../catalog';
import { getChatGPTUser } from '../../chatgpt-auth';
export const dynamic = 'force-dynamic';
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET() {
  const user = await getChatGPTUser();
  try {
    const rows = await getDb().select().from(entries).orderBy(desc(entries.createdAt)).limit(200);
    const published: Entry[] = rows.map(row => ({
      id: row.id, creator: row.creator, kind: row.kind as Entry['kind'], title: row.title,
      summary: row.summary, body: row.body, category: row.category, tags: JSON.parse(row.tags),
      stage: row.stage as Entry['stage'], url: row.url, createdAt: row.createdAt,
      isOwner: !!user && row.authorId === user.userId,
    }));
    return reply({ entries: [...curated, ...published], signedIn: !!user, displayName: user?.fullName || '', canPublish: true });
  } catch {
    return reply({ entries: curated, signedIn: !!user, displayName: user?.fullName || '', canPublish: false, error: '投稿服务暂时不可用，请稍后再试。' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return reply({ error: '请先登录，再发布你的创作。' }, 401);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return reply({ error: '请求来源不正确。' }, 403);
  let data: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 14000) return reply({ error: '投稿内容过长。' }, 400);
    data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
  } catch { return reply({ error: '请检查投稿内容。' }, 400); }
  const str = (key: string) => typeof data[key] === 'string' ? (data[key] as string).trim() : '';
  const kind = str('kind'), title = str('title'), summary = str('summary'), body = str('body');
  const creator = str('creator'), category = str('category');
  const stage = kind === 'rule' ? 'concept' : str('stage');
  const tags = Array.isArray(data.tags) ? data.tags.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean) : [];
  if (!['game', 'rule'].includes(kind) || title.length < 2 || title.length > 60 || summary.length < 8 || summary.length > 180 || body.length < 15 || body.length > 2000 || creator.length < 1 || creator.length > 30 || !categories.includes(category) || !['concept', 'prototype', 'playable'].includes(stage) || tags.length > 3 || tags.some(x => x.length > 12)) {
    return reply({ error: '请补全标题、简介、玩法详情和署名，并检查字数。' }, 400);
  }
  if (creator.toLowerCase() === 'a.kira') {
    return reply({ error: 'A.kira 为《开源与抹除》首发创作者精选署名，请使用你自己的原创作者名。' }, 400);
  }
  let url = str('url');
  if (url) {
    try { const parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error(); url = parsed.href; }
    catch { return reply({ error: '游戏链接需要是有效的 HTTPS 地址。' }, 400); }
  }
  if (stage === 'playable' && !url) return reply({ error: '可游玩的游戏需要提供游戏链接。' }, 400);
  const id = crypto.randomUUID();
  try {
    await getDb().insert(entries).values({ id, authorId: user.userId, creator, kind, title, summary, body, category, tags: JSON.stringify(tags), stage, url: url || null, createdAt: Date.now() });
    return reply({ id, saved: true }, 201);
  } catch { return reply({ error: '保存失败，内容仍保留在表单里，请稍后重试。' }, 503); }
}
