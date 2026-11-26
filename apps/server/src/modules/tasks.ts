import { createHash } from 'node:crypto';
import {
  createTaskBodySchema,
  type FieldConflictItem,
  generateKeyBetween,
  generateNKeysBetween,
  nullableCustomTextSchema,
  nullableDateSchema,
  nullableHttpUrlSchema,
  PRIORITY_LABELS,
  PUBLISH_STATUS_LABELS,
  patchTaskBodySchema,
  reorderTaskBodySchema,
  type StageCell,
  type TaskDetail,
  type Work,
} from '@nw/shared';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { type Db, schema, type Tx } from '../db/index.js';
import { withTx } from '../db/tx.js';
import { AppError, fieldError, notFound, uniqueViolation } from '../errors.js';
import type { EventBus } from '../realtime/bus.js';
import { findActiveWorksheet, recordChangeLog } from './change-logs.js';
import { ascC, parseBody, parseUuidParam, readOriginConnId } from './helpers.js';
import { toStageCellDto, toTaskDetailDto, toWorkDto } from './worksheets.js';

function worksheetSortLockKey(worksheetId: string): bigint {
  const digest = createHash('sha256').update(`ws-sort:${worksheetId}`).digest();
  return digest.readBigInt64BE(0);
}

async function resolveWork(
  tx: Tx,
  projectId: string,
  worksheetId: string,
  workId: string | null | undefined,
  workName: string | null | undefined,
): Promise<{ workId: string | null; work: Work | null }> {
  if (workName !== undefined) {
    if (workName === null) {
      return { workId: null, work: null };
    }
    const [existing] = await tx
      .select()
      .from(schema.works)
      .where(
        and(
          eq(schema.works.projectId, projectId),
          eq(schema.works.worksheetId, worksheetId),
          eq(schema.works.name, workName),
        ),
      )
      .limit(1);
    if (existing) {
      return { workId: existing.id, work: toWorkDto(existing) };
    }
    try {
      const [created] = await tx
        .insert(schema.works)
        .values({ projectId, worksheetId, name: workName })
        .returning();
      if (!created) throw new AppError('INTERNAL');
      return { workId: created.id, work: toWorkDto(created) };
    } catch (err) {
      if (uniqueViolation(err) !== null) {
        const [again] = await tx
          .select()
          .from(schema.works)
          .where(
            and(
              eq(schema.works.projectId, projectId),
              eq(schema.works.worksheetId, worksheetId),
              eq(schema.works.name, workName),
            ),
          )
          .limit(1);
        if (again) return { workId: again.id, work: toWorkDto(again) };
      }
      throw err;
    }
  }

  if (workId !== undefined) {
    if (workId === null) {
      return { workId: null, work: null };
    }
    const [w] = await tx
      .select()
      .from(schema.works)
      .where(
        and(
          eq(schema.works.projectId, projectId),
          eq(schema.works.worksheetId, worksheetId),
          eq(schema.works.id, workId),
        ),
      )
      .limit(1);
    if (!w) throw notFound();
    return { workId: w.id, work: toWorkDto(w) };
  }

  return { workId: null, work: null };
}

async function loadTaskStageCells(
  tx: Tx,
  projectId: string,
  worksheetId: string,
  taskId: string,
): Promise<Record<string, StageCell>> {
  const [cols, cells] = await Promise.all([
    tx
      .select({ id: schema.columnConfigs.id })
      .from(schema.columnConfigs)
      .where(
        and(
          eq(schema.columnConfigs.projectId, projectId),
          eq(schema.columnConfigs.worksheetId, worksheetId),
          isNull(schema.columnConfigs.deletedAt),
        ),
      ),
    tx
      .select()
      .from(schema.stageCells)
      .where(and(eq(schema.stageCells.projectId, projectId), eq(schema.stageCells.taskId, taskId))),
  ]);
  const activeColIds = new Set(cols.map((c) => c.id));
  const map: Record<string, StageCell> = {};
  for (const cell of cells) {
    if (activeColIds.has(cell.columnId)) {
      map[cell.columnId] = toStageCellDto(cell);
    }
  }
  return map;
}

async function computePositionKey(
  tx: Tx,
  projectId: string,
  worksheetId: string,
  opts: {
    afterTaskId?: string | null;
    beforeTaskId?: string | null;
    excludeTaskId?: string;
  },
): Promise<{
  sortOrder: string;
  reindexedUpdates: Array<{ taskId: string; sortOrder: string }>;
}> {
  const rows = await tx
    .select({ id: schema.tasks.id, sortOrder: schema.tasks.sortOrder })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.projectId, projectId),
        eq(schema.tasks.worksheetId, worksheetId),
        isNull(schema.tasks.deletedAt),
      ),
    )
    .orderBy(ascC(schema.tasks.sortOrder), asc(schema.tasks.id));

  const others = opts.excludeTaskId ? rows.filter((r) => r.id !== opts.excludeTaskId) : rows;

  let insertIdx = others.length;
  if (opts.afterTaskId && opts.beforeTaskId) {
    const aIdx = others.findIndex((r) => r.id === opts.afterTaskId);
    const bIdx = others.findIndex((r) => r.id === opts.beforeTaskId);
    if (aIdx !== -1) {
      insertIdx = aIdx + 1;
    } else if (bIdx !== -1) {
      insertIdx = bIdx;
    }
  } else if (opts.afterTaskId) {
    const aIdx = others.findIndex((r) => r.id === opts.afterTaskId);
    if (aIdx !== -1) insertIdx = aIdx + 1;
  } else if (opts.beforeTaskId) {
    const bIdx = others.findIndex((r) => r.id === opts.beforeTaskId);
    if (bIdx !== -1) insertIdx = bIdx;
  }

  const prevKey = insertIdx > 0 ? (others[insertIdx - 1]?.sortOrder ?? null) : null;
  const nextKey = insertIdx < others.length ? (others[insertIdx]?.sortOrder ?? null) : null;

  const needsReindex = (): boolean => {
    if (prevKey !== null && nextKey !== null && prevKey >= nextKey) return true;
    try {
      const k = generateKeyBetween(prevKey, nextKey);
      return k.length > 32;
    } catch {
      return true;
    }
  };

  if (!needsReindex()) {
    return {
      sortOrder: generateKeyBetween(prevKey, nextKey),
      reindexedUpdates: [],
    };
  }

  // 碰撞或键长超限：获取工作表级咨询锁，整表重整排序键
  const lockKey = worksheetSortLockKey(worksheetId);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey.toString()}::bigint)`);

  const lockedRows = await tx
    .select({ id: schema.tasks.id, sortOrder: schema.tasks.sortOrder })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.projectId, projectId),
        eq(schema.tasks.worksheetId, worksheetId),
        isNull(schema.tasks.deletedAt),
      ),
    )
    .orderBy(ascC(schema.tasks.sortOrder), asc(schema.tasks.id));

  const lockedOthers = opts.excludeTaskId
    ? lockedRows.filter((r) => r.id !== opts.excludeTaskId)
    : lockedRows;

  let lockedIdx = lockedOthers.length;
  if (opts.afterTaskId) {
    const aIdx = lockedOthers.findIndex((r) => r.id === opts.afterTaskId);
    if (aIdx !== -1) lockedIdx = aIdx + 1;
  } else if (opts.beforeTaskId) {
    const bIdx = lockedOthers.findIndex((r) => r.id === opts.beforeTaskId);
    if (bIdx !== -1) lockedIdx = bIdx;
  }

  const totalCount = lockedOthers.length + 1;
  const keys = generateNKeysBetween(null, null, totalCount);
  const reindexedUpdates: Array<{ taskId: string; sortOrder: string }> = [];

  for (let i = 0; i < lockedOthers.length; i++) {
    const keyIdx = i < lockedIdx ? i : i + 1;
    const targetKey = keys[keyIdx]!;
    const item = lockedOthers[i]!;
    if (item.sortOrder !== targetKey) {
      await tx
        .update(schema.tasks)
        .set({ sortOrder: targetKey })
        .where(and(eq(schema.tasks.projectId, projectId), eq(schema.tasks.id, item.id)));
      reindexedUpdates.push({ taskId: item.id, sortOrder: targetKey });
    }
  }

  return {
    sortOrder: keys[lockedIdx]!,
    reindexedUpdates,
  };
}

async function findLastTaskActorName(
  tx: Tx,
  projectId: string,
  taskId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ displayName: schema.users.displayName })
    .from(schema.changeLogs)
    .innerJoin(schema.users, eq(schema.changeLogs.actorUserId, schema.users.id))
    .where(and(eq(schema.changeLogs.projectId, projectId), eq(schema.changeLogs.taskId, taskId)))
    .orderBy(desc(schema.changeLogs.createdAt), desc(schema.changeLogs.id))
    .limit(1);
  return row?.displayName ?? null;
}

function deriveFreeRowTitle(
  customValues: Record<string, string | null>,
  orderedCols: Array<{ id: string }>,
): string {
  for (const col of orderedCols) {
    const raw = customValues[col.id];
    if (typeof raw === 'string') {
      const cleaned = raw.replace(/\s+/g, ' ').trim();
      if (cleaned.length > 0) {
        return [...cleaned].slice(0, 200).join('');
      }
    }
  }
  return '';
}

function validateCustomValuesMap(
  rawValues: Record<string, string | null>,
  customColMap: Map<string, { id: string; type: 'stage' | 'text' | 'date' | 'link' }>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [colId, rawVal] of Object.entries(rawValues)) {
    const col = customColMap.get(colId);
    if (!col || col.type === 'stage') {
      throw new AppError('VALIDATION_FAILED', '目标自定义列不存在');
    }
    if (col.type === 'text') {
      const r = nullableCustomTextSchema.safeParse(rawVal);
      if (!r.success) {
        throw new AppError('VALIDATION_FAILED', r.error.issues[0]?.message ?? '文本无效');
      }
      out[colId] = r.data;
    } else if (col.type === 'date') {
      const r = nullableDateSchema.safeParse(rawVal);
      if (!r.success) {
        throw new AppError('VALIDATION_FAILED', r.error.issues[0]?.message ?? '日期无效');
      }
      out[colId] = r.data;
    } else {
      const r = nullableHttpUrlSchema.safeParse(rawVal);
      if (!r.success) {
        throw new AppError('VALIDATION_FAILED', r.error.issues[0]?.message ?? '链接无效');
      }
      out[colId] = r.data;
    }
  }
  return out;
}

export function registerTaskRoutes(app: FastifyInstance, deps: { db: Db; bus: EventBus }): void {
  const { db, bus } = deps;

  // POST /api/worksheets/:worksheetId/tasks
  app.post<{ Params: { worksheetId: string } }>(
    '/api/worksheets/:worksheetId/tasks',
    { config: { access: 'authenticated' } },
    async (request, reply) => {
      const auth = request.auth!;
      const worksheetId = parseUuidParam(request.params.worksheetId);
      const body = parseBody(createTaskBodySchema, request.body);
      const originConnId = readOriginConnId(request);

      const { result } = await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          const ws = await findActiveWorksheet(tx, auth.projectId, worksheetId);
          if (!ws) throw notFound();

          if (ws.kind === 'task' && (!body.title || body.title.length === 0)) {
            throw fieldError('title', '请填写任务标题');
          }

          let validatedCustom: Record<string, string | null> = {};
          let initialTitle = body.title ?? '';

          if (ws.kind === 'free' || body.customValues) {
            const colRows = await tx
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

            const customColMap = new Map(
              colRows.filter((c) => c.type !== 'stage').map((c) => [c.id, c]),
            );
            if (body.customValues) {
              validatedCustom = validateCustomValuesMap(body.customValues, customColMap);
            }
            if (ws.kind === 'free' && initialTitle.length === 0) {
              initialTitle = deriveFreeRowTitle(validatedCustom, colRows);
            }
          }

          const { workId, work } = await resolveWork(
            tx,
            auth.projectId,
            worksheetId,
            body.workId,
            body.workName,
          );

          const { sortOrder, reindexedUpdates } = await computePositionKey(
            tx,
            auth.projectId,
            worksheetId,
            { afterTaskId: body.afterTaskId, beforeTaskId: body.beforeTaskId },
          );

          const [created] = await tx
            .insert(schema.tasks)
            .values({
              projectId: auth.projectId,
              worksheetId,
              workId,
              title: initialTitle,
              divisionNote: body.divisionNote ?? '',
              priority: body.priority ?? 'normal',
              customValues: validatedCustom,
              sortOrder,
            })
            .returning();
          if (!created) throw new AppError('INTERNAL');

          const dto: TaskDetail = toTaskDetailDto(created, {});

          await recordChangeLog(tx, {
            projectId: auth.projectId,
            worksheetId,
            taskId: created.id,
            actorUserId: auth.userId,
            action: 'task.created',
            summary:
              ws.kind === 'free'
                ? created.title
                  ? `新增了行「${created.title}」`
                  : '新增了空白行'
                : `新建了任务「${created.title}」`,
            changes: { title: created.title, ...(work ? { workName: work.name } : {}) },
          });

          if (reindexedUpdates.length > 0) {
            emit({
              scope: { type: 'worksheet', id: worksheetId },
              type: 'tasks.reordered',
              payload: { updates: reindexedUpdates },
            });
          }

          emit({
            scope: { type: 'worksheet', id: worksheetId },
            type: 'task.created',
            payload: { task: dto, work },
          });
          if (ws.kind === 'task') {
            emit({
              scope: { type: 'project', id: auth.projectId },
              type: 'board.task_changed',
              payload: { worksheetId, taskId: created.id, action: 'task.created' },
            });
          }

          return dto;
        },
      );

      return reply.code(201).send(result);
    },
  );

  // PATCH /api/tasks/:id
  app.patch<{ Params: { id: string } }>(
    '/api/tasks/:id',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const taskId = parseUuidParam(request.params.id);
      const body = parseBody(patchTaskBodySchema, request.body);
      const originConnId = readOriginConnId(request);

      const { result } = await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          const [existing] = await tx
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
          if (!existing) throw notFound();

          const ws = await findActiveWorksheet(tx, auth.projectId, existing.worksheetId);
          if (!ws) throw notFound();

          const { changes, baseValues, force } = body;

          if (ws.kind === 'task' && changes.title !== undefined && changes.title.length === 0) {
            throw fieldError('title', '请填写任务标题');
          }

          // 加载自定义列元数据以便校验与生成中文修改记录标签
          const customColRows = await tx
            .select()
            .from(schema.columnConfigs)
            .where(
              and(
                eq(schema.columnConfigs.projectId, auth.projectId),
                eq(schema.columnConfigs.worksheetId, existing.worksheetId),
                isNull(schema.columnConfigs.deletedAt),
              ),
            )
            .orderBy(ascC(schema.columnConfigs.sortOrder), asc(schema.columnConfigs.id));
          const customColMap = new Map(
            customColRows.filter((c) => c.type !== 'stage').map((c) => [c.id, c]),
          );

          // 校验 customValues
          const validatedCustom = changes.customValues
            ? validateCustomValuesMap(changes.customValues, customColMap)
            : {};

          // 字段级冲突检测（第 5.6 节）
          if (!force && baseValues) {
            const conflicts: FieldConflictItem[] = [];
            const checkScalar = (field: string, currentVal: unknown, baseVal: unknown) => {
              if (baseVal === undefined) return;
              if (currentVal !== baseVal) {
                conflicts.push({
                  field,
                  currentValue: currentVal,
                  revision: existing.revision,
                  updatedByDisplayName: null,
                });
              }
            };

            if (changes.title !== undefined) {
              checkScalar('title', existing.title, baseValues.title);
            }
            if (changes.workId !== undefined || changes.workName !== undefined) {
              checkScalar('workId', existing.workId, baseValues.workId);
            }
            if (changes.divisionNote !== undefined) {
              checkScalar('divisionNote', existing.divisionNote, baseValues.divisionNote);
            }
            if (changes.priority !== undefined) {
              checkScalar('priority', existing.priority, baseValues.priority);
            }
            if (changes.publishStatus !== undefined) {
              checkScalar('publishStatus', existing.publishStatus, baseValues.publishStatus);
            }
            if (changes.publishedAt !== undefined) {
              checkScalar('publishedAt', existing.publishedAt, baseValues.publishedAt);
            }
            if (changes.publishUrl !== undefined) {
              checkScalar('publishUrl', existing.publishUrl, baseValues.publishUrl);
            }
            if (changes.customValues && baseValues.customValues) {
              const curMap = existing.customValues ?? {};
              for (const colId of Object.keys(validatedCustom)) {
                if (colId in baseValues.customValues) {
                  const curVal = curMap[colId] ?? null;
                  const baseVal = baseValues.customValues[colId] ?? null;
                  if (curVal !== baseVal) {
                    conflicts.push({
                      field: `custom:${colId}`,
                      currentValue: curVal,
                      revision: existing.revision,
                      updatedByDisplayName: null,
                    });
                  }
                }
              }
            }

            if (conflicts.length > 0) {
              const actorName = await findLastTaskActorName(tx, auth.projectId, existing.id);
              for (const c of conflicts) {
                c.updatedByDisplayName = actorName;
              }
              throw new AppError('FIELD_CONFLICT', '该单元格刚被他人修改', undefined, {
                conflicts,
              });
            }
          }

          // 解析目标作品
          let nextWorkId = existing.workId;
          let resolvedWork: Work | null = null;
          if (changes.workName !== undefined || changes.workId !== undefined) {
            const resolved = await resolveWork(
              tx,
              auth.projectId,
              existing.worksheetId,
              changes.workId,
              changes.workName,
            );
            nextWorkId = resolved.workId;
            resolvedWork = resolved.work;
          }

          const nextTitle = changes.title ?? existing.title;
          const nextDivisionNote = changes.divisionNote ?? existing.divisionNote;
          const nextPriority = changes.priority ?? existing.priority;
          const nextPublishStatus = changes.publishStatus ?? existing.publishStatus;
          const nextPublishedAt =
            changes.publishedAt !== undefined ? changes.publishedAt : existing.publishedAt;
          const nextPublishUrl =
            changes.publishUrl !== undefined ? changes.publishUrl : existing.publishUrl;
          const nextCustomValues: Record<string, string | null> = {
            ...(existing.customValues ?? {}),
          };
          const changedCustomPatch: Record<string, string | null> = {};

          const diffs: Array<{ field: string; label: string; from: unknown; to: unknown }> = [];
          const patch: Partial<
            Omit<TaskDetail, 'stageCells' | 'id' | 'worksheetId' | 'createdAt'>
          > = {};

          if (nextTitle !== existing.title) {
            diffs.push({ field: 'title', label: '标题', from: existing.title, to: nextTitle });
            patch.title = nextTitle;
          }
          if (nextWorkId !== existing.workId) {
            let fromWorkName: string | null = null;
            if (existing.workId) {
              const [fw] = await tx
                .select({ name: schema.works.name })
                .from(schema.works)
                .where(eq(schema.works.id, existing.workId))
                .limit(1);
              fromWorkName = fw?.name ?? null;
            }
            diffs.push({
              field: 'workId',
              label: '作品',
              from: fromWorkName,
              to: resolvedWork?.name ?? null,
            });
            patch.workId = nextWorkId;
          }
          if (nextDivisionNote !== existing.divisionNote) {
            diffs.push({
              field: 'divisionNote',
              label: '分工说明',
              from: existing.divisionNote,
              to: nextDivisionNote,
            });
            patch.divisionNote = nextDivisionNote;
          }
          if (nextPriority !== existing.priority) {
            diffs.push({
              field: 'priority',
              label: '优先级',
              from: PRIORITY_LABELS[existing.priority],
              to: PRIORITY_LABELS[nextPriority],
            });
            patch.priority = nextPriority;
          }
          if (nextPublishStatus !== existing.publishStatus) {
            diffs.push({
              field: 'publishStatus',
              label: '发布状态',
              from: PUBLISH_STATUS_LABELS[existing.publishStatus],
              to: PUBLISH_STATUS_LABELS[nextPublishStatus],
            });
            patch.publishStatus = nextPublishStatus;
          }
          if (nextPublishedAt !== existing.publishedAt) {
            diffs.push({
              field: 'publishedAt',
              label: '发布日期',
              from: existing.publishedAt,
              to: nextPublishedAt,
            });
            patch.publishedAt = nextPublishedAt;
          }
          if (nextPublishUrl !== existing.publishUrl) {
            diffs.push({
              field: 'publishUrl',
              label: '发布链接',
              from: existing.publishUrl,
              to: nextPublishUrl,
            });
            patch.publishUrl = nextPublishUrl;
          }
          for (const [colId, nextVal] of Object.entries(validatedCustom)) {
            const curVal = (existing.customValues ?? {})[colId] ?? null;
            if (nextVal !== curVal) {
              const col = customColMap.get(colId);
              diffs.push({
                field: `custom:${colId}`,
                label: col?.name ?? '自定义列',
                from: curVal,
                to: nextVal,
              });
              nextCustomValues[colId] = nextVal;
              changedCustomPatch[colId] = nextVal;
            }
          }
          if (Object.keys(changedCustomPatch).length > 0) {
            patch.customValues = changedCustomPatch;
          }

          // 自由表格自动把首个非空列值镜像同步到 title（用于搜索与修改记录摘要）
          let effectiveNextTitle = nextTitle;
          if (
            ws.kind === 'free' &&
            changes.title === undefined &&
            Object.keys(changedCustomPatch).length > 0
          ) {
            effectiveNextTitle = deriveFreeRowTitle(nextCustomValues, customColRows);
            if (effectiveNextTitle !== existing.title) {
              patch.title = effectiveNextTitle;
            }
          }

          if (diffs.length === 0) {
            const cells = await loadTaskStageCells(
              tx,
              auth.projectId,
              existing.worksheetId,
              taskId,
            );
            return toTaskDetailDto(existing, cells);
          }

          const now = new Date();
          const nextRevision = existing.revision + 1;
          const [updated] = await tx
            .update(schema.tasks)
            .set({
              title: effectiveNextTitle,
              workId: nextWorkId,
              divisionNote: nextDivisionNote,
              priority: nextPriority,
              publishStatus: nextPublishStatus,
              publishedAt: nextPublishedAt,
              publishUrl: nextPublishUrl,
              customValues: nextCustomValues,
              revision: nextRevision,
              updatedAt: now,
            })
            .where(and(eq(schema.tasks.projectId, auth.projectId), eq(schema.tasks.id, taskId)))
            .returning();
          if (!updated) throw notFound();

          patch.revision = nextRevision;
          patch.updatedAt = now.toISOString();

          const summaryTitle = effectiveNextTitle || '空白行';
          await recordChangeLog(tx, {
            projectId: auth.projectId,
            worksheetId: existing.worksheetId,
            taskId: existing.id,
            actorUserId: auth.userId,
            action: 'task.updated',
            summary: `修改了《${summaryTitle}》的${diffs.map((d) => d.label).join('、')}`,
            changes: { diffs },
          });

          emit({
            scope: { type: 'worksheet', id: existing.worksheetId },
            type: 'task.updated',
            payload: {
              taskId: existing.id,
              revision: nextRevision,
              patch,
              ...(resolvedWork !== null ||
              changes.workId !== undefined ||
              changes.workName !== undefined
                ? { work: resolvedWork }
                : {}),
              actorDisplayName: auth.displayName,
            },
          });
          if (ws.kind === 'task') {
            emit({
              scope: { type: 'project', id: auth.projectId },
              type: 'board.task_changed',
              payload: {
                worksheetId: existing.worksheetId,
                taskId: existing.id,
                action: 'task.updated',
              },
            });
          }

          const cells = await loadTaskStageCells(tx, auth.projectId, existing.worksheetId, taskId);
          return toTaskDetailDto(updated, cells);
        },
      );

      return result;
    },
  );

  // DELETE /api/tasks/:id
  app.delete<{ Params: { id: string } }>(
    '/api/tasks/:id',
    { config: { access: 'authenticated' } },
    async (request, reply) => {
      const auth = request.auth!;
      const taskId = parseUuidParam(request.params.id);
      const originConnId = readOriginConnId(request);

      await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          const [existing] = await tx
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
          if (!existing) throw notFound();

          const ws = await findActiveWorksheet(tx, auth.projectId, existing.worksheetId);
          if (!ws) throw notFound();

          const cells = await loadTaskStageCells(tx, auth.projectId, existing.worksheetId, taskId);
          let workName: string | null = null;
          if (existing.workId) {
            const [w] = await tx
              .select({ name: schema.works.name })
              .from(schema.works)
              .where(eq(schema.works.id, existing.workId))
              .limit(1);
            workName = w?.name ?? null;
          }

          const stageCols = await tx
            .select({ id: schema.columnConfigs.id, name: schema.columnConfigs.name })
            .from(schema.columnConfigs)
            .where(
              and(
                eq(schema.columnConfigs.projectId, auth.projectId),
                eq(schema.columnConfigs.worksheetId, existing.worksheetId),
                eq(schema.columnConfigs.type, 'stage'),
                isNull(schema.columnConfigs.deletedAt),
              ),
            )
            .orderBy(ascC(schema.columnConfigs.sortOrder));

          const now = new Date();
          await tx
            .update(schema.tasks)
            .set({ deletedAt: now, updatedAt: now, revision: existing.revision + 1 })
            .where(and(eq(schema.tasks.projectId, auth.projectId), eq(schema.tasks.id, taskId)));

          const dto = toTaskDetailDto(existing, cells);
          const stageSummaries = stageCols.map((c) => ({
            columnId: c.id,
            name: c.name,
            status: cells[c.id]?.status ?? 'not_started',
            assignees: cells[c.id]?.assignees ?? [],
          }));

          await recordChangeLog(tx, {
            projectId: auth.projectId,
            worksheetId: existing.worksheetId,
            taskId: existing.id,
            actorUserId: auth.userId,
            action: 'task.deleted',
            summary: `删除了任务「${existing.title}」`,
            changes: {
              snapshot: {
                task: dto,
                workName,
                stageSummaries,
                stageCells: Object.values(cells),
              },
            },
          });

          emit({
            scope: { type: 'worksheet', id: existing.worksheetId },
            type: 'task.deleted',
            payload: { taskId: existing.id },
          });
          emit({
            scope: { type: 'project', id: auth.projectId },
            type: 'board.task_changed',
            payload: {
              worksheetId: existing.worksheetId,
              taskId: existing.id,
              action: 'task.deleted',
            },
          });
        },
      );

      return reply.code(204).send();
    },
  );

  // POST /api/tasks/:id/restore
  app.post<{ Params: { id: string } }>(
    '/api/tasks/:id/restore',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const taskId = parseUuidParam(request.params.id);
      const originConnId = readOriginConnId(request);

      const { result } = await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          const [existing] = await tx
            .select()
            .from(schema.tasks)
            .where(and(eq(schema.tasks.projectId, auth.projectId), eq(schema.tasks.id, taskId)))
            .for('update')
            .limit(1);
          if (!existing) throw notFound();

          const ws = await findActiveWorksheet(tx, auth.projectId, existing.worksheetId);
          if (!ws) {
            throw new AppError('CONFLICT', '所属工作表已被删除，无法恢复任务');
          }

          let restoredRow = existing;
          if (existing.deletedAt !== null) {
            const now = new Date();
            const [updated] = await tx
              .update(schema.tasks)
              .set({ deletedAt: null, updatedAt: now, revision: existing.revision + 1 })
              .where(and(eq(schema.tasks.projectId, auth.projectId), eq(schema.tasks.id, taskId)))
              .returning();
            if (!updated) throw notFound();
            restoredRow = updated;
          }

          const cells = await loadTaskStageCells(tx, auth.projectId, existing.worksheetId, taskId);
          const dto = toTaskDetailDto(restoredRow, cells);

          let work: Work | null = null;
          if (restoredRow.workId) {
            const [w] = await tx
              .select()
              .from(schema.works)
              .where(eq(schema.works.id, restoredRow.workId))
              .limit(1);
            if (w) work = toWorkDto(w);
          }

          if (existing.deletedAt !== null) {
            await recordChangeLog(tx, {
              projectId: auth.projectId,
              worksheetId: existing.worksheetId,
              taskId: existing.id,
              actorUserId: auth.userId,
              action: 'task.restored',
              summary: `恢复了任务「${restoredRow.title}」`,
              changes: { title: restoredRow.title },
            });

            emit({
              scope: { type: 'worksheet', id: existing.worksheetId },
              type: 'task.restored',
              payload: { task: dto, work },
            });
            emit({
              scope: { type: 'project', id: auth.projectId },
              type: 'board.task_changed',
              payload: {
                worksheetId: existing.worksheetId,
                taskId: existing.id,
                action: 'task.restored',
              },
            });
          }

          return dto;
        },
      );

      return result;
    },
  );

  // POST /api/worksheets/:worksheetId/tasks/reorder
  app.post<{ Params: { worksheetId: string } }>(
    '/api/worksheets/:worksheetId/tasks/reorder',
    { config: { access: 'authenticated' } },
    async (request) => {
      const auth = request.auth!;
      const worksheetId = parseUuidParam(request.params.worksheetId);
      const body = parseBody(reorderTaskBodySchema, request.body);
      const originConnId = readOriginConnId(request);

      const { result } = await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          const ws = await findActiveWorksheet(tx, auth.projectId, worksheetId);
          if (!ws) throw notFound();

          const [target] = await tx
            .select()
            .from(schema.tasks)
            .where(
              and(
                eq(schema.tasks.projectId, auth.projectId),
                eq(schema.tasks.worksheetId, worksheetId),
                eq(schema.tasks.id, body.taskId),
                isNull(schema.tasks.deletedAt),
              ),
            )
            .limit(1);
          if (!target) throw notFound();

          const { sortOrder, reindexedUpdates } = await computePositionKey(
            tx,
            auth.projectId,
            worksheetId,
            {
              afterTaskId: body.afterTaskId,
              beforeTaskId: body.beforeTaskId,
              excludeTaskId: body.taskId,
            },
          );

          await tx
            .update(schema.tasks)
            .set({ sortOrder, updatedAt: new Date() })
            .where(
              and(eq(schema.tasks.projectId, auth.projectId), eq(schema.tasks.id, body.taskId)),
            );

          const updates = [...reindexedUpdates, { taskId: body.taskId, sortOrder }];

          emit({
            scope: { type: 'worksheet', id: worksheetId },
            type: 'tasks.reordered',
            payload: { updates },
          });

          return { updates };
        },
      );

      return result;
    },
  );
}
