import {
  type Assignee,
  makeDefaultStageCell,
  normalizeText,
  patchStageCellBodySchema,
  STAGE_STATUS_LABELS,
  type StageAssigneeStatsResponse,
  type StageCell,
} from '@nw/shared';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { type Db, schema, type Tx } from '../db/index.js';
import { withTx } from '../db/tx.js';
import { AppError, notFound } from '../errors.js';
import type { EventBus } from '../realtime/bus.js';
import { findActiveWorksheet, recordChangeLog } from './change-logs.js';
import { parseBody, parseUuidParam, readOriginConnId } from './helpers.js';
import { toStageCellDto } from './worksheets.js';

async function validateAssigneesInProject(
  tx: Tx,
  projectId: string,
  assignees: Assignee[],
): Promise<void> {
  const userIds = [...new Set(assignees.filter((a) => a.type === 'user').map((a) => a.userId))];
  if (userIds.length === 0) return;

  const found = await tx
    .select({ userId: schema.memberships.userId })
    .from(schema.memberships)
    .where(
      and(eq(schema.memberships.projectId, projectId), inArray(schema.memberships.userId, userIds)),
    );

  if (found.length !== userIds.length) {
    throw new AppError('VALIDATION_FAILED', '负责人包含不属于当前项目的用户');
  }
}

async function resolveAssigneeNames(tx: Tx, assignees: Assignee[]): Promise<string[]> {
  const userIds = assignees.filter((a) => a.type === 'user').map((a) => a.userId);
  const nameMap = new Map<string, string>();
  if (userIds.length > 0) {
    const rows = await tx
      .select({ id: schema.users.id, displayName: schema.users.displayName })
      .from(schema.users)
      .where(inArray(schema.users.id, userIds));
    for (const r of rows) {
      nameMap.set(r.id, r.displayName);
    }
  }
  return assignees.map((a) => (a.type === 'user' ? (nameMap.get(a.userId) ?? '未知用户') : a.name));
}

async function findLastStageActorName(
  tx: Tx,
  projectId: string,
  taskId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ displayName: schema.users.displayName })
    .from(schema.changeLogs)
    .innerJoin(schema.users, eq(schema.changeLogs.actorUserId, schema.users.id))
    .where(
      and(
        eq(schema.changeLogs.projectId, projectId),
        eq(schema.changeLogs.taskId, taskId),
        eq(schema.changeLogs.action, 'stage.updated'),
      ),
    )
    .orderBy(desc(schema.changeLogs.createdAt), desc(schema.changeLogs.id))
    .limit(1);
  return row?.displayName ?? null;
}

export function registerStageRoutes(app: FastifyInstance, deps: { db: Db; bus: EventBus }): void {
  const { db, bus } = deps;

  // GET /api/stages/assignee-stats
  app.get(
    '/api/stages/assignee-stats',
    { config: { access: 'authenticated' } },
    async (request): Promise<StageAssigneeStatsResponse> => {
      const auth = request.auth!;

      const rows = await db
        .select({
          columnName: schema.columnConfigs.name,
          assignees: schema.stageCells.assignees,
        })
        .from(schema.stageCells)
        .innerJoin(
          schema.columnConfigs,
          and(
            eq(schema.stageCells.columnId, schema.columnConfigs.id),
            eq(schema.columnConfigs.projectId, auth.projectId),
            eq(schema.columnConfigs.type, 'stage'),
            isNull(schema.columnConfigs.deletedAt),
          ),
        )
        .innerJoin(
          schema.tasks,
          and(
            eq(schema.stageCells.taskId, schema.tasks.id),
            eq(schema.tasks.projectId, auth.projectId),
            isNull(schema.tasks.deletedAt),
          ),
        )
        .innerJoin(
          schema.worksheets,
          and(
            eq(schema.stageCells.worksheetId, schema.worksheets.id),
            eq(schema.worksheets.projectId, auth.projectId),
            isNull(schema.worksheets.deletedAt),
          ),
        )
        .where(
          and(
            eq(schema.stageCells.projectId, auth.projectId),
            ne(schema.stageCells.status, 'na'),
            sql`jsonb_array_length(${schema.stageCells.assignees}) > 0`,
          ),
        );

      const byStageName: StageAssigneeStatsResponse['byStageName'] = {};
      for (const row of rows) {
        const stageName = normalizeText(row.columnName);
        if (!stageName) continue;
        let bucket = byStageName[stageName];
        if (!bucket) {
          bucket = { users: {}, texts: {} };
          byStageName[stageName] = bucket;
        }
        for (const a of row.assignees ?? []) {
          if (a.type === 'user') {
            bucket.users[a.userId] = (bucket.users[a.userId] ?? 0) + 1;
          } else {
            const name = normalizeText(a.name);
            if (name) {
              bucket.texts[name] = (bucket.texts[name] ?? 0) + 1;
            }
          }
        }
      }

      return { byStageName };
    },
  );

  // PATCH /api/tasks/:taskId/stages/:columnId
  app.patch<{ Params: { taskId: string; columnId: string } }>(
    '/api/tasks/:taskId/stages/:columnId',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const taskId = parseUuidParam(request.params.taskId);
      const columnId = parseUuidParam(request.params.columnId);
      const body = parseBody(patchStageCellBodySchema, request.body);
      const originConnId = readOriginConnId(request);

      const { result } = await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          // 锁住任务行，防止并发修改同一工序格
          const [task] = await tx
            .select()
            .from(schema.tasks)
            .where(
              and(
                eq(schema.tasks.projectId, auth.projectId),
                eq(schema.tasks.id, taskId),
                isNull(schema.tasks.deletedAt),
              ),
            )
            .for('update')
            .limit(1);
          if (!task) throw notFound();

          const ws = await findActiveWorksheet(tx, auth.projectId, task.worksheetId);
          if (!ws) throw notFound();

          const [col] = await tx
            .select()
            .from(schema.columnConfigs)
            .where(
              and(
                eq(schema.columnConfigs.projectId, auth.projectId),
                eq(schema.columnConfigs.worksheetId, task.worksheetId),
                eq(schema.columnConfigs.id, columnId),
                eq(schema.columnConfigs.type, 'stage'),
                isNull(schema.columnConfigs.deletedAt),
              ),
            )
            .limit(1);
          if (!col) throw notFound();

          if (body.assignees !== undefined) {
            await validateAssigneesInProject(tx, auth.projectId, body.assignees);
          }

          const [existingCell] = await tx
            .select()
            .from(schema.stageCells)
            .where(
              and(
                eq(schema.stageCells.projectId, auth.projectId),
                eq(schema.stageCells.taskId, taskId),
                eq(schema.stageCells.columnId, columnId),
              ),
            )
            .limit(1);

          const currentRevision = existingCell?.revision ?? 0;
          const currentDto: StageCell = existingCell
            ? toStageCellDto(existingCell)
            : makeDefaultStageCell(taskId, columnId);

          if (!body.force && currentRevision !== body.baseRevision) {
            const actorName = await findLastStageActorName(tx, auth.projectId, taskId);
            throw new AppError('FIELD_CONFLICT', '该工序格刚被他人修改', undefined, {
              currentCell: currentDto,
              updatedByDisplayName: actorName,
            });
          }

          const nextAssignees = body.assignees ?? currentDto.assignees;
          const nextStatus = body.status ?? currentDto.status;
          const nextNote = body.note ?? currentDto.note;

          const diffs: Array<{ field: string; label: string; from: unknown; to: unknown }> = [];
          if (JSON.stringify(nextAssignees) !== JSON.stringify(currentDto.assignees)) {
            const [fromNames, toNames] = await Promise.all([
              resolveAssigneeNames(tx, currentDto.assignees),
              resolveAssigneeNames(tx, nextAssignees),
            ]);
            diffs.push({
              field: 'assignees',
              label: '负责人',
              from: fromNames.join('、') || '空',
              to: toNames.join('、') || '空',
            });
          }
          if (nextStatus !== currentDto.status) {
            diffs.push({
              field: 'status',
              label: '状态',
              from: STAGE_STATUS_LABELS[currentDto.status],
              to: STAGE_STATUS_LABELS[nextStatus],
            });
          }
          if (nextNote !== currentDto.note) {
            diffs.push({
              field: 'note',
              label: '备注',
              from: currentDto.note,
              to: nextNote,
            });
          }

          if (diffs.length === 0) {
            return { cell: currentDto };
          }

          const now = new Date();
          const nextRevision = currentRevision + 1;

          const [saved] = await tx
            .insert(schema.stageCells)
            .values({
              projectId: auth.projectId,
              worksheetId: task.worksheetId,
              taskId,
              columnId,
              assignees: nextAssignees,
              status: nextStatus,
              note: nextNote,
              revision: nextRevision,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [schema.stageCells.taskId, schema.stageCells.columnId],
              set: {
                assignees: nextAssignees,
                status: nextStatus,
                note: nextNote,
                revision: nextRevision,
                updatedAt: now,
              },
            })
            .returning();
          if (!saved) throw new AppError('INTERNAL');

          const dto = toStageCellDto(saved);

          await recordChangeLog(tx, {
            projectId: auth.projectId,
            worksheetId: task.worksheetId,
            taskId,
            actorUserId: auth.userId,
            action: 'stage.updated',
            summary: `修改了《${task.title}》的${col.name}${diffs.map((d) => d.label).join('、')}`,
            changes: { columnId, columnName: col.name, diffs },
          });

          emit({
            scope: { type: 'worksheet', id: task.worksheetId },
            type: 'stage.updated',
            payload: {
              taskId,
              columnId,
              cell: dto,
              actorDisplayName: auth.displayName,
            },
          });
          emit({
            scope: { type: 'project', id: auth.projectId },
            type: 'board.task_changed',
            payload: { worksheetId: task.worksheetId, taskId, action: 'stage.updated' },
          });

          return { cell: dto };
        },
      );

      return result;
    },
  );

  // POST /api/tasks/:taskId/stages/:columnId/claim
  app.post<{ Params: { taskId: string; columnId: string } }>(
    '/api/tasks/:taskId/stages/:columnId/claim',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const taskId = parseUuidParam(request.params.taskId);
      const columnId = parseUuidParam(request.params.columnId);
      const originConnId = readOriginConnId(request);

      const { result } = await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          // 锁住任务行，保证并发抢认领严格串行（第 5.3 节）
          const [task] = await tx
            .select()
            .from(schema.tasks)
            .where(
              and(
                eq(schema.tasks.projectId, auth.projectId),
                eq(schema.tasks.id, taskId),
                isNull(schema.tasks.deletedAt),
              ),
            )
            .for('update')
            .limit(1);
          if (!task) throw notFound();

          const ws = await findActiveWorksheet(tx, auth.projectId, task.worksheetId);
          if (!ws) throw notFound();

          const [col] = await tx
            .select()
            .from(schema.columnConfigs)
            .where(
              and(
                eq(schema.columnConfigs.projectId, auth.projectId),
                eq(schema.columnConfigs.worksheetId, task.worksheetId),
                eq(schema.columnConfigs.id, columnId),
                eq(schema.columnConfigs.type, 'stage'),
                isNull(schema.columnConfigs.deletedAt),
              ),
            )
            .limit(1);
          if (!col) throw notFound();

          const [existingCell] = await tx
            .select()
            .from(schema.stageCells)
            .where(
              and(
                eq(schema.stageCells.projectId, auth.projectId),
                eq(schema.stageCells.taskId, taskId),
                eq(schema.stageCells.columnId, columnId),
              ),
            )
            .limit(1);

          const curStatus = existingCell?.status ?? 'not_started';
          const curAssignees = existingCell?.assignees ?? [];

          if (curStatus === 'done' || curStatus === 'na') {
            throw new AppError('CONFLICT', '该工序无需认领');
          }

          if (curAssignees.length > 0) {
            const names = await resolveAssigneeNames(tx, curAssignees);
            const firstName = names[0] ?? '他人';
            throw new AppError('STAGE_ALREADY_CLAIMED', `该工序已被 ${firstName} 认领`);
          }

          const now = new Date();
          const nextRevision = (existingCell?.revision ?? 0) + 1;
          const nextAssignees: Assignee[] = [{ type: 'user', userId: auth.userId }];

          const [saved] = await tx
            .insert(schema.stageCells)
            .values({
              projectId: auth.projectId,
              worksheetId: task.worksheetId,
              taskId,
              columnId,
              assignees: nextAssignees,
              status: curStatus, // 保持原状态不变（通常为 not_started）
              note: existingCell?.note ?? '',
              revision: nextRevision,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [schema.stageCells.taskId, schema.stageCells.columnId],
              set: {
                assignees: nextAssignees,
                revision: nextRevision,
                updatedAt: now,
              },
            })
            .returning();
          if (!saved) throw new AppError('INTERNAL');

          const dto = toStageCellDto(saved);

          await recordChangeLog(tx, {
            projectId: auth.projectId,
            worksheetId: task.worksheetId,
            taskId,
            actorUserId: auth.userId,
            action: 'stage.updated',
            summary: `认领了《${task.title}》的${col.name}`,
            changes: {
              columnId,
              columnName: col.name,
              diffs: [{ field: 'assignees', label: '负责人', from: '空', to: auth.displayName }],
            },
          });

          emit({
            scope: { type: 'worksheet', id: task.worksheetId },
            type: 'stage.updated',
            payload: {
              taskId,
              columnId,
              cell: dto,
              actorDisplayName: auth.displayName,
            },
          });
          emit({
            scope: { type: 'project', id: auth.projectId },
            type: 'board.task_changed',
            payload: { worksheetId: task.worksheetId, taskId, action: 'stage.claimed' },
          });

          return { cell: dto };
        },
      );

      return result;
    },
  );
}
