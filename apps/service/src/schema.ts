import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const townState = sqliteTable('town_state', {
  id: text('id').primaryKey(),
  cursor: integer('cursor').notNull(),
  data: text('data').notNull(),
});
export const events = sqliteTable('events', {
  cursor: integer('cursor').primaryKey({ autoIncrement: true }),
  sourceId: text('source_id').notNull().unique(),
  fingerprint: text('fingerprint').notNull(),
  type: text('type').notNull(),
  occurredAt: text('occurred_at').notNull(),
  data: text('data').notNull(),
});
export const eventBaseline = sqliteTable('event_baseline', {
  id: text('id').primaryKey(), cursor: integer('cursor').notNull(), data: text('data').notNull(),
});
export const commandReceipts = sqliteTable('command_receipts', {
  sourceId: text('source_id').primaryKey(), fingerprint: text('fingerprint').notNull(), cursor: integer('cursor').notNull(),
  createdAt: text('created_at').notNull(), pinned: integer('pinned').notNull().default(0),
});
