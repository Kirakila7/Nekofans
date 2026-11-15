import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
export const entries = sqliteTable('entries', {
  id: text('id').primaryKey(), authorId: text('author_id').notNull(), creator: text('creator').notNull(),
  kind: text('kind').notNull(), title: text('title').notNull(), summary: text('summary').notNull(),
  body: text('body').notNull(), category: text('category').notNull(), tags: text('tags').notNull(),
  stage: text('stage').notNull(), url: text('url'), createdAt: integer('created_at').notNull(),
}, t => [index('entries_created_idx').on(t.createdAt), index('entries_author_idx').on(t.authorId)]);
