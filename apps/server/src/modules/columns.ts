import {
  type ColumnConfig,
  createColumnBodySchema,
  generateKeyBetween,
  generateNKeysBetween,
  reorderIdsBodySchema,
  updateColumnBodySchema,
} from '@nw/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { type Db, schema } from '../db/index.js';
import { withTx } from '../db/tx.js';
import { AppError, notFound, uniqueViolation } from '../errors.js';
import type { EventBus } from '../realtime/bus.js';
import { emitArtifactChanged } from './artifacts.js';
import { findActiveWorksheet, recordChangeLog } from './change-logs.js';
import { ascC, parseBody, parseUuidParam, readOriginConnId } from './helpers.js';
import { toColumnConfigDto } from './worksheets.js';

function mapColumnUniqueError(err: unknown): AppError | null {
  const constraint = uniqueViolation(err);
  if (constraint === null) return null;
  if (constraint.includes('board_col')) {
    return new AppError('CONFLICT', '该看板列已绑定到其他工序列');
  }
  return new AppError('CONFLICT', '该列名已存在');
}

export function registerColumnRoutes(app: FastifyInstance, deps: { db: Db; bus: EventBus }): void {
  const { db, bus } = deps;

  // POST /api/worksheets/:worksheetId/columns
  app.post<{ Params: { worksheetId: string } }>(
    '/api/worksheets/:worksheetId/columns',
    { config: { access: { permission: 'worksheets.manage' } } },
    async (request, reply) => {
      const auth = request.auth!;
      const worksheetId = parseUuidParam(request.params.worksheetId);
      const body = parseBody(createColumnBodySchema, request.body);
      const originConnId = readOriginConnId(request);

      if (body.type !== 'stage' && body.boardColumnId) {
        throw new AppError('VALIDATION_FAILED', '仅工序列可映射到看板列');
      }

      try {
        const { result } = await withTx(
          db,
          bus,
          { projectId: auth.projectId, userId: auth.userId, originConnId },
          async ({ tx, emit }) => {
            const ws = await findActiveWorksheet(tx, auth.projectId, worksheetId);
            if (!ws) throw notFound();

            if (ws.kind === 'free' && body.type === 'stage') {
              throw new AppError('VALIDATION_FAILED', '自由表格不支持新增工序列');
            }

            const existingCols = await tx
              .select()
              .from(schema.columnConfigs)
              .where(
                and(
                  eq(schema.columnConfigs.projectId, auth.projectId),
                  eq(schema.columnConfigs.worksheetId, worksheetId),
                  isNull(schema.columnConfigs.deletedAt),
                ),
              )
              .orderBy(ascC(schema.columnConfigs.sortOrder), asc(schema.columnConfigs.id));

            let boardColumnId: string | null = null;
            if (body.type === 'stage') {
              if (body.boardColumnId !== undefined) {
                if (body.boardColumnId !== null) {
                  const [bc] = await tx
                    .select({ id: schema.boardColumns.id })
                    .from(schema.boardColumns)
                    .where(
                      and(
                        eq(schema.boardColumns.projectId, auth.projectId),
                        eq(schema.boardColumns.id, body.boardColumnId),
                      ),
                    )
                    .limit(1);
                  if (!bc) throw notFound();
                  boardColumnId = bc.id;
                }
              } else {
                // 未显式传 boardColumnId 时按名称自动匹配未被本表占用的看板列
                const [bc] = await tx
                  .select({ id: schema.boardColumns.id })
                  .from(schema.boardColumns)
                  .where(
                    and(
                      eq(schema.boardColumns.projectId, auth.projectId),
                      eq(schema.boardColumns.name, body.name),
                    ),
                  )
                  .limit(1);
                if (bc && !existingCols.some((c) => c.boardColumnId === bc.id)) {
                  boardColumnId = bc.id;
                }
              }
            }

            const lastKey = existingCols[existingCols.length - 1]?.sortOrder ?? null;
            const sortOrder = generateKeyBetween(lastKey, null);
            const width = body.width ?? (body.type === 'stage' ? 160 : 150);

            const [created] = await tx
              .insert(schema.columnConfigs)
              .values({
                projectId: auth.projectId,
                worksheetId,
                name: body.name,
                type: body.type,
                sortOrder,
                width,
                hidden: false,
                boardColumnId,
              })
              .returning();
            if (!created) throw new AppError('INTERNAL');

            const dto = toColumnConfigDto(created);

            await recordChangeLog(tx, {
              projectId: auth.projectId,
              worksheetId,
              taskId: null,
              actorUserId: auth.userId,
              action: 'column.created',
              summary: `新增了列「${created.name}」`,
              changes: { columnId: created.id, name: created.name, type: created.type },
            });

            emit({
              scope: { type: 'worksheet', id: worksheetId },
              type: 'column.changed',
              payload: { action: 'created', column: dto },
            });
            if (created.type === 'stage') {
              emit({
                scope: { type: 'project', id: auth.projectId },
                type: 'board.task_changed',
                payload: { worksheetId, action: 'column.created' },
              });
            }

            return dto;
          },
        );
        return reply.code(201).send(result);
      } catch (err) {
        const mapped = mapColumnUniqueError(err);
        if (mapped) throw mapped;
        throw err;
      }
    },
  );

  // PATCH /api/worksheets/:worksheetId/columns/:columnId
  app.patch<{ Params: { worksheetId: string; columnId: string } }>(
    '/api/worksheets/:worksheetId/columns/:columnId',
    { config: { access: { permission: 'worksheets.manage' } } },
    async (request) => {
      const auth = request.auth!;
      const worksheetId = parseUuidParam(request.params.worksheetId);
      const columnId = parseUuidParam(request.params.columnId);
      const body = parseBody(updateColumnBodySchema, request.body);
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
              .from(schema.columnConfigs)
              .where(
                and(
                  eq(schema.columnConfigs.projectId, auth.projectId),
                  eq(schema.columnConfigs.worksheetId, worksheetId),
                  eq(schema.columnConfigs.id, columnId),
                  isNull(schema.columnConfigs.deletedAt),
                ),
              )
              .limit(1);
            if (!existing) throw notFound();

            if (existing.type !== 'stage' && body.boardColumnId) {
              throw new AppError('VALIDATION_FAILED', '仅工序列可映射到看板列');
            }

            if (body.boardColumnId) {
              const [bc] = await tx
                .select({ id: schema.boardColumns.id })
                .from(schema.boardColumns)
                .where(
                  and(
                    eq(schema.boardColumns.projectId, auth.projectId),
                    eq(schema.boardColumns.id, body.boardColumnId),
                  ),
                )
                .limit(1);
              if (!bc) throw notFound();
            }

            const nextName = body.name ?? existing.name;
            const nextWidth = body.width ?? existing.width;
            const nextHidden = body.hidden ?? existing.hidden;
            const nextBoardColumnId =
              body.boardColumnId !== undefined ? body.boardColumnId : existing.boardColumnId;

            const diffs: Array<{ field: string; label: string; from: unknown; to: unknown }> = [];
            if (nextName !== existing.name) {
              diffs.push({ field: 'name', label: '列名', from: existing.name, to: nextName });
            }
            if (nextWidth !== existing.width) {
              diffs.push({ field: 'width', label: '列宽', from: existing.width, to: nextWidth });
            }
            if (nextHidden !== existing.hidden) {
              diffs.push({
                field: 'hidden',
                label: '显示状态',
                from: existing.hidden,
                to: nextHidden,
              });
            }
            if (nextBoardColumnId !== existing.boardColumnId) {
              diffs.push({
                field: 'boardColumnId',
                label: '看板列映射',
                from: existing.boardColumnId,
                to: nextBoardColumnId,
              });
            }

            if (diffs.length === 0) {
              return toColumnConfigDto(existing);
            }

            const [updated] = await tx
              .update(schema.columnConfigs)
              .set({
                name: nextName,
                width: nextWidth,
                hidden: nextHidden,
                boardColumnId: nextBoardColumnId,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(schema.columnConfigs.projectId, auth.projectId),
                  eq(schema.columnConfigs.worksheetId, worksheetId),
                  eq(schema.columnConfigs.id, columnId),
                ),
              )
              .returning();
            if (!updated) throw notFound();

            const dto = toColumnConfigDto(updated);

            await recordChangeLog(tx, {
              projectId: auth.projectId,
              worksheetId,
              taskId: null,
              actorUserId: auth.userId,
              action: 'column.updated',
              summary: `修改了列「${updated.name}」的${diffs.map((d) => d.label).join('、')}`,
              changes: { columnId: updated.id, name: updated.name, diffs },
            });

            emit({
              scope: { type: 'worksheet', id: worksheetId },
              type: 'column.changed',
              payload: { action: 'updated', column: dto },
            });
            if (
              existing.type === 'stage' &&
              (nextBoardColumnId !== existing.boardColumnId || nextName !== existing.name)
            ) {
              emit({
                scope: { type: 'project', id: auth.projectId },
                type: 'board.task_changed',
                payload: { worksheetId, action: 'column.updated' },
              });
            }

            return dto;
          },
        );
        return result;
      } catch (err) {
        const mapped = mapColumnUniqueError(err);
        if (mapped) throw mapped;
        throw err;
      }
    },
  );

  // DELETE /api/worksheets/:worksheetId/columns/:columnId
  app.delete<{ Params: { worksheetId: string; columnId: string } }>(
    '/api/worksheets/:worksheetId/columns/:columnId',
    { config: { access: { permission: 'worksheets.manage' } } },
    async (request, reply) => {
      const auth = request.auth!;
      const worksheetId = parseUuidParam(request.params.worksheetId);
      const columnId = parseUuidParam(request.params.columnId);
      const originConnId = readOriginConnId(request);

      await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          const ws = await findActiveWorksheet(tx, auth.projectId, worksheetId);
          if (!ws) throw notFound();

          const now = new Date();
          const [deleted] = await tx
            .update(schema.columnConfigs)
            .set({ deletedAt: now, updatedAt: now })
            .where(
              and(
                eq(schema.columnConfigs.projectId, auth.projectId),
                eq(schema.columnConfigs.worksheetId, worksheetId),
                eq(schema.columnConfigs.id, columnId),
                isNull(schema.columnConfigs.deletedAt),
              ),
            )
            .returning();
          if (!deleted) throw notFound();

          let demotedArtifactIds: string[] = [];
          if (deleted.type === 'stage') {
            const demotedRows = await tx
              .update(schema.artifacts)
              .set({ stageColumnId: null, updatedAt: now })
              .where(
                and(
                  eq(schema.artifacts.projectId, auth.projectId),
                  eq(schema.artifacts.worksheetId, worksheetId),
                  eq(schema.artifacts.stageColumnId, columnId),
                  isNull(schema.artifacts.deletedAt),
                ),
              )
              .returning({ id: schema.artifacts.id });
            demotedArtifactIds = demotedRows.map((r) => r.id);
          }

          const demotedCount = demotedArtifactIds.length;
          await recordChangeLog(tx, {
            projectId: auth.projectId,
            worksheetId,
            taskId: null,
            actorUserId: auth.userId,
            action: 'column.deleted',
            summary:
              demotedCount > 0
                ? `删除了列「${deleted.name}」（已将 ${demotedCount} 个工序资源转为任务级资源）`
                : `删除了列「${deleted.name}」`,
            changes: {
              columnId: deleted.id,
              name: deleted.name,
              type: deleted.type,
              ...(demotedCount > 0 ? { demotedArtifactCount: demotedCount } : {}),
            },
          });

          emit({
            scope: { type: 'worksheet', id: worksheetId },
            type: 'column.changed',
            payload: { action: 'deleted', columnId: deleted.id },
          });
          if (demotedCount > 0) {
            emitArtifactChanged(emit, auth.projectId, {
              scopeKind: 'task',
              action: 'artifact.moved',
              artifactId: demotedArtifactIds[0]!,
              worksheetId,
              workId: null,
              taskId: null,
              stageColumnId: null,
            });
          }
          emit({
            scope: { type: 'project', id: auth.projectId },
            type: 'board.task_changed',
            payload: { worksheetId, action: 'column.deleted' },
          });
        },
      );

      return reply.code(204).send();
    },
  );

  // PUT /api/worksheets/:worksheetId/columns/reorder
  app.put<{ Params: { worksheetId: string } }>(
    '/api/worksheets/:worksheetId/columns/reorder',
    { config: { access: { permission: 'worksheets.manage' } } },
    async (request) => {
      const auth = request.auth!;
      const worksheetId = parseUuidParam(request.params.worksheetId);
      const body = parseBody(reorderIdsBodySchema, request.body);
      const originConnId = readOriginConnId(request);

      const { result } = await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          const ws = await findActiveWorksheet(tx, auth.projectId, worksheetId);
          if (!ws) throw notFound();

          const existing = await tx
            .select()
            .from(schema.columnConfigs)
            .where(
              and(
                eq(schema.columnConfigs.projectId, auth.projectId),
                eq(schema.columnConfigs.worksheetId, worksheetId),
                isNull(schema.columnConfigs.deletedAt),
              ),
            );

          const uniqueIds = new Set(body.orderedIds);
          if (uniqueIds.size !== body.orderedIds.length || uniqueIds.size !== existing.length) {
            throw new AppError('VALIDATION_FAILED', '排序列表与当前列不匹配');
          }
          const existingSet = new Set(existing.map((c) => c.id));
          for (const id of body.orderedIds) {
            if (!existingSet.has(id)) throw notFound();
          }

          const keys = generateNKeysBetween(null, null, body.orderedIds.length);
          const now = new Date();
          const out: ColumnConfig[] = [];
          for (let i = 0; i < body.orderedIds.length; i++) {
            const [updated] = await tx
              .update(schema.columnConfigs)
              .set({ sortOrder: keys[i]!, updatedAt: now })
              .where(
                and(
                  eq(schema.columnConfigs.projectId, auth.projectId),
                  eq(schema.columnConfigs.worksheetId, worksheetId),
                  eq(schema.columnConfigs.id, body.orderedIds[i]!),
                ),
              )
              .returning();
            if (updated) out.push(toColumnConfigDto(updated));
          }

          emit({
            scope: { type: 'worksheet', id: worksheetId },
            type: 'column.changed',
            payload: { action: 'reordered', columns: out },
          });
          emit({
            scope: { type: 'project', id: auth.projectId },
            type: 'board.task_changed',
            payload: { worksheetId, action: 'column.reordered' },
          });

          return out;
        },
      );

      return result;
    },
  );
}
