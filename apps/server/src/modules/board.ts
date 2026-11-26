import {
  type BoardResponse,
  type BoardTaskInput,
  computeBoardData,
  computeMyTasks,
  type MyTasksResponse,
  type StageCell,
} from '@nw/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { type Db, schema } from '../db/index.js';
import { toBoardColumnDto } from './board-columns.js';
import { ascC } from './helpers.js';
import {
  listWorksheetSummaries,
  toColumnConfigDto,
  toStageCellDto,
  toWorkDto,
} from './worksheets.js';

export function registerBoardRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps;

  // GET /api/board
  app.get('/api/board', { config: { access: 'authenticated' } }, async (request) => {
    const auth = request.auth!;

    const [boardColRows, worksheets] = await Promise.all([
      db
        .select()
        .from(schema.boardColumns)
        .where(eq(schema.boardColumns.projectId, auth.projectId))
        .orderBy(ascC(schema.boardColumns.sortOrder), asc(schema.boardColumns.id)),
      listWorksheetSummaries(db, auth.projectId),
    ]);

    const boardColumns = boardColRows.map(toBoardColumnDto);
    if (worksheets.length === 0) {
      const empty: BoardResponse = {
        boardColumns,
        worksheets: [],
        works: [],
        cards: [],
        myInProgress: [],
        myPending: [],
        myPendingCount: 0,
      };
      return empty;
    }

    const activeWsIds = worksheets.map((w) => w.id);

    const [stageColRows, taskRows, workRows, cellRows] = await Promise.all([
      db
        .select()
        .from(schema.columnConfigs)
        .where(
          and(
            eq(schema.columnConfigs.projectId, auth.projectId),
            inArray(schema.columnConfigs.worksheetId, activeWsIds),
            eq(schema.columnConfigs.type, 'stage'),
            isNull(schema.columnConfigs.deletedAt),
          ),
        )
        .orderBy(ascC(schema.columnConfigs.sortOrder), asc(schema.columnConfigs.id)),
      db
        .select()
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.projectId, auth.projectId),
            inArray(schema.tasks.worksheetId, activeWsIds),
            eq(schema.tasks.publishStatus, 'unpublished'),
            isNull(schema.tasks.deletedAt),
          ),
        )
        .orderBy(ascC(schema.tasks.sortOrder), asc(schema.tasks.id)),
      db
        .select()
        .from(schema.works)
        .where(
          and(
            eq(schema.works.projectId, auth.projectId),
            inArray(schema.works.worksheetId, activeWsIds),
          ),
        )
        .orderBy(asc(schema.works.createdAt), asc(schema.works.id)),
      db
        .select()
        .from(schema.stageCells)
        .where(
          and(
            eq(schema.stageCells.projectId, auth.projectId),
            inArray(schema.stageCells.worksheetId, activeWsIds),
          ),
        ),
    ]);

    const activeStageColIds = new Set(stageColRows.map((c) => c.id));
    const cellsByTask = new Map<string, Record<string, StageCell>>();
    for (const c of cellRows) {
      if (!activeStageColIds.has(c.columnId)) continue;
      let m = cellsByTask.get(c.taskId);
      if (!m) {
        m = {};
        cellsByTask.set(c.taskId, m);
      }
      m[c.columnId] = toStageCellDto(c);
    }

    const activeWorkIds = new Set(
      taskRows.map((t) => t.workId).filter((id): id is string => id !== null),
    );
    const visibleWorks = workRows.filter((w) => activeWorkIds.has(w.id)).map(toWorkDto);

    const taskInputs: BoardTaskInput[] = taskRows.map((t) => ({
      id: t.id,
      worksheetId: t.worksheetId,
      workId: t.workId,
      title: t.title,
      divisionNote: t.divisionNote,
      priority: t.priority,
      publishStatus: t.publishStatus,
      sortOrder: t.sortOrder,
      stageCells: cellsByTask.get(t.id) ?? {},
    }));

    const computed = computeBoardData({
      boardColumns,
      worksheets,
      stageColumns: stageColRows.map(toColumnConfigDto),
      works: visibleWorks,
      tasks: taskInputs,
      currentUserId: auth.userId,
    });

    const res: BoardResponse = {
      boardColumns,
      worksheets,
      works: visibleWorks,
      cards: computed.cards,
      myInProgress: computed.myInProgress,
      myPending: computed.myPending,
      myPendingCount: computed.myPendingCount,
    };
    return res;
  });

  // GET /api/my-tasks
  app.get('/api/my-tasks', { config: { access: 'authenticated' } }, async (request) => {
    const auth = request.auth!;

    const worksheets = await listWorksheetSummaries(db, auth.projectId);
    if (worksheets.length === 0) {
      const empty: MyTasksResponse = { inProgress: [], notStarted: [], completed: [] };
      return empty;
    }

    const activeWsIds = worksheets.map((w) => w.id);
    const [stageColRows, taskRows, workRows, cellRows] = await Promise.all([
      db
        .select()
        .from(schema.columnConfigs)
        .where(
          and(
            eq(schema.columnConfigs.projectId, auth.projectId),
            inArray(schema.columnConfigs.worksheetId, activeWsIds),
            eq(schema.columnConfigs.type, 'stage'),
            isNull(schema.columnConfigs.deletedAt),
          ),
        )
        .orderBy(ascC(schema.columnConfigs.sortOrder), asc(schema.columnConfigs.id)),
      db
        .select()
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.projectId, auth.projectId),
            inArray(schema.tasks.worksheetId, activeWsIds),
            isNull(schema.tasks.deletedAt),
          ),
        )
        .orderBy(ascC(schema.tasks.sortOrder), asc(schema.tasks.id)),
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
    ]);

    const activeStageColIds = new Set(stageColRows.map((c) => c.id));
    const cellsByTask = new Map<string, Record<string, StageCell>>();
    for (const c of cellRows) {
      if (!activeStageColIds.has(c.columnId)) continue;
      let m = cellsByTask.get(c.taskId);
      if (!m) {
        m = {};
        cellsByTask.set(c.taskId, m);
      }
      m[c.columnId] = toStageCellDto(c);
    }

    const taskInputs: BoardTaskInput[] = taskRows.map((t) => ({
      id: t.id,
      worksheetId: t.worksheetId,
      workId: t.workId,
      title: t.title,
      divisionNote: t.divisionNote,
      priority: t.priority,
      publishStatus: t.publishStatus,
      sortOrder: t.sortOrder,
      stageCells: cellsByTask.get(t.id) ?? {},
    }));

    return computeMyTasks({
      worksheets,
      stageColumns: stageColRows.map(toColumnConfigDto),
      works: workRows.map(toWorkDto),
      tasks: taskInputs,
      currentUserId: auth.userId,
    });
  });
}
