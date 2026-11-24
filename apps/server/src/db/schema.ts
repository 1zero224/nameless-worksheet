import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();

export const roleEnum = pgEnum('role', ['admin', 'user']);

export const projects = pgTable('projects', {
  id: id(),
  name: text('name').notNull(),
  realtimePrunedThrough: bigint('realtime_pruned_through', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  createdAt: createdAt(),
});

export const users = pgTable('users', {
  id: id(),
  loginName: text('login_name').notNull().unique('users_login_name_key'),
  displayName: text('display_name').notNull().unique('users_display_name_key'),
  passwordHash: text('password_hash'),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const memberships = pgTable(
  'memberships',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: roleEnum('role').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    // 首版一个用户只属于一个项目
    uniqueIndex('memberships_user_id_key').on(t.userId),
  ],
);

export const invites = pgTable(
  'invites',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    tokenHash: text('token_hash').notNull().unique('invites_token_hash_key'),
    role: roleEnum('role').notNull(),
    expiresAt: ts('expires_at').notNull(),
    maxUses: integer('max_uses').notNull(),
    usedCount: integer('used_count').notNull().default(0),
    revokedAt: ts('revoked_at'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('invites_project_id_idx').on(t.projectId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    tokenHash: text('token_hash').notNull().unique('sessions_token_hash_key'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_expires_at_idx').on(t.expiresAt),
  ],
);

export const passwordResets = pgTable(
  'password_resets',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull().unique('password_resets_token_hash_key'),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('password_resets_user_id_idx').on(t.userId)],
);

export const realtimeEvents = pgTable(
  'realtime_events',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    scopeType: text('scope_type').notNull(),
    scopeId: uuid('scope_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    actorUserId: uuid('actor_user_id'),
    originConnId: text('origin_conn_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('realtime_events_scope_idx').on(t.projectId, t.scopeType, t.scopeId, t.id),
    index('realtime_events_created_at_idx').on(t.createdAt),
  ],
);
