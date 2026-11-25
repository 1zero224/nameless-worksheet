import {
  normalizeText,
  type SearchResponse,
  type SearchTaskItem,
  type StageCell,
  stageStatusSchema,
  type WorksheetColor,
} from '@nw/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type Db, schema } from '../db/index.js';
import { toStageCellDto } from './worksheets.js';

const searchQuerySchema = z.object({
  q: z.string().max(200).optional(),
  worksheetId: z.uuid().optional(),
  status: stageStatusSchema.optional(),
  hidePublished: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function registerSearchRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps;

  // GET /api/search
  app.get<{ Querystring: Record<string, unknown> }>(
    '/api/search',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const parsed = searchQuerySchema.safeParse(request.query ?? {});
      const { q, worksheetId, status, hidePublished, limit, offset } = parsed.success
        ? parsed.data
        : {
            q: undefined,
            worksheetId: undefined,
            status: undefined,
            hidePublished: false,
            limit: 50,
            offset: 0,
          };

      const wsConditions = [
        eq(schema.worksheets.projectId, auth.projectId),
        isNull(schema.worksheets.deletedAt),
      ];
      if (worksheetId) {
        wsConditions.push(eq(schema.worksheets.id, worksheetId));
      }

      const wsRows = await db
        .select()
        .from(schema.worksheets)
        .where(and(...wsConditions))
        .orderBy(asc(schema.worksheets.sortOrder), asc(schema.worksheets.id));

      if (wsRows.length === 0) {
        const empty: SearchResponse = { items: [], total: 0 };
        return empty;
      }

      const activeWsIds = wsRows.map((w) => w.id);
      const wsMap = new Map(wsRows.map((w) => [w.id, w]));
      const wsRank = new Map(wsRows.map((w, idx) => [w.id, idx]));

      const taskConditions = [
        eq(schema.tasks.projectId, auth.projectId),
        inArray(schema.tasks.worksheetId, activeWsIds),
        isNull(schema.tasks.deletedAt),
      ];
      if (hidePublished) {
        taskConditions.push(eq(schema.tasks.publishStatus, 'unpublished'));
      }

      const [colRows, taskRows, workRows, cellRows, memberRows] = await Promise.all([
        db
          .select()
          .from(schema.columnConfigs)
          .where(
            and(
              eq(schema.columnConfigs.projectId, auth.projectId),
              inArray(schema.columnConfigs.worksheetId, activeWsIds),
              isNull(schema.columnConfigs.deletedAt),
            ),
          )
          .orderBy(asc(schema.columnConfigs.sortOrder), asc(schema.columnConfigs.id)),
        db
          .select()
          .from(schema.tasks)
          .where(and(...taskConditions))
          .orderBy(asc(schema.tasks.sortOrder), asc(schema.tasks.id)),
        db
          .select()
          .from(schema.works)
          .where(
            and(
              eq(schema.works.projectId, auth.projectId),
              inArray(schema.works.worksheetId, activeWsIds),
            ),
          ),
        db
          .select()
          .from(schema.stageCells)
          .where(
            and(
              eq(schema.stageCells.projectId, auth.projectId),
              inArray(schema.stageCells.worksheetId, activeWsIds),
            ),
          ),
        db
          .select({ id: schema.users.id, displayName: schema.users.displayName })
          .from(schema.memberships)
          .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
          .where(eq(schema.memberships.projectId, auth.projectId)),
      ]);

      const userNameMap = new Map(memberRows.map((m) => [m.id, m.displayName]));
      const workNameMap = new Map(workRows.map((w) => [w.id, w.name]));

      const stageColsByWs = new Map<string, Array<{ id: string; name: string }>>();
      const textColIdsByWs = new Map<string, string[]>();
      for (const col of colRows) {
        if (col.type === 'stage') {
          let arr = stageColsByWs.get(col.worksheetId);
          if (!arr) {
            arr = [];
            stageColsByWs.set(col.worksheetId, arr);
          }
          arr.push({ id: col.id, name: col.name });
        } else if (col.type === 'text') {
          let arr = textColIdsByWs.get(col.worksheetId);
          if (!arr) {
            arr = [];
            textColIdsByWs.set(col.worksheetId, arr);
          }
          arr.push(col.id);
        }
      }

      const cellsByTask = new Map<string, Map<string, StageCell>>();
      for (const cell of cellRows) {
        let m = cellsByTask.get(cell.taskId);
        if (!m) {
          m = new Map();
          cellsByTask.set(cell.taskId, m);
        }
        m.set(cell.columnId, toStageCellDto(cell));
      }

      const needle = q ? normalizeText(q).toLowerCase() : '';

      // 按工作表顺序 + 任务顺序排列
      taskRows.sort((a, b) => {
        const wa = wsRank.get(a.worksheetId) ?? 0;
        const wb = wsRank.get(b.worksheetId) ?? 0;
        if (wa !== wb) return wa - wb;
        if (a.sortOrder < b.sortOrder) return -1;
        if (a.sortOrder > b.sortOrder) return 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });

      const matched: SearchTaskItem[] = [];

      for (const task of taskRows) {
        const ws = wsMap.get(task.worksheetId);
        if (!ws) continue;
        const workName = task.workId ? (workNameMap.get(task.workId) ?? null) : null;
        const stageCols = stageColsByWs.get(task.worksheetId) ?? [];
        const taskCells = cellsByTask.get(task.id);

        const stages = stageCols.map((sc) => {
          const cell = taskCells?.get(sc.id);
          const assignees = cell?.assignees ?? [];
          const assigneeNames = assignees.map((a) =>
            a.type === 'user' ? (userNameMap.get(a.userId) ?? '未知用户') : a.name,
          );
          return {
            columnId: sc.id,
            name: sc.name,
            status: cell?.status ?? ('not_started' as const),
            assignees,
            assigneeNames,
            note: cell?.note ?? '',
          };
        });

        if (status && !stages.some((s) => s.status === status)) {
          continue;
        }

        if (needle) {
          const textColIds = textColIdsByWs.get(task.worksheetId) ?? [];
          const customTexts = textColIds
            .map((cid) => task.customValues?.[cid] ?? '')
            .filter((v): v is string => Boolean(v));

          const haystacks: string[] = [
            task.title,
            workName ?? '',
            task.divisionNote,
            ...customTexts,
            ...stages.flatMap((s) => [s.note, ...s.assigneeNames]),
          ];

          const hit = haystacks.some((h) => h.toLowerCase().includes(needle));
          if (!hit) continue;
        }

        matched.push({
          taskId: task.id,
          taskTitle: task.title,
          divisionNote: task.divisionNote,
          priority: task.priority,
          publishStatus: task.publishStatus,
          worksheetId: ws.id,
          worksheetName: ws.name,
          worksheetColor: ws.color as WorksheetColor,
          workId: task.workId,
          workName,
          stages,
        });
      }

      const res: SearchResponse = {
        items: matched.slice(offset, offset + limit),
        total: matched.length,
      };
      return res;
    },
  );
}
