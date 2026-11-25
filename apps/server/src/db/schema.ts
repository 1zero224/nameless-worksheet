import type { Assignee, SystemColumnsConfig } from '@nw/shared';
import { isNotNull, isNull, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
export const columnTypeEnum = pgEnum('column_type', ['stage', 'text', 'date', 'link']);
export const priorityEnum = pgEnum('priority', ['normal', 'high', 'urgent']);
export const publishStatusEnum = pgEnum('publish_status', ['unpublished', 'published']);
export const stageStatusEnum = pgEnum('stage_status', ['not_started', 'in_progress', 'done', 'na']);

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

// ---- 阶段 2 新增表 ----

export const boardColumns = pgTable(
  'board_columns',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    sortOrder: text('sort_order').notNull(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('board_columns_project_name_key').on(t.projectId, t.name),
    index('board_columns_project_order_idx').on(t.projectId, t.sortOrder),
  ],
);

export const worksheets = pgTable(
  'worksheets',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    color: text('color').notNull().default('sky'),
    sortOrder: text('sort_order').notNull(),
    systemColumns: jsonb('system_columns')
      .$type<SystemColumnsConfig>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    deletedAt: ts('deleted_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('worksheets_project_name_active_key')
      .on(t.projectId, t.name)
      .where(isNull(t.deletedAt)),
    index('worksheets_project_order_active_idx')
      .on(t.projectId, t.sortOrder)
      .where(isNull(t.deletedAt)),
  ],
);

export const columnConfigs = pgTable(
  'column_configs',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    worksheetId: uuid('worksheet_id')
      .notNull()
      .references(() => worksheets.id),
    name: text('name').notNull(),
    type: columnTypeEnum('type').notNull(),
    sortOrder: text('sort_order').notNull(),
    width: integer('width').notNull().default(160),
    hidden: boolean('hidden').notNull().default(false),
    boardColumnId: uuid('board_column_id').references(() => boardColumns.id, {
      onDelete: 'set null',
    }),
    deletedAt: ts('deleted_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('column_configs_worksheet_name_active_key')
      .on(t.worksheetId, t.name)
      .where(isNull(t.deletedAt)),
    uniqueIndex('column_configs_worksheet_board_col_active_key')
      .on(t.worksheetId, t.boardColumnId)
      .where(sql`${isNotNull(t.boardColumnId)} AND ${isNull(t.deletedAt)}`),
    index('column_configs_project_ws_order_idx').on(t.projectId, t.worksheetId, t.sortOrder),
  ],
);

export const works = pgTable(
  'works',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    worksheetId: uuid('worksheet_id')
      .notNull()
      .references(() => worksheets.id),
    name: text('name').notNull(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('works_worksheet_name_key').on(t.worksheetId, t.name),
    index('works_project_ws_idx').on(t.projectId, t.worksheetId),
  ],
);

export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    worksheetId: uuid('worksheet_id')
      .notNull()
      .references(() => worksheets.id),
    workId: uuid('work_id').references(() => works.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    divisionNote: text('division_note').notNull().default(''),
    priority: priorityEnum('priority').notNull().default('normal'),
    publishStatus: publishStatusEnum('publish_status').notNull().default('unpublished'),
    publishedAt: text('published_at'),
    publishUrl: text('publish_url'),
    customValues: jsonb('custom_values')
      .$type<Record<string, string | null>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    sortOrder: text('sort_order').notNull(),
    revision: integer('revision').notNull().default(1),
    deletedAt: ts('deleted_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('tasks_project_ws_order_active_idx')
      .on(t.projectId, t.worksheetId, t.sortOrder)
      .where(isNull(t.deletedAt)),
    index('tasks_project_publish_active_idx')
      .on(t.projectId, t.publishStatus)
      .where(isNull(t.deletedAt)),
    index('tasks_project_work_active_idx').on(t.projectId, t.workId).where(isNull(t.deletedAt)),
  ],
);

export const stageCells = pgTable(
  'stage_cells',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    worksheetId: uuid('worksheet_id')
      .notNull()
      .references(() => worksheets.id),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    columnId: uuid('column_id')
      .notNull()
      .references(() => columnConfigs.id),
    assignees: jsonb('assignees').$type<Assignee[]>().notNull().default(sql`'[]'::jsonb`),
    status: stageStatusEnum('status').notNull().default('not_started'),
    note: text('note').notNull().default(''),
    revision: integer('revision').notNull().default(1),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('stage_cells_task_column_key').on(t.taskId, t.columnId),
    index('stage_cells_project_ws_idx').on(t.projectId, t.worksheetId),
    index('stage_cells_project_status_idx').on(t.projectId, t.status),
  ],
);

export const changeLogs = pgTable(
  'change_logs',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    worksheetId: uuid('worksheet_id').references(() => worksheets.id),
    taskId: uuid('task_id').references(() => tasks.id),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id),
    action: text('action').notNull(),
    summary: text('summary').notNull(),
    changes: jsonb('changes').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('change_logs_project_ws_created_idx').on(
      t.projectId,
      t.worksheetId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index('change_logs_project_task_created_idx').on(
      t.projectId,
      t.taskId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
  ],
);
