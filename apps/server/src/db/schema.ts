import type { Assignee, SystemColumnsConfig } from '@nw/shared';
import { isNotNull, isNull, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
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
export const publishStatusEnum = pgEnum('publish_status', ['unpublished', 'published', 'shelved']);
export const worksheetKindEnum = pgEnum('worksheet_kind', ['task', 'free']);
export const worksheetPlacementEnum = pgEnum('worksheet_placement', ['topbar', 'docs']);
export const stageStatusEnum = pgEnum('stage_status', ['not_started', 'in_progress', 'done', 'na']);
export const locationTypeEnum = pgEnum('location_type', ['cloud_link', 'r2']);
export const uploadSessionModeEnum = pgEnum('upload_session_mode', [
  'create_artifact',
  'create_version',
  'attach_version',
]);
export const uploadSessionStatusEnum = pgEnum('upload_session_status', [
  'uploading',
  'completed',
  'aborted',
  'expired',
]);
export const cloudProviderEnum = pgEnum('cloud_provider', [
  'baidu',
  'aliyun',
  'quark',
  'tianyi',
  '115',
  'gdrive',
  'mega',
  'onedrive',
  'other',
]);

export const projects = pgTable('projects', {
  id: id(),
  name: text('name').notNull(),
  realtimePrunedThrough: bigint('realtime_pruned_through', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  createdAt: createdAt(),
});

export const users = pgTable(
  'users',
  {
    id: id(),
    loginName: text('login_name').unique('users_login_name_key'),
    displayName: text('display_name').notNull().unique('users_display_name_key'),
    passwordHash: text('password_hash'),
    claimedAt: ts('claimed_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'users_claim_consistency_check',
      sql`((${t.claimedAt} IS NULL AND ${t.loginName} IS NULL AND ${t.passwordHash} IS NULL) OR (${t.loginName} IS NOT NULL))`,
    ),
  ],
);

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
    kind: worksheetKindEnum('kind').notNull().default('task'),
    placement: worksheetPlacementEnum('placement').notNull().default('topbar'),
    sortOrder: text('sort_order').notNull(),
    systemColumns: jsonb('system_columns')
      .$type<SystemColumnsConfig>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    importSourceKey: text('import_source_key'),
    deletedAt: ts('deleted_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('worksheets_docs_free_check', sql`${t.placement} != 'docs' OR ${t.kind} = 'free'`),
    uniqueIndex('worksheets_project_name_active_key')
      .on(t.projectId, t.name)
      .where(isNull(t.deletedAt)),
    uniqueIndex('worksheets_project_import_source_active_key')
      .on(t.projectId, t.importSourceKey)
      .where(sql`${isNotNull(t.importSourceKey)} AND ${isNull(t.deletedAt)}`),
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

// ---- 阶段 5 新增表（账号认领链接、迁移批次） ----

export const accountClaims = pgTable(
  'account_claims',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull().unique('account_claims_token_hash_key'),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    revokedAt: ts('revoked_at'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('account_claims_project_user_created_idx').on(t.projectId, t.userId, t.createdAt.desc()),
  ],
);

export const importBatches = pgTable(
  'import_batches',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    sourceFilename: text('source_filename').notNull(),
    sourceSha256: text('source_sha256').notNull(),
    backupR2Key: text('backup_r2_key').notNull(),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('import_batches_project_created_idx').on(t.projectId, t.createdAt.desc()),
    index('import_batches_project_sha256_idx').on(t.projectId, t.sourceSha256),
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
    importBatchId: uuid('import_batch_id').references(() => importBatches.id),
    importSourceKey: text('import_source_key'),
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
    uniqueIndex('tasks_project_import_source_active_key')
      .on(t.projectId, t.importSourceKey)
      .where(sql`${isNotNull(t.importSourceKey)} AND ${isNull(t.deletedAt)}`),
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
    artifactId: uuid('artifact_id').references(() => artifacts.id),
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
    index('change_logs_project_docs_created_idx')
      .on(t.projectId, t.createdAt.desc(), t.id.desc())
      .where(sql`${isNull(t.worksheetId)} AND ${isNotNull(t.artifactId)}`),
  ],
);

// ---- 阶段 3 新增表（四级资源、版本历史、网盘入口） ----

export const artifacts = pgTable(
  'artifacts',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    worksheetId: uuid('worksheet_id').references(() => worksheets.id),
    workId: uuid('work_id').references(() => works.id),
    taskId: uuid('task_id').references(() => tasks.id),
    stageColumnId: uuid('stage_column_id').references(() => columnConfigs.id),
    name: text('name').notNull(),
    latestVersionId: uuid('latest_version_id'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    importBatchId: uuid('import_batch_id').references(() => importBatches.id),
    importSourceKey: text('import_source_key'),
    deletedAt: ts('deleted_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'artifacts_scope_check',
      sql`(
        (${t.worksheetId} IS NULL AND ${t.workId} IS NULL AND ${t.taskId} IS NULL AND ${t.stageColumnId} IS NULL)
        OR
        (${t.worksheetId} IS NOT NULL AND ${t.workId} IS NOT NULL AND ${t.taskId} IS NULL AND ${t.stageColumnId} IS NULL)
        OR
        (${t.worksheetId} IS NOT NULL AND ${t.workId} IS NULL AND ${t.taskId} IS NOT NULL AND ${t.stageColumnId} IS NULL)
        OR
        (${t.worksheetId} IS NOT NULL AND ${t.workId} IS NULL AND ${t.taskId} IS NOT NULL AND ${t.stageColumnId} IS NOT NULL)
      )`,
    ),
    uniqueIndex('artifacts_project_import_source_active_key')
      .on(t.projectId, t.importSourceKey)
      .where(sql`${isNotNull(t.importSourceKey)} AND ${isNull(t.deletedAt)}`),
    index('artifacts_project_docs_active_idx')
      .on(t.projectId, t.updatedAt.desc())
      .where(sql`${isNull(t.worksheetId)} AND ${isNull(t.deletedAt)}`),
    index('artifacts_project_ws_active_idx')
      .on(t.projectId, t.worksheetId)
      .where(sql`${isNotNull(t.worksheetId)} AND ${isNull(t.deletedAt)}`),
    index('artifacts_project_work_active_idx')
      .on(t.projectId, t.workId)
      .where(sql`${isNotNull(t.workId)} AND ${isNull(t.deletedAt)}`),
    index('artifacts_project_task_active_idx')
      .on(t.projectId, t.taskId)
      .where(sql`${isNotNull(t.taskId)} AND ${isNull(t.deletedAt)}`),
    index('artifacts_project_stage_col_active_idx')
      .on(t.projectId, t.stageColumnId)
      .where(sql`${isNotNull(t.stageColumnId)} AND ${isNull(t.deletedAt)}`),
  ],
);

export const artifactVersions = pgTable(
  'artifact_versions',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id),
    versionNumber: integer('version_number').notNull(),
    note: text('note').notNull().default(''),
    originalFilename: text('original_filename'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    mimeType: text('mime_type'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    deletedAt: ts('deleted_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('artifact_versions_artifact_num_key').on(t.artifactId, t.versionNumber),
    index('artifact_versions_project_artifact_active_idx')
      .on(t.projectId, t.artifactId, t.versionNumber.desc())
      .where(isNull(t.deletedAt)),
  ],
);

export const blobs = pgTable(
  'blobs',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    r2Key: text('r2_key').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    mimeType: text('mime_type').notNull(),
    sha256: text('sha256'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('blobs_r2_key_key').on(t.r2Key),
    index('blobs_project_created_idx').on(t.projectId, t.createdAt.desc()),
  ],
);

export const resourceLocations = pgTable(
  'resource_locations',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id),
    versionId: uuid('version_id')
      .notNull()
      .references(() => artifactVersions.id),
    type: locationTypeEnum('type').notNull().default('cloud_link'),
    blobId: uuid('blob_id').references(() => blobs.id),
    provider: cloudProviderEnum('provider'),
    url: text('url'),
    extractCode: text('extract_code'),
    isFolder: boolean('is_folder').notNull().default(false),
    expiresAt: text('expires_at'),
    note: text('note').notNull().default(''),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    deletedAt: ts('deleted_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'resource_locations_type_check',
      sql`(
        (${t.type} = 'cloud_link' AND ${t.provider} IS NOT NULL AND ${t.url} IS NOT NULL AND ${t.blobId} IS NULL)
        OR
        (${t.type} = 'r2' AND ${t.blobId} IS NOT NULL AND ${t.url} IS NULL AND ${t.extractCode} IS NULL)
      )`,
    ),
    uniqueIndex('resource_locations_version_r2_active_key')
      .on(t.versionId)
      .where(sql`${t.type} = 'r2' AND ${isNull(t.deletedAt)}`),
    index('resource_locations_project_version_active_idx')
      .on(t.projectId, t.versionId, t.createdAt.asc())
      .where(isNull(t.deletedAt)),
    index('resource_locations_project_artifact_active_idx')
      .on(t.projectId, t.artifactId)
      .where(isNull(t.deletedAt)),
  ],
);

// ---- 阶段 4 新增表（上传会话） ----

export const uploadSessions = pgTable(
  'upload_sessions',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    mode: uploadSessionModeEnum('mode').notNull(),
    scopeKind: text('scope_kind'),
    worksheetId: uuid('worksheet_id').references(() => worksheets.id),
    workId: uuid('work_id').references(() => works.id),
    taskId: uuid('task_id').references(() => tasks.id),
    stageColumnId: uuid('stage_column_id').references(() => columnConfigs.id),
    artifactId: uuid('artifact_id').references(() => artifacts.id),
    versionId: uuid('version_id').references(() => artifactVersions.id),
    artifactName: text('artifact_name'),
    versionNote: text('version_note').notNull().default(''),
    originalFilename: text('original_filename').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    mimeType: text('mime_type').notNull(),
    isMultipart: boolean('is_multipart').notNull(),
    partSizeBytes: integer('part_size_bytes'),
    r2Key: text('r2_key').notNull(),
    r2UploadId: text('r2_upload_id'),
    fingerprintSha256: text('fingerprint_sha256'),
    idempotencyKey: text('idempotency_key').notNull(),
    status: uploadSessionStatusEnum('status').notNull().default('uploading'),
    resultBlobId: uuid('result_blob_id').references(() => blobs.id),
    resultArtifactId: uuid('result_artifact_id').references(() => artifacts.id),
    resultVersionId: uuid('result_version_id').references(() => artifactVersions.id),
    resultLocationId: uuid('result_location_id').references(() => resourceLocations.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    expiresAt: ts('expires_at').notNull(),
    completedAt: ts('completed_at'),
    abortedAt: ts('aborted_at'),
    cleanedUpAt: ts('cleaned_up_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('upload_sessions_project_idempotency_key').on(t.projectId, t.idempotencyKey),
    uniqueIndex('upload_sessions_r2_key_key').on(t.r2Key),
    index('upload_sessions_resume_lookup_idx')
      .on(t.projectId, t.createdBy, t.fingerprintSha256, t.sizeBytes)
      .where(sql`${t.status} = 'uploading' AND ${isNotNull(t.fingerprintSha256)}`),
    index('upload_sessions_cleanup_idx').on(t.status, t.expiresAt).where(isNull(t.cleanedUpAt)),
  ],
);
