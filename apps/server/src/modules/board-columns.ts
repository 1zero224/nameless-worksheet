import {
  type BoardColumn,
  createBoardColumnBodySchema,
  generateKeyBetween,
  generateNKeysBetween,
  reorderIdsBodySchema,
  updateBoardColumnBodySchema,
} from '@nw/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { type Db, schema } from '../db/index.js';
import { withTx } from '../db/tx.js';
import { AppError, notFound, uniqueViolation } from '../errors.js';
import type { EventBus } from '../realtime/bus.js';
import { recordChangeLog } from './change-logs.js';
import { parseBody, parseUuidParam, readOriginConnId } from './helpers.js';

export function toBoardColumnDto(row: typeof schema.boardColumns.$inferSelect): BoardColumn {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function registerBoardColumnRoutes(
  app: FastifyInstance,
  deps: { db: Db; bus: EventBus },
): void {
  const { db, bus } = deps;

  // GET /api/board-columns
  app.get('/api/board-columns', { config: { access: 'authenticated' } }, async (request) => {
    const auth = request.auth!;
    const rows = await db
      .select()
      .from(schema.boardColumns)
      .where(eq(schema.boardColumns.projectId, auth.projectId))
      .orderBy(asc(schema.boardColumns.sortOrder), asc(schema.boardColumns.id));
    return rows.map(toBoardColumnDto);
  });

  // POST /api/board-columns
  app.post(
    '/api/board-columns',
    { config: { access: { permission: 'worksheets.manage' } } },
    async (request, reply) => {
      const auth = request.auth!;
      const body = parseBody(createBoardColumnBodySchema, request.body);
      const originConnId = readOriginConnId(request);

      try {
        const { result } = await withTx(
          db,
          bus,
          { projectId: auth.projectId, userId: auth.userId, originConnId },
          async ({ tx, emit }) => {
            const existing = await tx
              .select({ sortOrder: schema.boardColumns.sortOrder })
              .from(schema.boardColumns)
              .where(eq(schema.boardColumns.projectId, auth.projectId))
              .orderBy(asc(schema.boardColumns.sortOrder), asc(schema.boardColumns.id));

            const lastKey = existing[existing.length - 1]?.sortOrder ?? null;
            const sortOrder = generateKeyBetween(lastKey, null);

            const [created] = await tx
              .insert(schema.boardColumns)
              .values({
                projectId: auth.projectId,
                name: body.name,
                sortOrder,
              })
              .returning();

            if (!created) throw new AppError('INTERNAL');

            await recordChangeLog(tx, {
              projectId: auth.projectId,
              worksheetId: null,
              taskId: null,
              actorUserId: auth.userId,
              action: 'board_column.updated',
              summary: `新增了看板列「${created.name}」`,
              changes: { detail: { action: 'created', id: created.id, name: created.name } },
            });

            emit({
              scope: { type: 'project', id: auth.projectId },
              type: 'board_columns.changed',
              payload: { action: 'created' },
            });

            return toBoardColumnDto(created);
          },
        );
        return reply.code(201).send(result);
      } catch (err) {
        if (uniqueViolation(err) !== null) {
          throw new AppError('CONFLICT', '该看板列名称已存在');
        }
        throw err;
      }
    },
  );

  // PATCH /api/board-columns/:id
  app.patch<{ Params: { id: string } }>(
    '/api/board-columns/:id',
    { config: { access: { permission: 'worksheets.manage' } } },
    async (request) => {
      const auth = request.auth!;
      const id = parseUuidParam(request.params.id);
      const body = parseBody(updateBoardColumnBodySchema, request.body);
      const originConnId = readOriginConnId(request);

      try {
        const { result } = await withTx(
          db,
          bus,
          { projectId: auth.projectId, userId: auth.userId, originConnId },
          async ({ tx, emit }) => {
            const [existing] = await tx
              .select()
              .from(schema.boardColumns)
              .where(
                and(
                  eq(schema.boardColumns.projectId, auth.projectId),
                  eq(schema.boardColumns.id, id),
                ),
              )
              .limit(1);

            if (!existing) throw notFound();

            const [updated] = await tx
              .update(schema.boardColumns)
              .set({ name: body.name, updatedAt: new Date() })
              .where(
                and(
                  eq(schema.boardColumns.projectId, auth.projectId),
                  eq(schema.boardColumns.id, id),
                ),
              )
              .returning();

            if (!updated) throw notFound();

            if (existing.name !== updated.name) {
              await recordChangeLog(tx, {
                projectId: auth.projectId,
                worksheetId: null,
                taskId: null,
                actorUserId: auth.userId,
                action: 'board_column.updated',
                summary: `将看板列「${existing.name}」改名为「${updated.name}」`,
                changes: {
                  detail: {
                    action: 'updated',
                    id: updated.id,
                    from: existing.name,
                    to: updated.name,
                  },
                },
              });

              emit({
                scope: { type: 'project', id: auth.projectId },
                type: 'board_columns.changed',
                payload: { action: 'updated' },
              });
            }

            return toBoardColumnDto(updated);
          },
        );
        return result;
      } catch (err) {
        if (uniqueViolation(err) !== null) {
          throw new AppError('CONFLICT', '该看板列名称已存在');
        }
        throw err;
      }
    },
  );

  // DELETE /api/board-columns/:id
  app.delete<{ Params: { id: string } }>(
    '/api/board-columns/:id',
    { config: { access: { permission: 'worksheets.manage' } } },
    async (request, reply) => {
      const auth = request.auth!;
      const id = parseUuidParam(request.params.id);
      const originConnId = readOriginConnId(request);

      await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          const [deleted] = await tx
            .delete(schema.boardColumns)
            .where(
              and(
                eq(schema.boardColumns.projectId, auth.projectId),
                eq(schema.boardColumns.id, id),
              ),
            )
            .returning();

          if (!deleted) throw notFound();

          await recordChangeLog(tx, {
            projectId: auth.projectId,
            worksheetId: null,
            taskId: null,
            actorUserId: auth.userId,
            action: 'board_column.updated',
            summary: `删除了看板列「${deleted.name}」`,
            changes: { detail: { action: 'deleted', id: deleted.id, name: deleted.name } },
          });

          emit({
            scope: { type: 'project', id: auth.projectId },
            type: 'board_columns.changed',
            payload: { action: 'deleted' },
          });
        },
      );

      return reply.code(204).send();
    },
  );

  // PUT /api/board-columns/reorder
  app.put(
    '/api/board-columns/reorder',
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
            .select()
            .from(schema.boardColumns)
            .where(eq(schema.boardColumns.projectId, auth.projectId))
            .orderBy(asc(schema.boardColumns.sortOrder), asc(schema.boardColumns.id));

          const uniqueIds = new Set(body.orderedIds);
          if (uniqueIds.size !== body.orderedIds.length || uniqueIds.size !== existing.length) {
            throw new AppError('VALIDATION_FAILED', '排序列表与当前看板列不匹配');
          }
          const existingMap = new Map(existing.map((c) => [c.id, c]));
          for (const id of body.orderedIds) {
            if (!existingMap.has(id)) {
              throw notFound();
            }
          }

          const newKeys = generateNKeysBetween(null, null, body.orderedIds.length);
          const now = new Date();
          const out: BoardColumn[] = [];

          for (let i = 0; i < body.orderedIds.length; i++) {
            const colId = body.orderedIds[i]!;
            const sortOrder = newKeys[i]!;
            const [updated] = await tx
              .update(schema.boardColumns)
              .set({ sortOrder, updatedAt: now })
              .where(
                and(
                  eq(schema.boardColumns.projectId, auth.projectId),
                  eq(schema.boardColumns.id, colId),
                ),
              )
              .returning();
            if (updated) out.push(toBoardColumnDto(updated));
          }

          await recordChangeLog(tx, {
            projectId: auth.projectId,
            worksheetId: null,
            taskId: null,
            actorUserId: auth.userId,
            action: 'board_column.updated',
            summary: '调整了看板列顺序',
            changes: { detail: { action: 'reordered', orderedIds: body.orderedIds } },
          });

          emit({
            scope: { type: 'project', id: auth.projectId },
            type: 'board_columns.changed',
            payload: { action: 'reordered' },
          });

          return out;
        },
      );

      return result;
    },
  );
}
