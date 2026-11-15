import { getDb } from '../../../../db/index';
import { entries } from '../../../../db/schema';
import { and, eq } from 'drizzle-orm';
import { getChatGPTUser } from '../../../chatgpt-auth';
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: '请先登录。' }, { status: 401 });
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: '请求来源不正确。' }, { status: 403 });
  const { id } = await context.params;
  try {
    const result = await getDb().delete(entries).where(and(eq(entries.id, id), eq(entries.authorId, user.userId))).returning({ id: entries.id });
    if (!result.length) return Response.json({ error: '作品不存在，或你没有删除权限。' }, { status: 404 });
    return Response.json({ deleted: true });
  } catch { return Response.json({ error: '删除失败，请稍后重试。' }, { status: 503 }); }
}
