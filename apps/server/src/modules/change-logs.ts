import type { ChangeLogAction, ChangeLogItem, ChangeLogsResponse } from '@nw/shared';
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Db, schema, type Tx } from '../db/index.js';
import { notFound } from '../errors.js';
import { parseUuidParam } from './helpers.js';

export interface ChangeLogEntryInput {
  projectId: string;
  worksheetId: string | null;
  taskId: string | null;
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
        // uuidv7 按时间单调递增，lt(id, cursor) 精确翻页
        conditions.push(lt(schema.changeLogs.id, cursor));
      }

      const rows = await db
        .select({
          id: schema.changeLogs.id,
          worksheetId: schema.changeLogs.worksheetId,
          taskId: schema.changeLogs.taskId,
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

      // 查询删除记录对应的任务当前软删除状态，计算 canRestore / wasRestored
      const deletedTaskIds = [
        ...new Set(
          pageRows
            .filter((r) => r.action === 'task.deleted' && r.taskId)
            .map((r) => r.taskId as string),
        ),
      ];
      const taskDeletedMap = new Map<string, boolean>();
      if (deletedTaskIds.length > 0) {
        const taskRows = await db
          .select({ id: schema.tasks.id, deletedAt: schema.tasks.deletedAt })
          .from(schema.tasks)
          .where(
            and(
              eq(schema.tasks.projectId, auth.projectId),
              inArray(schema.tasks.id, deletedTaskIds),
            ),
          );
        for (const tr of taskRows) {
          taskDeletedMap.set(tr.id, tr.deletedAt !== null);
        }
      }

      const wsActive = ws.deletedAt === null;
      const items: ChangeLogItem[] = pageRows.map((r) => {
        const base: ChangeLogItem = {
          id: r.id,
          worksheetId: r.worksheetId,
          taskId: r.taskId,
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
        }
        return base;
      });

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
