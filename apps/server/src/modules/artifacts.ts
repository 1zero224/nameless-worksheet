import {
  type ArtifactChangedPayload,
  type ArtifactDetail,
  type ArtifactScope,
  type ArtifactScopeKind,
  type ArtifactVersionDetail,
  createArtifactBodySchema,
  createArtifactVersionBodySchema,
  createResourceLocationBodySchema,
  type DeleteArtifactVersionResponse,
  detectCloudProvider,
  normalizeText,
  type ResourceLocation,
  type StageBadgeSummary,
  type TaskArtifactsResponse,
  updateArtifactBodySchema,
  updateResourceLocationBodySchema,
  type WorkArtifactsResponse,
  type WorkCapsuleSummary,
  type WorksheetArtifactSummary,
} from '@nw/shared';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Db, type Queryable, schema, type Tx } from '../db/index.js';
import { type TxContext, withTx } from '../db/tx.js';
import { AppError, notFound } from '../errors.js';
import type { EventBus } from '../realtime/bus.js';
import { findActiveWorksheet, recordChangeLog } from './change-logs.js';
import { parseBody, parseUuidParam, readOriginConnId } from './helpers.js';
import { toWorkDto } from './worksheets.js';

export function deriveScopeKind(row: {
  worksheetId: string | null;
  workId: string | null;
  taskId: string | null;
  stageColumnId: string | null;
}): ArtifactScopeKind {
  if (row.stageColumnId !== null) return 'stage';
  if (row.taskId !== null) return 'task';
  if (row.workId !== null) return 'work';
  return 'doc';
}

interface ResolvedScope {
  scopeKind: ArtifactScopeKind;
  worksheetId: string | null;
  workId: string | null;
  taskId: string | null;
  stageColumnId: string | null;
  label: string;
}

async function resolveAndValidateScope(
  db: Queryable,
  projectId: string,
  scope: ArtifactScope,
): Promise<ResolvedScope> {
  if (scope.kind === 'doc') {
    return {
      scopeKind: 'doc',
      worksheetId: null,
      workId: null,
      taskId: null,
      stageColumnId: null,
      label: '通用文档',
    };
  }

  if (scope.kind === 'work') {
    const [work] = await db
      .select({
        id: schema.works.id,
        worksheetId: schema.works.worksheetId,
        name: schema.works.name,
      })
      .from(schema.works)
      .innerJoin(schema.worksheets, eq(schema.works.worksheetId, schema.worksheets.id))
      .where(
        and(
          eq(schema.works.projectId, projectId),
          eq(schema.works.id, scope.workId),
          eq(schema.worksheets.projectId, projectId),
          isNull(schema.worksheets.deletedAt),
        ),
      )
      .limit(1);
    if (!work) throw notFound();
    return {
      scopeKind: 'work',
      worksheetId: work.worksheetId,
      workId: work.id,
      taskId: null,
      stageColumnId: null,
      label: `作品「${work.name}」`,
    };
  }

  const [task] = await db
    .select({
      id: schema.tasks.id,
      worksheetId: schema.tasks.worksheetId,
      title: schema.tasks.title,
    })
    .from(schema.tasks)
    .innerJoin(schema.worksheets, eq(schema.tasks.worksheetId, schema.worksheets.id))
    .where(
      and(
        eq(schema.tasks.projectId, projectId),
        eq(schema.tasks.id, scope.taskId),
        isNull(schema.tasks.deletedAt),
        eq(schema.worksheets.projectId, projectId),
        isNull(schema.worksheets.deletedAt),
      ),
    )
    .limit(1);
  if (!task) throw notFound();

  if (scope.kind === 'task') {
    return {
      scopeKind: 'task',
      worksheetId: task.worksheetId,
      workId: null,
      taskId: task.id,
      stageColumnId: null,
      label: `任务「${task.title}」`,
    };
  }

  const [stageCol] = await db
    .select({ id: schema.columnConfigs.id, name: schema.columnConfigs.name })
    .from(schema.columnConfigs)
    .where(
      and(
        eq(schema.columnConfigs.projectId, projectId),
        eq(schema.columnConfigs.worksheetId, task.worksheetId),
        eq(schema.columnConfigs.id, scope.stageColumnId),
        eq(schema.columnConfigs.type, 'stage'),
        isNull(schema.columnConfigs.deletedAt),
      ),
    )
    .limit(1);
  if (!stageCol) throw notFound();

  return {
    scopeKind: 'stage',
    worksheetId: task.worksheetId,
    workId: null,
    taskId: task.id,
    stageColumnId: stageCol.id,
    label: `任务「${task.title}」的「${stageCol.name}」工序`,
  };
}

async function describeCurrentScope(
  db: Queryable,
  projectId: string,
  row: {
    worksheetId: string | null;
    workId: string | null;
    taskId: string | null;
    stageColumnId: string | null;
  },
): Promise<string> {
  const kind = deriveScopeKind(row);
  if (kind === 'doc') return '通用文档';
  if (kind === 'work' && row.workId) {
    const [w] = await db
      .select({ name: schema.works.name })
      .from(schema.works)
      .where(and(eq(schema.works.projectId, projectId), eq(schema.works.id, row.workId)))
      .limit(1);
    return w ? `作品「${w.name}」` : '作品共用';
  }
  if (row.taskId) {
    const [t] = await db
      .select({ title: schema.tasks.title })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.projectId, projectId), eq(schema.tasks.id, row.taskId)))
      .limit(1);
    const tLabel = t ? `任务「${t.title}」` : '任务';
    if (kind === 'stage' && row.stageColumnId) {
      const [c] = await db
        .select({ name: schema.columnConfigs.name })
        .from(schema.columnConfigs)
        .where(
          and(
            eq(schema.columnConfigs.projectId, projectId),
            eq(schema.columnConfigs.id, row.stageColumnId),
          ),
        )
        .limit(1);
      return c ? `${tLabel}的「${c.name}」工序` : `${tLabel}工序`;
    }
    return tLabel;
  }
  return '通用文档';
}

async function ensureArtifactParentActive(
  db: Queryable,
  projectId: string,
  artifact: { worksheetId: string | null; taskId: string | null },
  forRestore = false,
): Promise<void> {
  if (artifact.worksheetId) {
    const ws = await findActiveWorksheet(db, projectId, artifact.worksheetId);
    if (!ws) {
      if (forRestore) {
        throw new AppError('CONFLICT', '所属工作表已删除，请先恢复它');
      }
      throw notFound();
    }
  }
  if (artifact.taskId) {
    const [t] = await db
      .select({ id: schema.tasks.id, deletedAt: schema.tasks.deletedAt })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.projectId, projectId), eq(schema.tasks.id, artifact.taskId)))
      .limit(1);
    if (!t || t.deletedAt !== null) {
      if (forRestore) {
        throw new AppError('CONFLICT', '所属任务已删除，请先恢复它');
      }
      throw notFound();
    }
  }
}

async function loadUserDisplayNames(
  db: Queryable,
  userIds: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: schema.users.id, displayName: schema.users.displayName })
    .from(schema.users)
    .where(inArray(schema.users.id, unique));
  return new Map(rows.map((r) => [r.id, r.displayName]));
}

function toLocationDto(
  row: typeof schema.resourceLocations.$inferSelect,
  userMap: Map<string, string>,
): ResourceLocation {
  return {
    id: row.id,
    artifactId: row.artifactId,
    versionId: row.versionId,
    type: row.type,
    provider: row.provider,
    url: row.url,
    extractCode: row.extractCode,
    isFolder: row.isFolder,
    expiresAt: row.expiresAt,
    note: row.note,
    createdBy: { id: row.createdBy, displayName: userMap.get(row.createdBy) ?? '未知用户' },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toVersionDto(
  row: typeof schema.artifactVersions.$inferSelect,
  locations: ResourceLocation[],
  userMap: Map<string, string>,
): ArtifactVersionDetail {
  return {
    id: row.id,
    artifactId: row.artifactId,
    versionNumber: row.versionNumber,
    note: row.note,
    originalFilename: row.originalFilename,
    sizeBytes: row.sizeBytes,
    mimeType: row.mimeType,
    createdBy: { id: row.createdBy, displayName: userMap.get(row.createdBy) ?? '未知用户' },
    createdAt: row.createdAt.toISOString(),
    locations,
  };
}

export async function hydrateArtifacts(
  db: Queryable,
  projectId: string,
  artifactRows: Array<typeof schema.artifacts.$inferSelect>,
): Promise<ArtifactDetail[]> {
  if (artifactRows.length === 0) return [];
  const artifactIds = artifactRows.map((a) => a.id);

  const [versionRows, locationRows] = await Promise.all([
    db
      .select()
      .from(schema.artifactVersions)
      .where(
        and(
          eq(schema.artifactVersions.projectId, projectId),
          inArray(schema.artifactVersions.artifactId, artifactIds),
          isNull(schema.artifactVersions.deletedAt),
        ),
      )
      .orderBy(desc(schema.artifactVersions.versionNumber)),
    db
      .select()
      .from(schema.resourceLocations)
      .where(
        and(
          eq(schema.resourceLocations.projectId, projectId),
          inArray(schema.resourceLocations.artifactId, artifactIds),
          isNull(schema.resourceLocations.deletedAt),
        ),
      )
      .orderBy(asc(schema.resourceLocations.createdAt), asc(schema.resourceLocations.id)),
  ]);

  const userIds: string[] = [];
  for (const a of artifactRows) userIds.push(a.createdBy);
  for (const v of versionRows) userIds.push(v.createdBy);
  for (const l of locationRows) userIds.push(l.createdBy);
  const userMap = await loadUserDisplayNames(db, userIds);

  const locsByVersion = new Map<string, ResourceLocation[]>();
  for (const l of locationRows) {
    let arr = locsByVersion.get(l.versionId);
    if (!arr) {
      arr = [];
      locsByVersion.set(l.versionId, arr);
    }
    arr.push(toLocationDto(l, userMap));
  }

  const versionsByArtifact = new Map<string, ArtifactVersionDetail[]>();
  for (const v of versionRows) {
    let arr = versionsByArtifact.get(v.artifactId);
    if (!arr) {
      arr = [];
      versionsByArtifact.set(v.artifactId, arr);
    }
    arr.push(toVersionDto(v, locsByVersion.get(v.id) ?? [], userMap));
  }

  return artifactRows.map((a) => {
    const versions = versionsByArtifact.get(a.id) ?? [];
    const latestVersion =
      (a.latestVersionId ? versions.find((v) => v.id === a.latestVersionId) : null) ??
      versions[0] ??
      null;
    return {
      id: a.id,
      scopeKind: deriveScopeKind(a),
      worksheetId: a.worksheetId,
      workId: a.workId,
      taskId: a.taskId,
      stageColumnId: a.stageColumnId,
      name: a.name,
      latestVersionId: latestVersion?.id ?? null,
      latestVersion,
      versions,
      createdBy: { id: a.createdBy, displayName: userMap.get(a.createdBy) ?? '未知用户' },
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    };
  });
}

async function hydrateSingleVersion(
  db: Queryable,
  projectId: string,
  versionRow: typeof schema.artifactVersions.$inferSelect,
): Promise<ArtifactVersionDetail> {
  const locRows = await db
    .select()
    .from(schema.resourceLocations)
    .where(
      and(
        eq(schema.resourceLocations.projectId, projectId),
        eq(schema.resourceLocations.versionId, versionRow.id),
        isNull(schema.resourceLocations.deletedAt),
      ),
    )
    .orderBy(asc(schema.resourceLocations.createdAt), asc(schema.resourceLocations.id));

  const userIds = [versionRow.createdBy, ...locRows.map((l) => l.createdBy)];
  const userMap = await loadUserDisplayNames(db, userIds);
  return toVersionDto(
    versionRow,
    locRows.map((l) => toLocationDto(l, userMap)),
    userMap,
  );
}

async function recomputeLatestVersionId(
  tx: Tx,
  projectId: string,
  artifactId: string,
): Promise<string | null> {
  const [top] = await tx
    .select({ id: schema.artifactVersions.id })
    .from(schema.artifactVersions)
    .where(
      and(
        eq(schema.artifactVersions.projectId, projectId),
        eq(schema.artifactVersions.artifactId, artifactId),
        isNull(schema.artifactVersions.deletedAt),
      ),
    )
    .orderBy(desc(schema.artifactVersions.versionNumber))
    .limit(1);

  const nextLatestId = top?.id ?? null;
  await tx
    .update(schema.artifacts)
    .set({ latestVersionId: nextLatestId, updatedAt: new Date() })
    .where(and(eq(schema.artifacts.projectId, projectId), eq(schema.artifacts.id, artifactId)));

  return nextLatestId;
}

export function emitArtifactChanged(
  emit: TxContext['emit'],
  projectId: string,
  payload: ArtifactChangedPayload,
  extra?: { previousWorksheetId?: string | null; previousScopeKind?: ArtifactScopeKind },
): void {
  const sanitized: ArtifactChangedPayload = {
    scopeKind: payload.scopeKind,
    action: payload.action,
    artifactId: payload.artifactId,
    worksheetId: payload.worksheetId,
    workId: payload.workId,
    taskId: payload.taskId,
    stageColumnId: payload.stageColumnId,
  };

  if (sanitized.scopeKind === 'doc' || extra?.previousScopeKind === 'doc') {
    emit({
      scope: { type: 'project', id: projectId },
      type: 'artifact.changed',
      payload: sanitized,
    });
  }

  const notifiedWs = new Set<string>();
  const notifyWs = (wsId: string | null | undefined) => {
    if (!wsId || notifiedWs.has(wsId)) return;
    notifiedWs.add(wsId);
    emit({
      scope: { type: 'worksheet', id: wsId },
      type: 'artifact.changed',
      payload: sanitized,
    });
    emit({
      scope: { type: 'project', id: projectId },
      type: 'board.task_changed',
      payload: {
        worksheetId: wsId,
        ...(sanitized.taskId ? { taskId: sanitized.taskId } : {}),
        action: 'artifact.changed',
      },
    });
  };

  notifyWs(sanitized.worksheetId);
  notifyWs(extra?.previousWorksheetId);
}

/**
 * 构建 GET /api/worksheets/:id 所需的资源摘要与“有未删共用资源的作品 ID 集合”。
 */
export async function buildWorksheetArtifactSummary(
  db: Queryable,
  projectId: string,
  worksheetId: string,
  activeTaskIds: Set<string>,
  activeStageColIds: Set<string>,
): Promise<{ summary: WorksheetArtifactSummary; workIdsWithArtifacts: Set<string> }> {
  const artifactRows = await db
    .select()
    .from(schema.artifacts)
    .where(
      and(
        eq(schema.artifacts.projectId, projectId),
        eq(schema.artifacts.worksheetId, worksheetId),
        isNull(schema.artifacts.deletedAt),
      ),
    )
    .orderBy(desc(schema.artifacts.updatedAt), desc(schema.artifacts.id));

  const visibleArtifacts = artifactRows.filter((a) => {
    if (a.taskId !== null && !activeTaskIds.has(a.taskId)) return false;
    return true;
  });

  const summary: WorksheetArtifactSummary = {
    workCapsules: {},
    workArtifactCounts: {},
    stageBadges: {},
    taskCounts: {},
  };
  const workIdsWithArtifacts = new Set<string>();

  if (visibleArtifacts.length === 0) {
    return { summary, workIdsWithArtifacts };
  }

  const latestVersionIds = visibleArtifacts
    .map((a) => a.latestVersionId)
    .filter((id): id is string => id !== null);

  const [versionRows, locRows] =
    latestVersionIds.length > 0
      ? await Promise.all([
          db
            .select({
              id: schema.artifactVersions.id,
              versionNumber: schema.artifactVersions.versionNumber,
            })
            .from(schema.artifactVersions)
            .where(
              and(
                eq(schema.artifactVersions.projectId, projectId),
                inArray(schema.artifactVersions.id, latestVersionIds),
                isNull(schema.artifactVersions.deletedAt),
              ),
            ),
          db
            .select({
              versionId: schema.resourceLocations.versionId,
              type: schema.resourceLocations.type,
              provider: schema.resourceLocations.provider,
              url: schema.resourceLocations.url,
              extractCode: schema.resourceLocations.extractCode,
              isFolder: schema.resourceLocations.isFolder,
            })
            .from(schema.resourceLocations)
            .where(
              and(
                eq(schema.resourceLocations.projectId, projectId),
                inArray(schema.resourceLocations.versionId, latestVersionIds),
                isNull(schema.resourceLocations.deletedAt),
              ),
            )
            .orderBy(asc(schema.resourceLocations.createdAt), asc(schema.resourceLocations.id)),
        ])
      : [[], []];

  const versionNumMap = new Map(versionRows.map((v) => [v.id, v.versionNumber]));
  const locsByVersion = new Map<string, typeof locRows>();
  for (const loc of locRows) {
    let arr = locsByVersion.get(loc.versionId);
    if (!arr) {
      arr = [];
      locsByVersion.set(loc.versionId, arr);
    }
    arr.push(loc);
  }

  // 按 stageKey 聚合工序格资源
  const stageGroups = new Map<string, Array<typeof schema.artifacts.$inferSelect>>();

  for (const a of visibleArtifacts) {
    if (a.workId !== null && a.taskId === null) {
      workIdsWithArtifacts.add(a.workId);
      summary.workArtifactCounts[a.workId] = (summary.workArtifactCounts[a.workId] ?? 0) + 1;

      const latestVerNum = a.latestVersionId
        ? (versionNumMap.get(a.latestVersionId) ?? null)
        : null;
      const locs = a.latestVersionId ? (locsByVersion.get(a.latestVersionId) ?? []) : [];
      const single = locs.length === 1 ? (locs[0] ?? null) : null;
      const canDirectJump =
        single !== null &&
        single.type === 'cloud_link' &&
        Boolean(single.url) &&
        !single.extractCode;

      const capsule: WorkCapsuleSummary = {
        artifactId: a.id,
        name: a.name,
        latestVersionNumber: latestVerNum,
        locationCount: locs.length,
        directUrl: canDirectJump ? (single?.url ?? null) : null,
        directProvider: single?.provider ?? null,
        directIsFolder: single?.isFolder ?? false,
        hasExtractCode: locs.some((l) => Boolean(l.extractCode)),
        updatedAt: a.updatedAt.toISOString(),
      };
      let list = summary.workCapsules[a.workId];
      if (!list) {
        list = [];
        summary.workCapsules[a.workId] = list;
      }
      list.push(capsule);
    } else if (a.taskId !== null) {
      summary.taskCounts[a.taskId] = (summary.taskCounts[a.taskId] ?? 0) + 1;

      if (a.stageColumnId !== null && activeStageColIds.has(a.stageColumnId)) {
        const key = `${a.taskId}:${a.stageColumnId}`;
        let list = stageGroups.get(key);
        if (!list) {
          list = [];
          stageGroups.set(key, list);
        }
        list.push(a);
      }
    }
  }

  for (const [key, list] of stageGroups.entries()) {
    const lead = list[0]!;
    const latestVerNum = lead.latestVersionId
      ? (versionNumMap.get(lead.latestVersionId) ?? null)
      : null;
    const baseLabel = latestVerNum !== null ? `v${latestVerNum}` : '待补';
    const label = list.length > 1 ? `${baseLabel} +${list.length - 1}` : baseLabel;
    const badge: StageBadgeSummary = {
      artifactCount: list.length,
      latestArtifactId: lead.id,
      latestArtifactName: lead.name,
      latestVersionNumber: latestVerNum,
      label,
    };
    summary.stageBadges[key] = badge;
  }

  return { summary, workIdsWithArtifacts };
}

const docsQuerySchema = z.object({
  q: z.string().max(200).optional(),
});

export function registerArtifactRoutes(
  app: FastifyInstance,
  deps: { db: Db; bus: EventBus },
): void {
  const { db, bus } = deps;

  // GET /api/docs
  app.get<{ Querystring: Record<string, unknown> }>(
    '/api/docs',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const parsed = docsQuerySchema.safeParse(request.query ?? {});
      const needle =
        parsed.success && parsed.data.q ? normalizeText(parsed.data.q).toLowerCase() : '';

      const rows = await db
        .select()
        .from(schema.artifacts)
        .where(
          and(
            eq(schema.artifacts.projectId, auth.projectId),
            isNull(schema.artifacts.worksheetId),
            isNull(schema.artifacts.deletedAt),
          ),
        )
        .orderBy(desc(schema.artifacts.updatedAt), desc(schema.artifacts.id));

      const filtered = needle ? rows.filter((r) => r.name.toLowerCase().includes(needle)) : rows;
      return hydrateArtifacts(db, auth.projectId, filtered);
    },
  );

  // GET /api/works/:workId/artifacts
  app.get<{ Params: { workId: string } }>(
    '/api/works/:workId/artifacts',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const workId = parseUuidParam(request.params.workId);

      const [workRow] = await db
        .select({ work: schema.works })
        .from(schema.works)
        .innerJoin(schema.worksheets, eq(schema.works.worksheetId, schema.worksheets.id))
        .where(
          and(
            eq(schema.works.projectId, auth.projectId),
            eq(schema.works.id, workId),
            eq(schema.worksheets.projectId, auth.projectId),
            isNull(schema.worksheets.deletedAt),
          ),
        )
        .limit(1);
      if (!workRow) throw notFound();

      const artifactRows = await db
        .select()
        .from(schema.artifacts)
        .where(
          and(
            eq(schema.artifacts.projectId, auth.projectId),
            eq(schema.artifacts.workId, workId),
            isNull(schema.artifacts.deletedAt),
          ),
        )
        .orderBy(desc(schema.artifacts.updatedAt), desc(schema.artifacts.id));

      const res: WorkArtifactsResponse = {
        work: toWorkDto(workRow.work),
        artifacts: await hydrateArtifacts(db, auth.projectId, artifactRows),
      };
      return res;
    },
  );

  // GET /api/tasks/:taskId/artifacts
  app.get<{ Params: { taskId: string } }>(
    '/api/tasks/:taskId/artifacts',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const taskId = parseUuidParam(request.params.taskId);

      const [taskRow] = await db
        .select({ task: schema.tasks })
        .from(schema.tasks)
        .innerJoin(schema.worksheets, eq(schema.tasks.worksheetId, schema.worksheets.id))
        .where(
          and(
            eq(schema.tasks.projectId, auth.projectId),
            eq(schema.tasks.id, taskId),
            isNull(schema.tasks.deletedAt),
            eq(schema.worksheets.projectId, auth.projectId),
            isNull(schema.worksheets.deletedAt),
          ),
        )
        .limit(1);
      if (!taskRow) throw notFound();

      const task = taskRow.task;

      const [workRow, taskArtifactRows, workArtifactRows, activeStageCols] = await Promise.all([
        task.workId
          ? db
              .select()
              .from(schema.works)
              .where(
                and(eq(schema.works.projectId, auth.projectId), eq(schema.works.id, task.workId)),
              )
              .limit(1)
              .then((r) => r[0] ?? null)
          : Promise.resolve(null),
        db
          .select()
          .from(schema.artifacts)
          .where(
            and(
              eq(schema.artifacts.projectId, auth.projectId),
              eq(schema.artifacts.taskId, task.id),
              isNull(schema.artifacts.deletedAt),
            ),
          )
          .orderBy(desc(schema.artifacts.updatedAt), desc(schema.artifacts.id)),
        task.workId
          ? db
              .select()
              .from(schema.artifacts)
              .where(
                and(
                  eq(schema.artifacts.projectId, auth.projectId),
                  eq(schema.artifacts.workId, task.workId),
                  isNull(schema.artifacts.deletedAt),
                ),
              )
              .orderBy(desc(schema.artifacts.updatedAt), desc(schema.artifacts.id))
          : Promise.resolve([]),
        db
          .select({ id: schema.columnConfigs.id })
          .from(schema.columnConfigs)
          .where(
            and(
              eq(schema.columnConfigs.projectId, auth.projectId),
              eq(schema.columnConfigs.worksheetId, task.worksheetId),
              eq(schema.columnConfigs.type, 'stage'),
              isNull(schema.columnConfigs.deletedAt),
            ),
          ),
      ]);

      const activeStageColIds = new Set(activeStageCols.map((c) => c.id));
      const combined = [...workArtifactRows, ...taskArtifactRows];
      const hydrated = await hydrateArtifacts(db, auth.projectId, combined);

      const workArtifacts: ArtifactDetail[] = [];
      const stageArtifacts: Record<string, ArtifactDetail[]> = {};
      const taskArtifacts: ArtifactDetail[] = [];

      for (const item of hydrated) {
        if (item.workId !== null && item.taskId === null) {
          workArtifacts.push(item);
        } else if (item.stageColumnId !== null && activeStageColIds.has(item.stageColumnId)) {
          let list = stageArtifacts[item.stageColumnId];
          if (!list) {
            list = [];
            stageArtifacts[item.stageColumnId] = list;
          }
          list.push(item);
        } else {
          taskArtifacts.push(item);
        }
      }

      const res: TaskArtifactsResponse = {
        work: workRow ? toWorkDto(workRow) : null,
        workArtifacts,
        stageArtifacts,
        taskArtifacts,
      };
      return res;
    },
  );

  // POST /api/artifacts
  app.post('/api/artifacts', { config: { access: 'authenticated' } }, async (request, reply) => {
    const auth = request.auth!;
    const body = parseBody(createArtifactBodySchema, request.body);
    const originConnId = readOriginConnId(request);

    const { result } = await withTx(
      db,
      bus,
      { projectId: auth.projectId, userId: auth.userId, originConnId },
      async ({ tx, emit }) => {
        const resolved = await resolveAndValidateScope(tx, auth.projectId, body.scope);

        const [artifact] = await tx
          .insert(schema.artifacts)
          .values({
            projectId: auth.projectId,
            worksheetId: resolved.worksheetId,
            workId: resolved.workId,
            taskId: resolved.taskId,
            stageColumnId: resolved.stageColumnId,
            name: body.name,
            createdBy: auth.userId,
          })
          .returning();
        if (!artifact) throw new AppError('INTERNAL');

        const [v1] = await tx
          .insert(schema.artifactVersions)
          .values({
            projectId: auth.projectId,
            artifactId: artifact.id,
            versionNumber: 1,
            note: body.versionNote ?? '',
            createdBy: auth.userId,
          })
          .returning();
        if (!v1) throw new AppError('INTERNAL');

        const [updatedArtifact] = await tx
          .update(schema.artifacts)
          .set({ latestVersionId: v1.id })
          .where(
            and(
              eq(schema.artifacts.projectId, auth.projectId),
              eq(schema.artifacts.id, artifact.id),
            ),
          )
          .returning();
        if (!updatedArtifact) throw new AppError('INTERNAL');

        if (body.location) {
          const provider = body.location.provider ?? detectCloudProvider(body.location.url);
          await tx.insert(schema.resourceLocations).values({
            projectId: auth.projectId,
            artifactId: artifact.id,
            versionId: v1.id,
            type: 'cloud_link',
            provider,
            url: body.location.url,
            extractCode: body.location.extractCode ?? null,
            isFolder: body.location.isFolder,
            expiresAt: body.location.expiresAt ?? null,
            note: body.location.note ?? '',
            createdBy: auth.userId,
          });
        }

        await recordChangeLog(tx, {
          projectId: auth.projectId,
          worksheetId: resolved.worksheetId,
          taskId: resolved.taskId,
          artifactId: artifact.id,
          actorUserId: auth.userId,
          action: 'artifact.created',
          summary: `在${resolved.label}新建了资源「${artifact.name}」`,
          changes: {
            artifactId: artifact.id,
            name: artifact.name,
            scopeKind: resolved.scopeKind,
            versionNumber: 1,
          },
        });

        emitArtifactChanged(emit, auth.projectId, {
          scopeKind: resolved.scopeKind,
          action: 'artifact.created',
          artifactId: artifact.id,
          worksheetId: resolved.worksheetId,
          workId: resolved.workId,
          taskId: resolved.taskId,
          stageColumnId: resolved.stageColumnId,
        });

        const [detail] = await hydrateArtifacts(tx, auth.projectId, [updatedArtifact]);
        if (!detail) throw new AppError('INTERNAL');
        return detail;
      },
    );

    return reply.code(201).send(result);
  });

  // PATCH /api/artifacts/:id
  app.patch<{ Params: { id: string } }>(
    '/api/artifacts/:id',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const artifactId = parseUuidParam(request.params.id);
      const body = parseBody(updateArtifactBodySchema, request.body);
      const originConnId = readOriginConnId(request);

      const { result } = await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          const [existing] = await tx
            .select()
            .from(schema.artifacts)
            .where(
              and(
                eq(schema.artifacts.projectId, auth.projectId),
                eq(schema.artifacts.id, artifactId),
                isNull(schema.artifacts.deletedAt),
              ),
            )
            .for('update')
            .limit(1);
          if (!existing) throw notFound();

          await ensureArtifactParentActive(tx, auth.projectId, existing);

          const prevScopeKind = deriveScopeKind(existing);
          let nextWorksheetId = existing.worksheetId;
          let nextWorkId = existing.workId;
          let nextTaskId = existing.taskId;
          let nextStageColumnId = existing.stageColumnId;
          let nextScopeKind = prevScopeKind;
          let targetScopeLabel: string | null = null;

          if (body.scope) {
            const resolved = await resolveAndValidateScope(tx, auth.projectId, body.scope);
            nextWorksheetId = resolved.worksheetId;
            nextWorkId = resolved.workId;
            nextTaskId = resolved.taskId;
            nextStageColumnId = resolved.stageColumnId;
            nextScopeKind = resolved.scopeKind;
            targetScopeLabel = resolved.label;
          }

          const nextName = body.name ?? existing.name;
          const moved =
            nextWorksheetId !== existing.worksheetId ||
            nextWorkId !== existing.workId ||
            nextTaskId !== existing.taskId ||
            nextStageColumnId !== existing.stageColumnId;

          const diffs: Array<{ field: string; label: string; from: unknown; to: unknown }> = [];
          if (nextName !== existing.name) {
            diffs.push({ field: 'name', label: '资源名', from: existing.name, to: nextName });
          }
          if (moved) {
            const prevLabel = await describeCurrentScope(tx, auth.projectId, existing);
            diffs.push({
              field: 'scope',
              label: '归属位置',
              from: prevLabel,
              to: targetScopeLabel ?? prevLabel,
            });
          }

          if (diffs.length === 0) {
            const [detail] = await hydrateArtifacts(tx, auth.projectId, [existing]);
            if (!detail) throw new AppError('INTERNAL');
            return detail;
          }

          const [updated] = await tx
            .update(schema.artifacts)
            .set({
              name: nextName,
              worksheetId: nextWorksheetId,
              workId: nextWorkId,
              taskId: nextTaskId,
              stageColumnId: nextStageColumnId,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.artifacts.projectId, auth.projectId),
                eq(schema.artifacts.id, artifactId),
              ),
            )
            .returning();
          if (!updated) throw notFound();

          await recordChangeLog(tx, {
            projectId: auth.projectId,
            worksheetId: updated.worksheetId,
            taskId: updated.taskId,
            artifactId: updated.id,
            actorUserId: auth.userId,
            action: 'artifact.updated',
            summary: `修改了资源「${updated.name}」的${diffs.map((d) => d.label).join('、')}`,
            changes: { artifactId: updated.id, name: updated.name, diffs },
          });

          emitArtifactChanged(
            emit,
            auth.projectId,
            {
              scopeKind: nextScopeKind,
              action: moved ? 'artifact.moved' : 'artifact.updated',
              artifactId: updated.id,
              worksheetId: updated.worksheetId,
              workId: updated.workId,
              taskId: updated.taskId,
              stageColumnId: updated.stageColumnId,
            },
            { previousWorksheetId: existing.worksheetId, previousScopeKind: prevScopeKind },
          );

          const [detail] = await hydrateArtifacts(tx, auth.projectId, [updated]);
          if (!detail) throw new AppError('INTERNAL');
          return detail;
        },
      );

      return result;
    },
  );

  // DELETE /api/artifacts/:id
  app.delete<{ Params: { id: string } }>(
    '/api/artifacts/:id',
    { config: { access: 'authenticated' } },
    async (request, reply) => {
      const auth = request.auth!;
      const artifactId = parseUuidParam(request.params.id);
      const originConnId = readOriginConnId(request);

      await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          const [existing] = await tx
            .select()
            .from(schema.artifacts)
            .where(
              and(
                eq(schema.artifacts.projectId, auth.projectId),
                eq(schema.artifacts.id, artifactId),
                isNull(schema.artifacts.deletedAt),
              ),
            )
            .for('update')
            .limit(1);
          if (!existing) throw notFound();

          await ensureArtifactParentActive(tx, auth.projectId, existing);

          let latestVersionNumber: number | null = null;
          if (existing.latestVersionId) {
            const [ver] = await tx
              .select({ versionNumber: schema.artifactVersions.versionNumber })
              .from(schema.artifactVersions)
              .where(eq(schema.artifactVersions.id, existing.latestVersionId))
              .limit(1);
            latestVersionNumber = ver?.versionNumber ?? null;
          }

          const now = new Date();
          await tx
            .update(schema.artifacts)
            .set({ deletedAt: now, updatedAt: now })
            .where(
              and(
                eq(schema.artifacts.projectId, auth.projectId),
                eq(schema.artifacts.id, artifactId),
              ),
            );

          const scopeKind = deriveScopeKind(existing);
          await recordChangeLog(tx, {
            projectId: auth.projectId,
            worksheetId: existing.worksheetId,
            taskId: existing.taskId,
            artifactId: existing.id,
            actorUserId: auth.userId,
            action: 'artifact.deleted',
            summary: `删除了资源「${existing.name}」`,
            changes: {
              artifactId: existing.id,
              name: existing.name,
              scopeKind,
              latestVersionNumber,
            },
          });

          emitArtifactChanged(emit, auth.projectId, {
            scopeKind,
            action: 'artifact.deleted',
            artifactId: existing.id,
            worksheetId: existing.worksheetId,
            workId: existing.workId,
            taskId: existing.taskId,
            stageColumnId: existing.stageColumnId,
          });
        },
      );

      return reply.code(204).send();
    },
  );

  // POST /api/artifacts/:id/restore
  app.post<{ Params: { id: string } }>(
    '/api/artifacts/:id/restore',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const artifactId = parseUuidParam(request.params.id);
      const originConnId = readOriginConnId(request);

      const { result } = await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          const [existing] = await tx
            .select()
            .from(schema.artifacts)
            .where(
              and(
                eq(schema.artifacts.projectId, auth.projectId),
                eq(schema.artifacts.id, artifactId),
              ),
            )
            .for('update')
            .limit(1);
          if (!existing) throw notFound();

          await ensureArtifactParentActive(tx, auth.projectId, existing, true);

          let nextStageColumnId = existing.stageColumnId;
          let downgraded = false;
          if (existing.stageColumnId && existing.worksheetId) {
            const [col] = await tx
              .select({ id: schema.columnConfigs.id })
              .from(schema.columnConfigs)
              .where(
                and(
                  eq(schema.columnConfigs.projectId, auth.projectId),
                  eq(schema.columnConfigs.worksheetId, existing.worksheetId),
                  eq(schema.columnConfigs.id, existing.stageColumnId),
                  eq(schema.columnConfigs.type, 'stage'),
                  isNull(schema.columnConfigs.deletedAt),
                ),
              )
              .limit(1);
            if (!col) {
              nextStageColumnId = null;
              downgraded = true;
            }
          }

          let restoredRow = existing;
          if (existing.deletedAt !== null) {
            const now = new Date();
            const [updated] = await tx
              .update(schema.artifacts)
              .set({
                deletedAt: null,
                stageColumnId: nextStageColumnId,
                updatedAt: now,
              })
              .where(
                and(
                  eq(schema.artifacts.projectId, auth.projectId),
                  eq(schema.artifacts.id, artifactId),
                ),
              )
              .returning();
            if (!updated) throw notFound();
            restoredRow = updated;

            const scopeKind = deriveScopeKind(restoredRow);
            await recordChangeLog(tx, {
              projectId: auth.projectId,
              worksheetId: restoredRow.worksheetId,
              taskId: restoredRow.taskId,
              artifactId: restoredRow.id,
              actorUserId: auth.userId,
              action: 'artifact.restored',
              summary: downgraded
                ? `恢复了资源「${restoredRow.name}」（原工序列已删，已转为任务级资源）`
                : `恢复了资源「${restoredRow.name}」`,
              changes: {
                artifactId: restoredRow.id,
                name: restoredRow.name,
                ...(downgraded ? { downgradedToTask: true } : {}),
              },
            });

            emitArtifactChanged(emit, auth.projectId, {
              scopeKind,
              action: 'artifact.restored',
              artifactId: restoredRow.id,
              worksheetId: restoredRow.worksheetId,
              workId: restoredRow.workId,
              taskId: restoredRow.taskId,
              stageColumnId: restoredRow.stageColumnId,
            });
          }

          const [detail] = await hydrateArtifacts(tx, auth.projectId, [restoredRow]);
          if (!detail) throw new AppError('INTERNAL');
          return detail;
        },
      );

      return result;
    },
  );

  // POST /api/artifacts/:artifactId/versions
  app.post<{ Params: { artifactId: string } }>(
    '/api/artifacts/:artifactId/versions',
    { config: { access: 'authenticated' } },
    async (request, reply) => {
      const auth = request.auth!;
      const artifactId = parseUuidParam(request.params.artifactId);
      const body = parseBody(createArtifactVersionBodySchema, request.body);
      const originConnId = readOriginConnId(request);

      const { result } = await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          // 锁住资源行保证并发版本号严格递增不冲突
          const [artifact] = await tx
            .select()
            .from(schema.artifacts)
            .where(
              and(
                eq(schema.artifacts.projectId, auth.projectId),
                eq(schema.artifacts.id, artifactId),
                isNull(schema.artifacts.deletedAt),
              ),
            )
            .for('update')
            .limit(1);
          if (!artifact) throw notFound();

          await ensureArtifactParentActive(tx, auth.projectId, artifact);

          const [maxRow] = await tx
            .select({
              maxVer: sql<number>`COALESCE(MAX(${schema.artifactVersions.versionNumber}), 0)::int`,
            })
            .from(schema.artifactVersions)
            .where(
              and(
                eq(schema.artifactVersions.projectId, auth.projectId),
                eq(schema.artifactVersions.artifactId, artifact.id),
              ),
            );
          const nextVersionNumber = (maxRow?.maxVer ?? 0) + 1;

          const [ver] = await tx
            .insert(schema.artifactVersions)
            .values({
              projectId: auth.projectId,
              artifactId: artifact.id,
              versionNumber: nextVersionNumber,
              note: body.note ?? '',
              createdBy: auth.userId,
            })
            .returning();
          if (!ver) throw new AppError('INTERNAL');

          if (body.location) {
            const provider = body.location.provider ?? detectCloudProvider(body.location.url);
            await tx.insert(schema.resourceLocations).values({
              projectId: auth.projectId,
              artifactId: artifact.id,
              versionId: ver.id,
              type: 'cloud_link',
              provider,
              url: body.location.url,
              extractCode: body.location.extractCode ?? null,
              isFolder: body.location.isFolder,
              expiresAt: body.location.expiresAt ?? null,
              note: body.location.note ?? '',
              createdBy: auth.userId,
            });
          }

          await tx
            .update(schema.artifacts)
            .set({ latestVersionId: ver.id, updatedAt: new Date() })
            .where(
              and(
                eq(schema.artifacts.projectId, auth.projectId),
                eq(schema.artifacts.id, artifact.id),
              ),
            );

          await recordChangeLog(tx, {
            projectId: auth.projectId,
            worksheetId: artifact.worksheetId,
            taskId: artifact.taskId,
            artifactId: artifact.id,
            actorUserId: auth.userId,
            action: 'artifact_version.created',
            summary: `为资源「${artifact.name}」登记了 v${ver.versionNumber}`,
            changes: {
              artifactId: artifact.id,
              versionId: ver.id,
              name: artifact.name,
              versionNumber: ver.versionNumber,
              note: ver.note,
            },
          });

          emitArtifactChanged(emit, auth.projectId, {
            scopeKind: deriveScopeKind(artifact),
            action: 'version.created',
            artifactId: artifact.id,
            worksheetId: artifact.worksheetId,
            workId: artifact.workId,
            taskId: artifact.taskId,
            stageColumnId: artifact.stageColumnId,
          });

          return hydrateSingleVersion(tx, auth.projectId, ver);
        },
      );

      return reply.code(201).send(result);
    },
  );

  // DELETE /api/artifact-versions/:versionId
  app.delete<{ Params: { versionId: string } }>(
    '/api/artifact-versions/:versionId',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const versionId = parseUuidParam(request.params.versionId);
      const originConnId = readOriginConnId(request);

      const { result } = await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          const [ver] = await tx
            .select()
            .from(schema.artifactVersions)
            .where(
              and(
                eq(schema.artifactVersions.projectId, auth.projectId),
                eq(schema.artifactVersions.id, versionId),
                isNull(schema.artifactVersions.deletedAt),
              ),
            )
            .limit(1);
          if (!ver) throw notFound();

          const [artifact] = await tx
            .select()
            .from(schema.artifacts)
            .where(
              and(
                eq(schema.artifacts.projectId, auth.projectId),
                eq(schema.artifacts.id, ver.artifactId),
                isNull(schema.artifacts.deletedAt),
              ),
            )
            .for('update')
            .limit(1);
          if (!artifact) throw notFound();

          await ensureArtifactParentActive(tx, auth.projectId, artifact);

          await tx
            .update(schema.artifactVersions)
            .set({ deletedAt: new Date() })
            .where(
              and(
                eq(schema.artifactVersions.projectId, auth.projectId),
                eq(schema.artifactVersions.id, ver.id),
              ),
            );

          const latestVersionId = await recomputeLatestVersionId(tx, auth.projectId, artifact.id);

          await recordChangeLog(tx, {
            projectId: auth.projectId,
            worksheetId: artifact.worksheetId,
            taskId: artifact.taskId,
            artifactId: artifact.id,
            actorUserId: auth.userId,
            action: 'artifact_version.deleted',
            summary: `删除了资源「${artifact.name}」的 v${ver.versionNumber}`,
            changes: {
              artifactId: artifact.id,
              versionId: ver.id,
              name: artifact.name,
              versionNumber: ver.versionNumber,
            },
          });

          emitArtifactChanged(emit, auth.projectId, {
            scopeKind: deriveScopeKind(artifact),
            action: 'version.deleted',
            artifactId: artifact.id,
            worksheetId: artifact.worksheetId,
            workId: artifact.workId,
            taskId: artifact.taskId,
            stageColumnId: artifact.stageColumnId,
          });

          const res: DeleteArtifactVersionResponse = {
            artifactId: artifact.id,
            latestVersionId,
          };
          return res;
        },
      );

      return result;
    },
  );

  // POST /api/artifact-versions/:versionId/restore
  app.post<{ Params: { versionId: string } }>(
    '/api/artifact-versions/:versionId/restore',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const versionId = parseUuidParam(request.params.versionId);
      const originConnId = readOriginConnId(request);

      const { result } = await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          const [ver] = await tx
            .select()
            .from(schema.artifactVersions)
            .where(
              and(
                eq(schema.artifactVersions.projectId, auth.projectId),
                eq(schema.artifactVersions.id, versionId),
              ),
            )
            .limit(1);
          if (!ver) throw notFound();

          const [artifact] = await tx
            .select()
            .from(schema.artifacts)
            .where(
              and(
                eq(schema.artifacts.projectId, auth.projectId),
                eq(schema.artifacts.id, ver.artifactId),
              ),
            )
            .for('update')
            .limit(1);
          if (!artifact) throw notFound();

          if (artifact.deletedAt !== null) {
            throw new AppError('CONFLICT', '所属资源已删除，请先恢复该资源');
          }
          await ensureArtifactParentActive(tx, auth.projectId, artifact, true);

          let restoredVer = ver;
          if (ver.deletedAt !== null) {
            const [updated] = await tx
              .update(schema.artifactVersions)
              .set({ deletedAt: null })
              .where(
                and(
                  eq(schema.artifactVersions.projectId, auth.projectId),
                  eq(schema.artifactVersions.id, ver.id),
                ),
              )
              .returning();
            if (!updated) throw notFound();
            restoredVer = updated;

            await recomputeLatestVersionId(tx, auth.projectId, artifact.id);

            await recordChangeLog(tx, {
              projectId: auth.projectId,
              worksheetId: artifact.worksheetId,
              taskId: artifact.taskId,
              artifactId: artifact.id,
              actorUserId: auth.userId,
              action: 'artifact_version.restored',
              summary: `恢复了资源「${artifact.name}」的 v${ver.versionNumber}`,
              changes: {
                artifactId: artifact.id,
                versionId: ver.id,
                name: artifact.name,
                versionNumber: ver.versionNumber,
              },
            });

            emitArtifactChanged(emit, auth.projectId, {
              scopeKind: deriveScopeKind(artifact),
              action: 'version.restored',
              artifactId: artifact.id,
              worksheetId: artifact.worksheetId,
              workId: artifact.workId,
              taskId: artifact.taskId,
              stageColumnId: artifact.stageColumnId,
            });
          }

          return hydrateSingleVersion(tx, auth.projectId, restoredVer);
        },
      );

      return result;
    },
  );

  // POST /api/artifact-versions/:versionId/locations
  app.post<{ Params: { versionId: string } }>(
    '/api/artifact-versions/:versionId/locations',
    { config: { access: 'authenticated' } },
    async (request, reply) => {
      const auth = request.auth!;
      const versionId = parseUuidParam(request.params.versionId);
      const body = parseBody(createResourceLocationBodySchema, request.body);
      const originConnId = readOriginConnId(request);

      const { result } = await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          const [ver] = await tx
            .select()
            .from(schema.artifactVersions)
            .where(
              and(
                eq(schema.artifactVersions.projectId, auth.projectId),
                eq(schema.artifactVersions.id, versionId),
                isNull(schema.artifactVersions.deletedAt),
              ),
            )
            .limit(1);
          if (!ver) throw notFound();

          const [artifact] = await tx
            .select()
            .from(schema.artifacts)
            .where(
              and(
                eq(schema.artifacts.projectId, auth.projectId),
                eq(schema.artifacts.id, ver.artifactId),
                isNull(schema.artifacts.deletedAt),
              ),
            )
            .limit(1);
          if (!artifact) throw notFound();

          await ensureArtifactParentActive(tx, auth.projectId, artifact);

          const provider = body.provider ?? detectCloudProvider(body.url);
          const now = new Date();
          const [loc] = await tx
            .insert(schema.resourceLocations)
            .values({
              projectId: auth.projectId,
              artifactId: artifact.id,
              versionId: ver.id,
              type: 'cloud_link',
              provider,
              url: body.url,
              extractCode: body.extractCode ?? null,
              isFolder: body.isFolder,
              expiresAt: body.expiresAt ?? null,
              note: body.note ?? '',
              createdBy: auth.userId,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          if (!loc) throw new AppError('INTERNAL');

          await tx
            .update(schema.artifacts)
            .set({ updatedAt: now })
            .where(
              and(
                eq(schema.artifacts.projectId, auth.projectId),
                eq(schema.artifacts.id, artifact.id),
              ),
            );

          await recordChangeLog(tx, {
            projectId: auth.projectId,
            worksheetId: artifact.worksheetId,
            taskId: artifact.taskId,
            artifactId: artifact.id,
            actorUserId: auth.userId,
            action: 'location.created',
            summary: `为资源「${artifact.name}」(v${ver.versionNumber}) 添加了网盘入口`,
            changes: {
              artifactId: artifact.id,
              versionId: ver.id,
              locationId: loc.id,
              name: artifact.name,
              versionNumber: ver.versionNumber,
              provider: loc.provider,
              isFolder: loc.isFolder,
              hasExtractCode: Boolean(loc.extractCode),
            },
          });

          emitArtifactChanged(emit, auth.projectId, {
            scopeKind: deriveScopeKind(artifact),
            action: 'location.created',
            artifactId: artifact.id,
            worksheetId: artifact.worksheetId,
            workId: artifact.workId,
            taskId: artifact.taskId,
            stageColumnId: artifact.stageColumnId,
          });

          const userMap = new Map([[auth.userId, auth.displayName]]);
          return toLocationDto(loc, userMap);
        },
      );

      return reply.code(201).send(result);
    },
  );

  // PATCH /api/resource-locations/:id
  app.patch<{ Params: { id: string } }>(
    '/api/resource-locations/:id',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const locationId = parseUuidParam(request.params.id);
      const body = parseBody(updateResourceLocationBodySchema, request.body);
      const originConnId = readOriginConnId(request);

      const { result } = await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          const [loc] = await tx
            .select()
            .from(schema.resourceLocations)
            .where(
              and(
                eq(schema.resourceLocations.projectId, auth.projectId),
                eq(schema.resourceLocations.id, locationId),
                isNull(schema.resourceLocations.deletedAt),
              ),
            )
            .limit(1);
          if (!loc) throw notFound();

          const [ver] = await tx
            .select()
            .from(schema.artifactVersions)
            .where(
              and(
                eq(schema.artifactVersions.projectId, auth.projectId),
                eq(schema.artifactVersions.id, loc.versionId),
                isNull(schema.artifactVersions.deletedAt),
              ),
            )
            .limit(1);
          if (!ver) throw notFound();

          const [artifact] = await tx
            .select()
            .from(schema.artifacts)
            .where(
              and(
                eq(schema.artifacts.projectId, auth.projectId),
                eq(schema.artifacts.id, loc.artifactId),
                isNull(schema.artifacts.deletedAt),
              ),
            )
            .limit(1);
          if (!artifact) throw notFound();

          await ensureArtifactParentActive(tx, auth.projectId, artifact);

          const nextUrl = body.url ?? loc.url;
          const nextProvider =
            body.provider !== undefined
              ? body.provider
              : body.url !== undefined && nextUrl
                ? detectCloudProvider(nextUrl)
                : loc.provider;
          const nextExtractCode =
            body.extractCode !== undefined ? body.extractCode : loc.extractCode;
          const nextIsFolder = body.isFolder ?? loc.isFolder;
          const nextExpiresAt = body.expiresAt !== undefined ? body.expiresAt : loc.expiresAt;
          const nextNote = body.note ?? loc.note;
          const now = new Date();

          const [updated] = await tx
            .update(schema.resourceLocations)
            .set({
              provider: nextProvider,
              url: nextUrl,
              extractCode: nextExtractCode,
              isFolder: nextIsFolder,
              expiresAt: nextExpiresAt,
              note: nextNote,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.resourceLocations.projectId, auth.projectId),
                eq(schema.resourceLocations.id, locationId),
              ),
            )
            .returning();
          if (!updated) throw notFound();

          await tx
            .update(schema.artifacts)
            .set({ updatedAt: now })
            .where(
              and(
                eq(schema.artifacts.projectId, auth.projectId),
                eq(schema.artifacts.id, artifact.id),
              ),
            );

          await recordChangeLog(tx, {
            projectId: auth.projectId,
            worksheetId: artifact.worksheetId,
            taskId: artifact.taskId,
            artifactId: artifact.id,
            actorUserId: auth.userId,
            action: 'location.updated',
            summary: `更新了资源「${artifact.name}」(v${ver.versionNumber}) 的网盘入口`,
            changes: {
              artifactId: artifact.id,
              versionId: ver.id,
              locationId: updated.id,
              name: artifact.name,
              versionNumber: ver.versionNumber,
              provider: updated.provider,
              isFolder: updated.isFolder,
              hasExtractCode: Boolean(updated.extractCode),
            },
          });

          emitArtifactChanged(emit, auth.projectId, {
            scopeKind: deriveScopeKind(artifact),
            action: 'location.updated',
            artifactId: artifact.id,
            worksheetId: artifact.worksheetId,
            workId: artifact.workId,
            taskId: artifact.taskId,
            stageColumnId: artifact.stageColumnId,
          });

          const userMap = await loadUserDisplayNames(tx, [updated.createdBy]);
          return toLocationDto(updated, userMap);
        },
      );

      return result;
    },
  );

  // DELETE /api/resource-locations/:id
  app.delete<{ Params: { id: string } }>(
    '/api/resource-locations/:id',
    { config: { access: 'authenticated' } },
    async (request, reply) => {
      const auth = request.auth!;
      const locationId = parseUuidParam(request.params.id);
      const originConnId = readOriginConnId(request);

      await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          const [loc] = await tx
            .select()
            .from(schema.resourceLocations)
            .where(
              and(
                eq(schema.resourceLocations.projectId, auth.projectId),
                eq(schema.resourceLocations.id, locationId),
                isNull(schema.resourceLocations.deletedAt),
              ),
            )
            .limit(1);
          if (!loc) throw notFound();

          const [ver] = await tx
            .select()
            .from(schema.artifactVersions)
            .where(
              and(
                eq(schema.artifactVersions.projectId, auth.projectId),
                eq(schema.artifactVersions.id, loc.versionId),
                isNull(schema.artifactVersions.deletedAt),
              ),
            )
            .limit(1);
          if (!ver) throw notFound();

          const [artifact] = await tx
            .select()
            .from(schema.artifacts)
            .where(
              and(
                eq(schema.artifacts.projectId, auth.projectId),
                eq(schema.artifacts.id, loc.artifactId),
                isNull(schema.artifacts.deletedAt),
              ),
            )
            .limit(1);
          if (!artifact) throw notFound();

          await ensureArtifactParentActive(tx, auth.projectId, artifact);

          const now = new Date();
          await tx
            .update(schema.resourceLocations)
            .set({ deletedAt: now, updatedAt: now })
            .where(
              and(
                eq(schema.resourceLocations.projectId, auth.projectId),
                eq(schema.resourceLocations.id, locationId),
              ),
            );

          await tx
            .update(schema.artifacts)
            .set({ updatedAt: now })
            .where(
              and(
                eq(schema.artifacts.projectId, auth.projectId),
                eq(schema.artifacts.id, artifact.id),
              ),
            );

          await recordChangeLog(tx, {
            projectId: auth.projectId,
            worksheetId: artifact.worksheetId,
            taskId: artifact.taskId,
            artifactId: artifact.id,
            actorUserId: auth.userId,
            action: 'location.deleted',
            summary: `移除了资源「${artifact.name}」(v${ver.versionNumber}) 的一个网盘入口`,
            changes: {
              artifactId: artifact.id,
              versionId: ver.id,
              locationId: loc.id,
              name: artifact.name,
              versionNumber: ver.versionNumber,
              provider: loc.provider,
              isFolder: loc.isFolder,
              hasExtractCode: Boolean(loc.extractCode),
            },
          });

          emitArtifactChanged(emit, auth.projectId, {
            scopeKind: deriveScopeKind(artifact),
            action: 'location.deleted',
            artifactId: artifact.id,
            worksheetId: artifact.worksheetId,
            workId: artifact.workId,
            taskId: artifact.taskId,
            stageColumnId: artifact.stageColumnId,
          });
        },
      );

      return reply.code(204).send();
    },
  );

  // POST /api/resource-locations/:id/restore
  app.post<{ Params: { id: string } }>(
    '/api/resource-locations/:id/restore',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const locationId = parseUuidParam(request.params.id);
      const originConnId = readOriginConnId(request);

      const { result } = await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          const [loc] = await tx
            .select()
            .from(schema.resourceLocations)
            .where(
              and(
                eq(schema.resourceLocations.projectId, auth.projectId),
                eq(schema.resourceLocations.id, locationId),
              ),
            )
            .limit(1);
          if (!loc) throw notFound();

          const [ver] = await tx
            .select()
            .from(schema.artifactVersions)
            .where(
              and(
                eq(schema.artifactVersions.projectId, auth.projectId),
                eq(schema.artifactVersions.id, loc.versionId),
              ),
            )
            .limit(1);
          if (!ver) throw notFound();
          if (ver.deletedAt !== null) {
            throw new AppError('CONFLICT', '所属版本已删除，请先恢复该版本');
          }

          const [artifact] = await tx
            .select()
            .from(schema.artifacts)
            .where(
              and(
                eq(schema.artifacts.projectId, auth.projectId),
                eq(schema.artifacts.id, loc.artifactId),
              ),
            )
            .limit(1);
          if (!artifact) throw notFound();
          if (artifact.deletedAt !== null) {
            throw new AppError('CONFLICT', '所属资源已删除，请先恢复该资源');
          }
          await ensureArtifactParentActive(tx, auth.projectId, artifact, true);

          let restoredLoc = loc;
          if (loc.deletedAt !== null) {
            const now = new Date();
            const [updated] = await tx
              .update(schema.resourceLocations)
              .set({ deletedAt: null, updatedAt: now })
              .where(
                and(
                  eq(schema.resourceLocations.projectId, auth.projectId),
                  eq(schema.resourceLocations.id, locationId),
                ),
              )
              .returning();
            if (!updated) throw notFound();
            restoredLoc = updated;

            await tx
              .update(schema.artifacts)
              .set({ updatedAt: now })
              .where(
                and(
                  eq(schema.artifacts.projectId, auth.projectId),
                  eq(schema.artifacts.id, artifact.id),
                ),
              );

            await recordChangeLog(tx, {
              projectId: auth.projectId,
              worksheetId: artifact.worksheetId,
              taskId: artifact.taskId,
              artifactId: artifact.id,
              actorUserId: auth.userId,
              action: 'location.restored',
              summary: `恢复了资源「${artifact.name}」(v${ver.versionNumber}) 的网盘入口`,
              changes: {
                artifactId: artifact.id,
                versionId: ver.id,
                locationId: restoredLoc.id,
                name: artifact.name,
                versionNumber: ver.versionNumber,
                provider: restoredLoc.provider,
                isFolder: restoredLoc.isFolder,
                hasExtractCode: Boolean(restoredLoc.extractCode),
              },
            });

            emitArtifactChanged(emit, auth.projectId, {
              scopeKind: deriveScopeKind(artifact),
              action: 'location.restored',
              artifactId: artifact.id,
              worksheetId: artifact.worksheetId,
              workId: artifact.workId,
              taskId: artifact.taskId,
              stageColumnId: artifact.stageColumnId,
            });
          }

          const userMap = await loadUserDisplayNames(tx, [restoredLoc.createdBy]);
          return toLocationDto(restoredLoc, userMap);
        },
      );

      return result;
    },
  );
}
