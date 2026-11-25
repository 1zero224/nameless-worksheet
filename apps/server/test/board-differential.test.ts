import {
  type BoardColumn,
  type BoardResponse,
  type BoardTaskInput,
  type ColumnConfig,
  computeBoardData,
  computeMyTasks,
  type MyTasksResponse,
  type StageCell,
  type TaskDetail,
  type Work,
  type WorksheetFullResponse,
} from '@nw/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import {
  createTestEnv,
  createTwoProjects,
  type SeededProject,
  TEST_ORIGIN,
  type TestEnv,
} from './helpers.js';

describe('P1 差分测试与往返不变量：看板聚合查询 vs 全量纯函数 Oracle & 任务删除恢复往返', () => {
  let env: TestEnv;
  let projectA: SeededProject;
  let projectB: SeededProject;

  beforeAll(async () => {
    env = await createTestEnv();
    const seeded = await createTwoProjects(env.app.ctx.db);
    projectA = seeded.projectA;
    projectB = seeded.projectB;
  });

  afterAll(async () => {
    await env.cleanup();
  });

  function headers(cookie: string) {
    return { cookie, origin: TEST_ORIGIN, 'content-type': 'application/json' };
  }

  it('差分测试：GET /api/board 与 GET /api/my-tasks 输出与原始全表拉取 + 纯函数 Oracle 完全一致', async () => {
    // 1. 项目 A 创建两张工作表（标准视频 + 空白）与一张即将软删除的工作表
    const ws1Res = await env.app.inject({
      method: 'POST',
      url: '/api/worksheets',
      headers: headers(projectA.user.cookie),
      payload: { name: '正片表', color: 'sky', template: 'standard_video' },
    });
    expect(ws1Res.statusCode).toBe(201);
    const ws1 = ws1Res.json() as { worksheet: { id: string }; columns: ColumnConfig[] };

    // 新增不上看板工序列（压制）和即将软删的工序列
    const unmappedColRes = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${ws1.worksheet.id}/columns`,
      headers: headers(projectA.user.cookie),
      payload: { name: '压制', type: 'stage', boardColumnId: null },
    });
    expect(unmappedColRes.statusCode).toBe(201);
    const unmappedCol = unmappedColRes.json() as ColumnConfig;

    const tempColRes = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${ws1.worksheet.id}/columns`,
      headers: headers(projectA.user.cookie),
      payload: { name: '临时工序', type: 'stage', boardColumnId: null },
    });
    expect(tempColRes.statusCode).toBe(201);
    const tempCol = tempColRes.json() as ColumnConfig;

    const wsDeletedRes = await env.app.inject({
      method: 'POST',
      url: '/api/worksheets',
      headers: headers(projectA.admin.cookie),
      payload: { name: '废弃表', color: 'rose', template: 'standard_video' },
    });
    expect(wsDeletedRes.statusCode).toBe(201);
    const wsDeleted = wsDeletedRes.json() as { worksheet: { id: string } };

    // 在废弃表中放一条任务后再软删工作表，确保不会泄漏到看板或我的任务
    const ghostTaskRes = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${wsDeleted.worksheet.id}/tasks`,
      headers: headers(projectA.admin.cookie),
      payload: { title: '废弃表任务', workName: '废弃作品' },
    });
    expect(ghostTaskRes.statusCode).toBe(201);
    await env.app.inject({
      method: 'DELETE',
      url: `/api/worksheets/${wsDeleted.worksheet.id}`,
      headers: headers(projectA.admin.cookie),
    });

    // 在项目 B 也写入干扰数据
    const wsBRes = await env.app.inject({
      method: 'POST',
      url: '/api/worksheets',
      headers: headers(projectB.admin.cookie),
      payload: { name: '他项目表', color: 'amber', template: 'standard_video' },
    });
    expect(wsBRes.statusCode).toBe(201);
    const wsB = wsBRes.json() as { worksheet: { id: string } };
    await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${wsB.worksheet.id}/tasks`,
      headers: headers(projectB.admin.cookie),
      payload: { title: '他项目任务' },
    });

    // 在正片表创建多态任务：并行进行中、纯文本负责人、已发布、软删除
    const timingCol = ws1.columns.find((c) => c.name === '时轴');
    const transCol = ws1.columns.find((c) => c.name === '翻译');
    expect(timingCol && transCol).toBeTruthy();
    if (!timingCol || !transCol) return;

    const t1Res = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${ws1.worksheet.id}/tasks`,
      headers: headers(projectA.user.cookie),
      payload: { title: '任务A-并行', workName: '演唱会合集', priority: 'high' },
    });
    const t1 = t1Res.json() as TaskDetail;

    const t2Res = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${ws1.worksheet.id}/tasks`,
      headers: headers(projectA.user.cookie),
      payload: { title: '任务B-已发布', workName: '已完结作品' },
    });
    const t2 = t2Res.json() as TaskDetail;

    const t3Res = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${ws1.worksheet.id}/tasks`,
      headers: headers(projectA.user.cookie),
      payload: { title: '任务C-将被删', workName: '临时作品' },
    });
    const t3 = t3Res.json() as TaskDetail;

    // 配置工序格（包含即将软删列的单元格，验证 SQL 过滤一致性）
    await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${t1.id}/stages/${timingCol.id}`,
      headers: headers(projectA.user.cookie),
      payload: {
        assignees: [{ type: 'user', userId: projectA.user.id }],
        status: 'in_progress',
        baseRevision: 0,
      },
    });
    await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${t1.id}/stages/${transCol.id}`,
      headers: headers(projectA.user.cookie),
      payload: {
        assignees: [{ type: 'text', name: '外援译者' }],
        status: 'in_progress',
        baseRevision: 0,
      },
    });
    await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${t1.id}/stages/${unmappedCol.id}`,
      headers: headers(projectA.user.cookie),
      payload: {
        assignees: [{ type: 'user', userId: projectA.admin.id }],
        status: 'not_started',
        baseRevision: 0,
      },
    });
    await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${t1.id}/stages/${tempCol.id}`,
      headers: headers(projectA.user.cookie),
      payload: {
        assignees: [{ type: 'user', userId: projectA.user.id }],
        status: 'in_progress',
        baseRevision: 0,
      },
    });
    // 软删临时列
    await env.app.inject({
      method: 'DELETE',
      url: `/api/worksheets/${ws1.worksheet.id}/columns/${tempCol.id}`,
      headers: headers(projectA.user.cookie),
    });

    // t2 标已发布 + t3 软删除
    await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${t2.id}/stages/${timingCol.id}`,
      headers: headers(projectA.user.cookie),
      payload: {
        assignees: [{ type: 'user', userId: projectA.user.id }],
        status: 'in_progress',
        baseRevision: 0,
      },
    });
    await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${t2.id}`,
      headers: headers(projectA.user.cookie),
      payload: { changes: { publishStatus: 'published' } },
    });
    await env.app.inject({
      method: 'DELETE',
      url: `/api/tasks/${t3.id}`,
      headers: headers(projectA.user.cookie),
    });

    // 2. 朴素 Oracle：直接全量读取 6 张原始表，纯内存过滤后跑共享纯函数
    const db = env.app.ctx.db;
    const [allBc, allWs, allCols, allWorks, allTasks, allCells] = await Promise.all([
      db.select().from(schema.boardColumns),
      db.select().from(schema.worksheets),
      db.select().from(schema.columnConfigs),
      db.select().from(schema.works),
      db.select().from(schema.tasks),
      db.select().from(schema.stageCells),
    ]);

    const activeWs = allWs
      .filter((w) => w.projectId === projectA.id && w.deletedAt === null)
      .map((w) => ({
        id: w.id,
        name: w.name,
        color: w.color as BoardResponse['worksheets'][number]['color'],
        sortOrder: w.sortOrder,
      }));
    const activeWsIds = new Set(activeWs.map((w) => w.id));

    const boardCols: BoardColumn[] = allBc
      .filter((b) => b.projectId === projectA.id)
      .map((b) => ({
        id: b.id,
        name: b.name,
        sortOrder: b.sortOrder,
        createdAt: b.createdAt.toISOString(),
        updatedAt: b.updatedAt.toISOString(),
      }));

    const activeStageCols: ColumnConfig[] = allCols
      .filter(
        (c) =>
          c.projectId === projectA.id &&
          activeWsIds.has(c.worksheetId) &&
          c.type === 'stage' &&
          c.deletedAt === null,
      )
      .map((c) => ({
        id: c.id,
        worksheetId: c.worksheetId,
        name: c.name,
        type: c.type,
        sortOrder: c.sortOrder,
        width: c.width,
        hidden: c.hidden,
        boardColumnId: c.boardColumnId,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      }));
    const activeStageColIds = new Set(activeStageCols.map((c) => c.id));

    const works: Work[] = allWorks
      .filter((w) => w.projectId === projectA.id && activeWsIds.has(w.worksheetId))
      .map((w) => ({
        id: w.id,
        worksheetId: w.worksheetId,
        name: w.name,
        createdAt: w.createdAt.toISOString(),
        updatedAt: w.updatedAt.toISOString(),
      }));

    const cellsByTask = new Map<string, Record<string, StageCell>>();
    for (const c of allCells) {
      if (c.projectId !== projectA.id || !activeStageColIds.has(c.columnId)) continue;
      let m = cellsByTask.get(c.taskId);
      if (!m) {
        m = {};
        cellsByTask.set(c.taskId, m);
      }
      m[c.columnId] = {
        id: c.id,
        taskId: c.taskId,
        columnId: c.columnId,
        assignees: c.assignees,
        status: c.status,
        note: c.note,
        revision: c.revision,
        updatedAt: c.updatedAt.toISOString(),
      };
    }

    const activeTasks: BoardTaskInput[] = allTasks
      .filter(
        (t) =>
          t.projectId === projectA.id && activeWsIds.has(t.worksheetId) && t.deletedAt === null,
      )
      .map((t) => ({
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

    // 3. 对普通用户与管理员双视角比对 HTTP 接口与 Oracle
    for (const actor of [projectA.user, projectA.admin]) {
      const boardRes = await env.app.inject({
        method: 'GET',
        url: '/api/board',
        headers: { cookie: actor.cookie },
      });
      expect(boardRes.statusCode).toBe(200);
      const apiBoard = boardRes.json() as BoardResponse;

      const oracleBoard = computeBoardData({
        boardColumns: boardCols,
        worksheets: activeWs,
        stageColumns: activeStageCols,
        works,
        tasks: activeTasks,
        currentUserId: actor.id,
      });

      expect(apiBoard.cards).toEqual(oracleBoard.cards);
      expect(apiBoard.myInProgress).toEqual(oracleBoard.myInProgress);
      expect(apiBoard.myPendingCount).toBe(oracleBoard.myPendingCount);

      const myRes = await env.app.inject({
        method: 'GET',
        url: '/api/my-tasks',
        headers: { cookie: actor.cookie },
      });
      expect(myRes.statusCode).toBe(200);
      const apiMine = myRes.json() as MyTasksResponse;

      const oracleMine = computeMyTasks({
        worksheets: activeWs,
        stageColumns: activeStageCols,
        works,
        tasks: activeTasks,
        currentUserId: actor.id,
      });

      expect(apiMine).toEqual(oracleMine);
    }
  });

  it('往返不变量：任务软删除后通过 /restore 恢复，字段、自定义列、作品可见性与工序格完整还原', async () => {
    const wsRes = await env.app.inject({
      method: 'POST',
      url: '/api/worksheets',
      headers: headers(projectA.user.cookie),
      payload: { name: '往返测试表', color: 'emerald', template: 'standard_video' },
    });
    const ws = wsRes.json() as { worksheet: { id: string }; columns: ColumnConfig[] };

    const textColRes = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${ws.worksheet.id}/columns`,
      headers: headers(projectA.user.cookie),
      payload: { name: '片源备注', type: 'text' },
    });
    const textCol = textColRes.json() as ColumnConfig;
    const timingCol = ws.columns.find((c) => c.name === '时轴');
    expect(timingCol).toBeDefined();
    if (!timingCol) return;

    const createRes = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${ws.worksheet.id}/tasks`,
      headers: headers(projectA.user.cookie),
      payload: {
        title: '往返任务 01',
        workName: '独享作品X',
        divisionNote: 'P1 00:00-12:00',
        priority: 'urgent',
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json() as TaskDetail;

    await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${created.id}`,
      headers: headers(projectA.user.cookie),
      payload: {
        changes: {
          customValues: { [textCol.id]: 'BD 1080p 蓝光压制' },
        },
      },
    });
    await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${created.id}/stages/${timingCol.id}`,
      headers: headers(projectA.user.cookie),
      payload: {
        assignees: [
          { type: 'user', userId: projectA.user.id },
          { type: 'text', name: '外援时轴' },
        ],
        status: 'in_progress',
        note: '初轴完成一半',
        baseRevision: 0,
      },
    });

    const beforeRes = await env.app.inject({
      method: 'GET',
      url: `/api/worksheets/${ws.worksheet.id}`,
      headers: { cookie: projectA.user.cookie },
    });
    const before = beforeRes.json() as WorksheetFullResponse;
    const taskBefore = before.tasks.find((t) => t.id === created.id);
    expect(taskBefore).toBeDefined();
    expect(before.works.some((w) => w.name === '独享作品X')).toBe(true);

    // 软删除 -> 任务消失且空作品自动隐藏
    const delRes = await env.app.inject({
      method: 'DELETE',
      url: `/api/tasks/${created.id}`,
      headers: headers(projectA.user.cookie),
    });
    expect(delRes.statusCode).toBe(204);

    const midRes = await env.app.inject({
      method: 'GET',
      url: `/api/worksheets/${ws.worksheet.id}`,
      headers: { cookie: projectA.user.cookie },
    });
    const mid = midRes.json() as WorksheetFullResponse;
    expect(mid.tasks.find((t) => t.id === created.id)).toBeUndefined();
    expect(mid.works.some((w) => w.name === '独享作品X')).toBe(false);

    // 恢复 -> 全部业务字段、工序格与作品可见性完整还原
    const restoreRes = await env.app.inject({
      method: 'POST',
      url: `/api/tasks/${created.id}/restore`,
      headers: headers(projectA.user.cookie),
    });
    expect(restoreRes.statusCode).toBe(200);

    const afterRes = await env.app.inject({
      method: 'GET',
      url: `/api/worksheets/${ws.worksheet.id}`,
      headers: { cookie: projectA.user.cookie },
    });
    const after = afterRes.json() as WorksheetFullResponse;
    const taskAfter = after.tasks.find((t) => t.id === created.id);
    expect(after.works.some((w) => w.name === '独享作品X')).toBe(true);
    expect(taskAfter?.title).toBe(taskBefore?.title);
    expect(taskAfter?.workId).toBe(taskBefore?.workId);
    expect(taskAfter?.divisionNote).toBe(taskBefore?.divisionNote);
    expect(taskAfter?.priority).toBe(taskBefore?.priority);
    expect(taskAfter?.customValues).toEqual(taskBefore?.customValues);
    expect(taskAfter?.stageCells[timingCol.id]?.assignees).toEqual(
      taskBefore?.stageCells[timingCol.id]?.assignees,
    );
    expect(taskAfter?.stageCells[timingCol.id]?.status).toBe(
      taskBefore?.stageCells[timingCol.id]?.status,
    );
    expect(taskAfter?.stageCells[timingCol.id]?.note).toBe(
      taskBefore?.stageCells[timingCol.id]?.note,
    );
  });
});
