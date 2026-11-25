import {
  type ColumnConfig,
  createWorkBodySchema,
  createWorksheetBodySchema,
  generateKeyBetween,
  generateNKeysBetween,
  reorderIdsBodySchema,
  type StageCell,
  type SystemColumnsConfig,
  type TaskDetail,
  updateWorkBodySchema,
  updateWorksheetBodySchema,
  WORKSHEET_TEMPLATES,
  type Work,
  type Worksheet,
  type WorksheetColor,
  type WorksheetFullResponse,
  type WorksheetSummary,
} from '@nw/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { type Db, schema, type Tx } from '../db/index.js';
import { withTx } from '../db/tx.js';
import { AppError, notFound, uniqueViolation } from '../errors.js';
import type { EventBus } from '../realtime/bus.js';
import { toBoardColumnDto } from './board-columns.js';
import { findActiveWorksheet, recordChangeLog } from './change-logs.js';
import { parseBody, parseUuidParam, readOriginConnId } from './helpers.js';

export function toWorksheetDto(row: typeof schema.worksheets.$inferSelect): Worksheet {
  return {
    id: row.id,
    name: row.name,
    color: row.color as WorksheetColor,
    sortOrder: row.sortOrder,
    systemColumns: row.systemColumns ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toColumnConfigDto(row: typeof schema.columnConfigs.$inferSelect): ColumnConfig {
  return {
    id: row.id,
    worksheetId: row.worksheetId,
    name: row.name,
    type: row.type,
    sortOrder: row.sortOrder,
    width: row.width,
    hidden: row.hidden,
    boardColumnId: row.boardColumnId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toWorkDto(row: typeof schema.works.$inferSelect): Work {
  return {
    id: row.id,
    worksheetId: row.worksheetId,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toStageCellDto(row: typeof schema.stageCells.$inferSelect): StageCell {
  return {
    id: row.id,
    taskId: row.taskId,
    columnId: row.columnId,
    assignees: row.assignees ?? [],
    status: row.status,
    note: row.note,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toTaskDetailDto(
  row: typeof schema.tasks.$inferSelect,
  stageCellsMap: Record<string, StageCell> = {},
): TaskDetail {
  return {
    id: row.id,
    worksheetId: row.worksheetId,
    workId: row.workId,
    title: row.title,
    divisionNote: row.divisionNote,
    priority: row.priority,
    publishStatus: row.publishStatus,
    publishedAt: row.publishedAt,
    publishUrl: row.publishUrl,
    customValues: row.customValues ?? {},
    sortOrder: row.sortOrder,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    stageCells: stageCellsMap,
  };
}

function mergeSystemColumns(
  prev: SystemColumnsConfig,
  next: SystemColumnsConfig,
): SystemColumnsConfig {
  const out: SystemColumnsConfig = { ...prev };
  if (next.title) {
    out.title = { ...prev.title, ...next.title };
  }
  const keys = ['work', 'divisionNote', 'priority', 'publish', 'files'] as const;
  for (const k of keys) {
    if (next[k]) {
      out[k] = { ...prev[k], ...next[k] };
    }
  }
  return out;
}

export async function listWorksheetSummaries(
  db: Db | Tx,
  projectId: string,
): Promise<WorksheetSummary[]> {
  const wsRows = await db
    .select()
    .from(schema.worksheets)
    .where(and(eq(schema.worksheets.projectId, projectId), isNull(schema.worksheets.deletedAt)))
    .orderBy(asc(schema.worksheets.sortOrder), asc(schema.worksheets.id));

  if (wsRows.length === 0) return [];

  const counts = await db
    .select({
      worksheetId: schema.tasks.worksheetId,
      total: sql<number>`count(*)::int`,
      unpublished: sql<number>`count(*) FILTER (WHERE ${schema.tasks.publishStatus} = 'unpublished')::int`,
    })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.projectId, projectId), isNull(schema.tasks.deletedAt)))
    .groupBy(schema.tasks.worksheetId);

  const countMap = new Map(counts.map((c) => [c.worksheetId, c]));
  return wsRows.map((ws) => {
    const c = countMap.get(ws.id);
    return {
      ...toWorksheetDto(ws),
      totalTaskCount: c?.total ?? 0,
      unpublishedTaskCount: c?.unpublished ?? 0,
    };
  });
}

export function registerWorksheetRoutes(
  app: FastifyInstance,
  deps: { db: Db; bus: EventBus },
): void {
  const { db, bus } = deps;

  // GET /api/worksheets
  app.get('/api/worksheets', { config: { access: 'authenticated' } }, async (request) => {
    const auth = request.auth!;
    return listWorksheetSummaries(db, auth.projectId);
  });

  // POST /api/worksheets
  app.post(
    '/api/worksheets',
    { config: { access: { permission: 'worksheets.manage' } } },
    async (request, reply) => {
      const auth = request.auth!;
      const body = parseBody(createWorksheetBodySchema, request.body);
      const originConnId = readOriginConnId(request);

      try {
        const { result } = await withTx(
          db,
          bus,
          { projectId: auth.projectId, userId: auth.userId, originConnId },
          async ({ tx, emit }) => {
            const existing = await tx
              .select({ sortOrder: schema.worksheets.sortOrder })
              .from(schema.worksheets)
              .where(
                and(
                  eq(schema.worksheets.projectId, auth.projectId),
                  isNull(schema.worksheets.deletedAt),
                ),
              )
              .orderBy(asc(schema.worksheets.sortOrder), asc(schema.worksheets.id));

            const lastKey = existing[existing.length - 1]?.sortOrder ?? null;
            const sortOrder = generateKeyBetween(lastKey, null);

            const [ws] = await tx
              .insert(schema.worksheets)
              .values({
                projectId: auth.projectId,
                name: body.name,
                color: body.color,
                sortOrder,
              })
              .returning();
            if (!ws) throw new AppError('INTERNAL');

            const tmpl =
              WORKSHEET_TEMPLATES.find((t) => t.id === body.template) ?? WORKSHEET_TEMPLATES[0]!;
            const createdColumns: ColumnConfig[] = [];

            if (tmpl.stageNames.length > 0) {
              const boardCols = await tx
                .select()
                .from(schema.boardColumns)
                .where(eq(schema.boardColumns.projectId, auth.projectId));
              const boardByName = new Map(boardCols.map((bc) => [bc.name, bc.id]));
              const usedBoardIds = new Set<string>();
              const colKeys = generateNKeysBetween(null, null, tmpl.stageNames.length);

              const colRows = await tx
                .insert(schema.columnConfigs)
                .values(
                  tmpl.stageNames.map((stageName, i) => {
                    const matchedId = boardByName.get(stageName) ?? null;
                    const boardColumnId =
                      matchedId && !usedBoardIds.has(matchedId) ? matchedId : null;
                    if (boardColumnId) usedBoardIds.add(boardColumnId);
                    return {
                      projectId: auth.projectId,
                      worksheetId: ws.id,
                      name: stageName,
                      type: 'stage' as const,
                      sortOrder: colKeys[i] ?? `a${i}`,
                      width: 160,
                      hidden: false,
                      boardColumnId,
                    };
                  }),
                )
                .returning();

              for (const row of colRows) {
                createdColumns.push(toColumnConfigDto(row));
              }
            }

            await recordChangeLog(tx, {
              projectId: auth.projectId,
              worksheetId: ws.id,
              taskId: null,
              actorUserId: auth.userId,
              action: 'worksheet.created',
              summary: `新建了工作表「${ws.name}」`,
              changes: { name: ws.name, color: ws.color, template: tmpl.id },
            });

            emit({
              scope: { type: 'project', id: auth.projectId },
              type: 'worksheet.changed',
              payload: { worksheetId: ws.id, action: 'created' },
            });

            return { worksheet: toWorksheetDto(ws), columns: createdColumns };
          },
        );
        return reply.code(201).send(result);
      } catch (err) {
        if (uniqueViolation(err) !== null) {
          throw new AppError('CONFLICT', '工作表名称已存在');
        }
        throw err;
      }
    },
  );

  // PUT /api/worksheets/reorder
  app.put(
    '/api/worksheets/reorder',
    { config: { access: { permission: 'worksheets.manage' } } },
    async (request) => {
      const auth = request.auth!;
      const body = parseBody(reorderIdsBodySchema, request.body);
      const originConnId = readOriginConnId(request);

      const { result } = await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          const existing = await tx
            .select({ id: schema.worksheets.id })
            .from(schema.worksheets)
            .where(
              and(
                eq(schema.worksheets.projectId, auth.projectId),
                isNull(schema.worksheets.deletedAt),
              ),
            );

          const uniqueIds = new Set(body.orderedIds);
          if (uniqueIds.size !== body.orderedIds.length || uniqueIds.size !== existing.length) {
            throw new AppError('VALIDATION_FAILED', '排序列表与当前工作表不匹配');
          }
          const existingSet = new Set(existing.map((w) => w.id));
          for (const id of body.orderedIds) {
            if (!existingSet.has(id)) throw notFound();
          }

          const keys = generateNKeysBetween(null, null, body.orderedIds.length);
          const now = new Date();
          for (let i = 0; i < body.orderedIds.length; i++) {
            await tx
              .update(schema.worksheets)
              .set({ sortOrder: keys[i]!, updatedAt: now })
              .where(
                and(
                  eq(schema.worksheets.projectId, auth.projectId),
                  eq(schema.worksheets.id, body.orderedIds[i]!),
                  isNull(schema.worksheets.deletedAt),
                ),
              );
          }

          emit({
            scope: { type: 'project', id: auth.projectId },
            type: 'worksheet.changed',
            payload: { action: 'reordered' },
          });

          return listWorksheetSummaries(tx, auth.projectId);
        },
      );

      return result;
    },
  );

  // GET /api/worksheets/:id
  app.get<{ Params: { id: string } }>(
    '/api/worksheets/:id',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const worksheetId = parseUuidParam(request.params.id);

      const ws = await findActiveWorksheet(db, auth.projectId, worksheetId);
      if (!ws) throw notFound();

      const [colRows, taskRows, cellRows, workRows, boardColRows] = await Promise.all([
        db
          .select()
          .from(schema.columnConfigs)
          .where(
            and(
              eq(schema.columnConfigs.projectId, auth.projectId),
              eq(schema.columnConfigs.worksheetId, worksheetId),
              isNull(schema.columnConfigs.deletedAt),
            ),
          )
          .orderBy(asc(schema.columnConfigs.sortOrder), asc(schema.columnConfigs.id)),
        db
          .select()
          .from(schema.tasks)
          .where(
            and(
              eq(schema.tasks.projectId, auth.projectId),
              eq(schema.tasks.worksheetId, worksheetId),
              isNull(schema.tasks.deletedAt),
            ),
          )
          .orderBy(asc(schema.tasks.sortOrder), asc(schema.tasks.id)),
        db
          .select()
          .from(schema.stageCells)
          .where(
            and(
              eq(schema.stageCells.projectId, auth.projectId),
              eq(schema.stageCells.worksheetId, worksheetId),
            ),
          ),
        db
          .select()
          .from(schema.works)
          .where(
            and(
              eq(schema.works.projectId, auth.projectId),
              eq(schema.works.worksheetId, worksheetId),
            ),
          )
          .orderBy(asc(schema.works.createdAt), asc(schema.works.id)),
        db
          .select()
          .from(schema.boardColumns)
          .where(eq(schema.boardColumns.projectId, auth.projectId))
          .orderBy(asc(schema.boardColumns.sortOrder), asc(schema.boardColumns.id)),
      ]);

      const activeColIds = new Set(colRows.map((c) => c.id));
      const cellsByTask = new Map<string, Record<string, StageCell>>();
      for (const cell of cellRows) {
        if (!activeColIds.has(cell.columnId)) continue;
        let map = cellsByTask.get(cell.taskId);
        if (!map) {
          map = {};
          cellsByTask.set(cell.taskId, map);
        }
        map[cell.columnId] = toStageCellDto(cell);
      }

      // 仅返回至少有 1 条未删任务的作品（空作品自动隐藏）
      const activeWorkIds = new Set(
        taskRows.map((t) => t.workId).filter((id): id is string => id !== null),
      );
      const visibleWorks = workRows.filter((w) => activeWorkIds.has(w.id)).map(toWorkDto);

      const res: WorksheetFullResponse = {
        worksheet: toWorksheetDto(ws),
        columns: colRows.map(toColumnConfigDto),
        works: visibleWorks,
        tasks: taskRows.map((t) => toTaskDetailDto(t, cellsByTask.get(t.id) ?? {})),
        boardColumns: boardColRows.map(toBoardColumnDto),
      };
      return res;
    },
  );

  // PATCH /api/worksheets/:id
  app.patch<{ Params: { id: string } }>(
    '/api/worksheets/:id',
    { config: { access: { permission: 'worksheets.manage' } } },
    async (request) => {
      const auth = request.auth!;
      const worksheetId = parseUuidParam(request.params.id);
      const body = parseBody(updateWorksheetBodySchema, request.body);
      const originConnId = readOriginConnId(request);

      try {
        const { result } = await withTx(
          db,
          bus,
          { projectId: auth.projectId, userId: auth.userId, originConnId },
          async ({ tx, emit }) => {
            const existing = await findActiveWorksheet(tx, auth.projectId, worksheetId);
            if (!existing) throw notFound();

            const nextName = body.name ?? existing.name;
            const nextColor = body.color ?? existing.color;
            const nextSystemColumns = body.systemColumns
              ? mergeSystemColumns(existing.systemColumns ?? {}, body.systemColumns)
              : (existing.systemColumns ?? {});

            const diffs: Array<{ field: string; label: string; from: unknown; to: unknown }> = [];
            if (nextName !== existing.name) {
              diffs.push({ field: 'name', label: '工作表名称', from: existing.name, to: nextName });
            }
            if (nextColor !== existing.color) {
              diffs.push({
                field: 'color',
                label: '标签颜色',
                from: existing.color,
                to: nextColor,
              });
            }
            if (
              JSON.stringify(nextSystemColumns) !== JSON.stringify(existing.systemColumns ?? {})
            ) {
              diffs.push({
                field: 'systemColumns',
                label: '固定列配置',
                from: existing.systemColumns ?? {},
                to: nextSystemColumns,
              });
            }

            if (diffs.length === 0) {
              return toWorksheetDto(existing);
            }

            const [updated] = await tx
              .update(schema.worksheets)
              .set({
                name: nextName,
                color: nextColor,
                systemColumns: nextSystemColumns,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(schema.worksheets.projectId, auth.projectId),
                  eq(schema.worksheets.id, worksheetId),
                  isNull(schema.worksheets.deletedAt),
                ),
              )
              .returning();
            if (!updated) throw notFound();

            const dto = toWorksheetDto(updated);

            await recordChangeLog(tx, {
              projectId: auth.projectId,
              worksheetId: updated.id,
              taskId: null,
              actorUserId: auth.userId,
              action: 'worksheet.updated',
              summary: `修改了工作表「${updated.name}」的${diffs.map((d) => d.label).join('、')}`,
              changes: { name: updated.name, diffs },
            });

            emit({
              scope: { type: 'worksheet', id: updated.id },
              type: 'worksheet.updated',
              payload: { worksheet: dto },
            });
            emit({
              scope: { type: 'project', id: auth.projectId },
              type: 'worksheet.changed',
              payload: { worksheetId: updated.id, action: 'updated' },
            });

            return dto;
          },
        );
        return result;
      } catch (err) {
        if (uniqueViolation(err) !== null) {
          throw new AppError('CONFLICT', '工作表名称已存在');
        }
        throw err;
      }
    },
  );

  // DELETE /api/worksheets/:id
  app.delete<{ Params: { id: string } }>(
    '/api/worksheets/:id',
    { config: { access: { permission: 'worksheets.manage' } } },
    async (request, reply) => {
      const auth = request.auth!;
      const worksheetId = parseUuidParam(request.params.id);
      const originConnId = readOriginConnId(request);

      await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          const existing = await findActiveWorksheet(tx, auth.projectId, worksheetId);
          if (!existing) throw notFound();

          const now = new Date();
          await tx
            .update(schema.worksheets)
            .set({ deletedAt: now, updatedAt: now })
            .where(
              and(
                eq(schema.worksheets.projectId, auth.projectId),
                eq(schema.worksheets.id, worksheetId),
              ),
            );

          await recordChangeLog(tx, {
            projectId: auth.projectId,
            worksheetId: existing.id,
            taskId: null,
            actorUserId: auth.userId,
            action: 'worksheet.deleted',
            summary: `删除了工作表「${existing.name}」`,
            changes: { name: existing.name },
          });

          emit({
            scope: { type: 'worksheet', id: existing.id },
            type: 'worksheet.deleted',
            payload: { worksheetId: existing.id },
          });
          emit({
            scope: { type: 'project', id: auth.projectId },
            type: 'worksheet.changed',
            payload: { worksheetId: existing.id, action: 'deleted' },
          });
          emit({
            scope: { type: 'project', id: auth.projectId },
            type: 'board.task_changed',
            payload: { worksheetId: existing.id, action: 'worksheet.deleted' },
          });
        },
      );

      return reply.code(204).send();
    },
  );

  // POST /api/worksheets/:worksheetId/works
  app.post<{ Params: { worksheetId: string } }>(
    '/api/worksheets/:worksheetId/works',
    { config: { access: 'authenticated' } },
    async (request, reply) => {
      const auth = request.auth!;
      const worksheetId = parseUuidParam(request.params.worksheetId);
      const body = parseBody(createWorkBodySchema, request.body);

      const ws = await findActiveWorksheet(db, auth.projectId, worksheetId);
      if (!ws) throw notFound();

      // 幂等查找或创建
      const [existing] = await db
        .select()
        .from(schema.works)
        .where(
          and(
            eq(schema.works.projectId, auth.projectId),
            eq(schema.works.worksheetId, worksheetId),
            eq(schema.works.name, body.name),
          ),
        )
        .limit(1);
      if (existing) {
        return reply.code(201).send(toWorkDto(existing));
      }

      try {
        const [created] = await db
          .insert(schema.works)
          .values({
            projectId: auth.projectId,
            worksheetId,
            name: body.name,
          })
          .returning();
        if (!created) throw new AppError('INTERNAL');
        return reply.code(201).send(toWorkDto(created));
      } catch (err) {
        if (uniqueViolation(err) !== null) {
          const [again] = await db
            .select()
            .from(schema.works)
            .where(
              and(
                eq(schema.works.projectId, auth.projectId),
                eq(schema.works.worksheetId, worksheetId),
                eq(schema.works.name, body.name),
              ),
            )
            .limit(1);
          if (again) return reply.code(201).send(toWorkDto(again));
        }
        throw err;
      }
    },
  );

  // PATCH /api/worksheets/:worksheetId/works/:workId
  app.patch<{ Params: { worksheetId: string; workId: string } }>(
    '/api/worksheets/:worksheetId/works/:workId',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const worksheetId = parseUuidParam(request.params.worksheetId);
      const workId = parseUuidParam(request.params.workId);
      const body = parseBody(updateWorkBodySchema, request.body);
      const originConnId = readOriginConnId(request);

      try {
        const { result } = await withTx(
          db,
          bus,
          { projectId: auth.projectId, userId: auth.userId, originConnId },
          async ({ tx, emit }) => {
            const ws = await findActiveWorksheet(tx, auth.projectId, worksheetId);
            if (!ws) throw notFound();

            const [existing] = await tx
              .select()
              .from(schema.works)
              .where(
                and(
                  eq(schema.works.projectId, auth.projectId),
                  eq(schema.works.worksheetId, worksheetId),
                  eq(schema.works.id, workId),
                ),
              )
              .limit(1);
            if (!existing) throw notFound();

            const [updated] = await tx
              .update(schema.works)
              .set({ name: body.name, updatedAt: new Date() })
              .where(
                and(
                  eq(schema.works.projectId, auth.projectId),
                  eq(schema.works.worksheetId, worksheetId),
                  eq(schema.works.id, workId),
                ),
              )
              .returning();
            if (!updated) throw notFound();

            const dto = toWorkDto(updated);

            if (existing.name !== updated.name) {
              emit({
                scope: { type: 'worksheet', id: worksheetId },
                type: 'work.updated',
                payload: { work: dto },
              });
              emit({
                scope: { type: 'project', id: auth.projectId },
                type: 'board.task_changed',
                payload: { worksheetId, action: 'work.updated' },
              });
            }

            return dto;
          },
        );
        return result;
      } catch (err) {
        if (uniqueViolation(err) !== null) {
          throw new AppError('CONFLICT', '该作品名已存在');
        }
        throw err;
      }
    },
  );
}
