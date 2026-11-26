import type { ChangeLogAction, ChangeLogItem, ChangeLogsResponse } from '@nw/shared';
import { and, desc, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Db, type Queryable, schema, type Tx } from '../db/index.js';
import { notFound } from '../errors.js';
import { parseUuidParam } from './helpers.js';

export interface ChangeLogEntryInput {
  projectId: string;
  worksheetId: string | null;
  taskId: string | null;
  artifactId?: string | null;
  actorUserId: string;
  action: ChangeLogAction;
  summary: string;
  changes: Record<string, unknown>;
}

export async function recordChangeLog(tx: Tx, entry: ChangeLogEntryInput): Promise<void> {
  await tx.insert(schema.changeLogs).values({
    projectId: entry.projectId,
    worksheetId: entry.worksheetId,
    taskId: entry.taskId,
    artifactId: entry.artifactId ?? null,
    actorUserId: entry.actorUserId,
    action: entry.action,
    summary: entry.summary,
    changes: entry.changes,
  });
}

const querySchema = z.object({
  taskId: z.uuid().optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

interface RawLogRow {
  id: string;
  worksheetId: string | null;
  taskId: string | null;
  artifactId: string | null;
  actorUserId: string;
  actorDisplayName: string;
  action: string;
  summary: string;
  changes: Record<string, unknown>;
  createdAt: Date;
}

async function enrichChangeLogItems(
  db: Queryable,
  projectId: string,
  pageRows: RawLogRow[],
  wsActive: boolean,
): Promise<ChangeLogItem[]> {
  const deletedTaskIds = [
    ...new Set(
      pageRows
        .filter((r) => r.action === 'task.deleted' && r.taskId)
        .map((r) => r.taskId as string),
    ),
  ];

  const artifactLogIds = [
    ...new Set(
      pageRows
        .filter(
          (r) =>
            (r.action === 'artifact.deleted' ||
              r.action === 'artifact_version.deleted' ||
              r.action === 'location.deleted') &&
            (r.artifactId || typeof r.changes.artifactId === 'string'),
        )
        .map((r) => r.artifactId ?? (r.changes.artifactId as string)),
    ),
  ];

  const deletedVersionIds = [
    ...new Set(
      pageRows
        .filter(
          (r) =>
            (r.action === 'artifact_version.deleted' || r.action === 'location.deleted') &&
            typeof r.changes.versionId === 'string',
        )
        .map((r) => r.changes.versionId as string),
    ),
  ];

  const deletedLocationIds = [
    ...new Set(
      pageRows
        .filter((r) => r.action === 'location.deleted' && typeof r.changes.locationId === 'string')
        .map((r) => r.changes.locationId as string),
    ),
  ];

  const [taskRows, artifactRows, versionRows, locationRows] = await Promise.all([
    deletedTaskIds.length > 0
      ? db
          .select({ id: schema.tasks.id, deletedAt: schema.tasks.deletedAt })
          .from(schema.tasks)
          .where(
            and(eq(schema.tasks.projectId, projectId), inArray(schema.tasks.id, deletedTaskIds)),
          )
      : Promise.resolve([]),
    artifactLogIds.length > 0
      ? db
          .select({
            id: schema.artifacts.id,
            taskId: schema.artifacts.taskId,
            deletedAt: schema.artifacts.deletedAt,
          })
          .from(schema.artifacts)
          .where(
            and(
              eq(schema.artifacts.projectId, projectId),
              inArray(schema.artifacts.id, artifactLogIds),
            ),
          )
      : Promise.resolve([]),
    deletedVersionIds.length > 0
      ? db
          .select({
            id: schema.artifactVersions.id,
            artifactId: schema.artifactVersions.artifactId,
            deletedAt: schema.artifactVersions.deletedAt,
          })
          .from(schema.artifactVersions)
          .where(
            and(
              eq(schema.artifactVersions.projectId, projectId),
              inArray(schema.artifactVersions.id, deletedVersionIds),
            ),
          )
      : Promise.resolve([]),
    deletedLocationIds.length > 0
      ? db
          .select({
            id: schema.resourceLocations.id,
            versionId: schema.resourceLocations.versionId,
            artifactId: schema.resourceLocations.artifactId,
            type: schema.resourceLocations.type,
            deletedAt: schema.resourceLocations.deletedAt,
          })
          .from(schema.resourceLocations)
          .where(
            and(
              eq(schema.resourceLocations.projectId, projectId),
              inArray(schema.resourceLocations.id, deletedLocationIds),
            ),
          )
      : Promise.resolve([]),
  ]);

  const taskDeletedMap = new Map(taskRows.map((tr) => [tr.id, tr.deletedAt !== null]));
  const artifactMap = new Map(artifactRows.map((ar) => [ar.id, ar]));
  const versionMap = new Map(versionRows.map((vr) => [vr.id, vr]));
  const locationMap = new Map(locationRows.map((lr) => [lr.id, lr]));

  // 检查被删资源所属任务是否处于未删状态（以计算 canRestore）
  const parentTaskIds = [
    ...new Set(
      artifactRows
        .map((a) => a.taskId)
        .filter((tid): tid is string => tid !== null && !taskDeletedMap.has(tid)),
    ),
  ];
  if (parentTaskIds.length > 0) {
    const parentTasks = await db
      .select({ id: schema.tasks.id, deletedAt: schema.tasks.deletedAt })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.projectId, projectId), inArray(schema.tasks.id, parentTaskIds)));
    for (const pt of parentTasks) {
      taskDeletedMap.set(pt.id, pt.deletedAt !== null);
    }
  }

  return pageRows.map((r) => {
    const base: ChangeLogItem = {
      id: r.id,
      worksheetId: r.worksheetId,
      taskId: r.taskId,
      artifactId: r.artifactId,
      actor: { id: r.actorUserId, displayName: r.actorDisplayName },
      action: r.action as ChangeLogAction,
      summary: r.summary,
      changes: r.changes,
      createdAt: r.createdAt.toISOString(),
    };

    if (r.action === 'task.deleted' && r.taskId) {
      const isDeleted = taskDeletedMap.get(r.taskId) ?? false;
      base.canRestore = wsActive && isDeleted;
      base.wasRestored = !isDeleted && taskDeletedMap.has(r.taskId);
    } else if (r.action === 'artifact.deleted') {
      const aid =
        r.artifactId ?? (typeof r.changes.artifactId === 'string' ? r.changes.artifactId : null);
      if (aid) {
        const art = artifactMap.get(aid);
        if (art) {
          const isDeleted = art.deletedAt !== null;
          const parentTaskActive = art.taskId === null || !(taskDeletedMap.get(art.taskId) ?? true);
          base.canRestore = wsActive && isDeleted && parentTaskActive;
          base.wasRestored = !isDeleted;
        }
      }
    } else if (r.action === 'artifact_version.deleted') {
      const vid = typeof r.changes.versionId === 'string' ? r.changes.versionId : null;
      if (vid) {
        const ver = versionMap.get(vid);
        if (ver) {
          const art = artifactMap.get(ver.artifactId);
          const isDeleted = ver.deletedAt !== null;
          const artActive = art !== undefined && art.deletedAt === null;
          const parentTaskActive =
            art === undefined || art.taskId === null || !(taskDeletedMap.get(art.taskId) ?? true);
          base.canRestore = wsActive && isDeleted && artActive && parentTaskActive;
          base.wasRestored = !isDeleted;
        }
      }
    } else if (r.action === 'location.deleted') {
      const lid = typeof r.changes.locationId === 'string' ? r.changes.locationId : null;
      if (lid) {
        const loc = locationMap.get(lid);
        if (loc) {
          const ver = versionMap.get(loc.versionId);
          const art = artifactMap.get(loc.artifactId);
          const isDeleted = loc.deletedAt !== null;
          const verActive = ver !== undefined && ver.deletedAt === null;
          const artActive = art !== undefined && art.deletedAt === null;
          const parentTaskActive =
            art === undefined || art.taskId === null || !(taskDeletedMap.get(art.taskId) ?? true);
          base.canRestore = wsActive && isDeleted && verActive && artActive && parentTaskActive;
          base.wasRestored = !isDeleted;
        }
      }
    }

    return base;
  });
}

export function registerChangeLogRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps;

  // GET /api/worksheets/:worksheetId/change-logs
  app.get<{ Params: { worksheetId: string }; Querystring: Record<string, unknown> }>(
    '/api/worksheets/:worksheetId/change-logs',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const worksheetId = parseUuidParam(request.params.worksheetId);
      const q = querySchema.safeParse(request.query ?? {});
      const { taskId, cursor, limit } = q.success
        ? q.data
        : { taskId: undefined, cursor: undefined, limit: 50 };

      const [ws] = await db
        .select({ id: schema.worksheets.id, deletedAt: schema.worksheets.deletedAt })
        .from(schema.worksheets)
        .where(
          and(
            eq(schema.worksheets.projectId, auth.projectId),
            eq(schema.worksheets.id, worksheetId),
          ),
        )
        .limit(1);

      if (!ws) throw notFound();

      const conditions = [
        eq(schema.changeLogs.projectId, auth.projectId),
        eq(schema.changeLogs.worksheetId, worksheetId),
      ];
      if (taskId) {
        conditions.push(eq(schema.changeLogs.taskId, taskId));
      }
      if (cursor) {
        conditions.push(lt(schema.changeLogs.id, cursor));
      }

      const rows = await db
        .select({
          id: schema.changeLogs.id,
          worksheetId: schema.changeLogs.worksheetId,
          taskId: schema.changeLogs.taskId,
          artifactId: schema.changeLogs.artifactId,
          actorUserId: schema.changeLogs.actorUserId,
          actorDisplayName: schema.users.displayName,
          action: schema.changeLogs.action,
          summary: schema.changeLogs.summary,
          changes: schema.changeLogs.changes,
          createdAt: schema.changeLogs.createdAt,
        })
        .from(schema.changeLogs)
        .innerJoin(schema.users, eq(schema.changeLogs.actorUserId, schema.users.id))
        .where(and(...conditions))
        .orderBy(desc(schema.changeLogs.createdAt), desc(schema.changeLogs.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = await enrichChangeLogItems(db, auth.projectId, pageRows, ws.deletedAt === null);

      const lastItem = pageRows[pageRows.length - 1];
      const res: ChangeLogsResponse = {
        items,
        nextCursor: hasMore && lastItem ? lastItem.id : null,
      };
      return res;
    },
  );

  // GET /api/docs/change-logs
  app.get<{ Querystring: Record<string, unknown> }>(
    '/api/docs/change-logs',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const q = querySchema.safeParse(request.query ?? {});
      const { cursor, limit } = q.success ? q.data : { cursor: undefined, limit: 50 };

      const conditions = [
        eq(schema.changeLogs.projectId, auth.projectId),
        isNull(schema.changeLogs.worksheetId),
        isNotNull(schema.changeLogs.artifactId),
      ];
      if (cursor) {
        conditions.push(lt(schema.changeLogs.id, cursor));
      }

      const rows = await db
        .select({
          id: schema.changeLogs.id,
          worksheetId: schema.changeLogs.worksheetId,
          taskId: schema.changeLogs.taskId,
          artifactId: schema.changeLogs.artifactId,
          actorUserId: schema.changeLogs.actorUserId,
          actorDisplayName: schema.users.displayName,
          action: schema.changeLogs.action,
          summary: schema.changeLogs.summary,
          changes: schema.changeLogs.changes,
          createdAt: schema.changeLogs.createdAt,
        })
        .from(schema.changeLogs)
        .innerJoin(schema.users, eq(schema.changeLogs.actorUserId, schema.users.id))
        .where(and(...conditions))
        .orderBy(desc(schema.changeLogs.createdAt), desc(schema.changeLogs.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = await enrichChangeLogItems(db, auth.projectId, pageRows, true);

      const lastItem = pageRows[pageRows.length - 1];
      const res: ChangeLogsResponse = {
        items,
        nextCursor: hasMore && lastItem ? lastItem.id : null,
      };
      return res;
    },
  );
}

/** 查询当前项目内某工作表是否未删并返回行 */
export async function findActiveWorksheet(db: Db | Tx, projectId: string, worksheetId: string) {
  const [ws] = await db
    .select()
    .from(schema.worksheets)
    .where(
      and(
        eq(schema.worksheets.projectId, projectId),
        eq(schema.worksheets.id, worksheetId),
        isNull(schema.worksheets.deletedAt),
      ),
    )
    .limit(1);
  return ws ?? null;
}
