import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestEnv,
  createTwoProjects,
  type SeededProject,
  TEST_ORIGIN,
  type TestEnv,
} from './helpers.js';

describe('阶段 2 T4：任务、排序、工序格、冲突检测、并发认领与恢复', () => {
  let env: TestEnv;
  let projectA: SeededProject;
  let projectB: SeededProject;
  let wsId: string;
  let stageColId: string;
  let customTextColId: string;

  const headers = (cookie: string, isWrite = true) => ({
    cookie,
    ...(isWrite ? { origin: TEST_ORIGIN, 'content-type': 'application/json' } : {}),
  });

  beforeAll(async () => {
    env = await createTestEnv();
    const seeded = await createTwoProjects(env.app.ctx.db);
    projectA = seeded.projectA;
    projectB = seeded.projectB;

    const wsRes = await env.app.inject({
      method: 'POST',
      url: '/api/worksheets',
      headers: headers(projectA.admin.cookie),
      payload: { name: '任务测试表', color: 'sky', template: 'standard_video' },
    });
    const wsData = wsRes.json();
    wsId = wsData.worksheet.id;
    stageColId = wsData.columns[0].id;

    const colRes = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${wsId}/columns`,
      headers: headers(projectA.admin.cookie),
      payload: { name: '备注列', type: 'text' },
    });
    customTextColId = colRes.json().id;
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('任意位置插入、拖动重排、作品自动创建与空作品隐藏', async () => {
    const t1 = (
      await env.app.inject({
        method: 'POST',
        url: `/api/worksheets/${wsId}/tasks`,
        headers: headers(projectA.admin.cookie),
        payload: { title: '第一行', workName: '作品甲' },
      })
    ).json();
    const t3 = (
      await env.app.inject({
        method: 'POST',
        url: `/api/worksheets/${wsId}/tasks`,
        headers: headers(projectA.admin.cookie),
        payload: { title: '第三行' },
      })
    ).json();
    // 在第一行和第三行之间插入第二行
    const t2 = (
      await env.app.inject({
        method: 'POST',
        url: `/api/worksheets/${wsId}/tasks`,
        headers: headers(projectA.admin.cookie),
        payload: { title: '第二行', afterTaskId: t1.id, beforeTaskId: t3.id },
      })
    ).json();

    const full1 = (
      await env.app.inject({
        method: 'GET',
        url: `/api/worksheets/${wsId}`,
        headers: headers(projectA.admin.cookie, false),
      })
    ).json();
    expect(full1.tasks.map((t: { title: string }) => t.title)).toEqual([
      '第一行',
      '第二行',
      '第三行',
    ]);
    expect(full1.works.map((w: { name: string }) => w.name)).toEqual(['作品甲']);

    // 将第三行拖到第一行之前
    const reorderRes = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${wsId}/tasks/reorder`,
      headers: headers(projectA.user.cookie),
      payload: { taskId: t3.id, beforeTaskId: t1.id },
    });
    expect(reorderRes.statusCode).toBe(200);

    const full2 = (
      await env.app.inject({
        method: 'GET',
        url: `/api/worksheets/${wsId}`,
        headers: headers(projectA.user.cookie, false),
      })
    ).json();
    expect(full2.tasks.map((t: { id: string }) => t.id)).toEqual([t3.id, t1.id, t2.id]);
  });

  it('A13: 两人改同一行不同字段均保留；改同一字段返回 409 FIELD_CONFLICT，force 可覆盖', async () => {
    const task = (
      await env.app.inject({
        method: 'POST',
        url: `/api/worksheets/${wsId}/tasks`,
        headers: headers(projectA.admin.cookie),
        payload: { title: '原标题', divisionNote: '原分工' },
      })
    ).json();

    // 甲改标题，乙同时（基于旧值）改分工说明 -> 二者都成功
    const r1 = await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      headers: headers(projectA.admin.cookie),
      payload: {
        changes: { title: '甲的新标题' },
        baseValues: { title: '原标题' },
      },
    });
    expect(r1.statusCode).toBe(200);

    const r2 = await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      headers: headers(projectA.user.cookie),
      payload: {
        changes: {
          divisionNote: 'P1 00:00-13:00',
          customValues: { [customTextColId]: '自定义值' },
        },
        baseValues: { divisionNote: '原分工', customValues: { [customTextColId]: null } },
      },
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().title).toBe('甲的新标题');
    expect(r2.json().divisionNote).toBe('P1 00:00-13:00');
    expect(r2.json().customValues[customTextColId]).toBe('自定义值');

    // 乙基于旧标题尝试改同一字段 title -> 409 FIELD_CONFLICT 且附带服务端最新值与修改人
    const conflict = await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      headers: headers(projectA.user.cookie),
      payload: {
        changes: { title: '乙的标题' },
        baseValues: { title: '原标题' },
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('FIELD_CONFLICT');
    expect(conflict.json().error.details.conflicts[0]).toMatchObject({
      field: 'title',
      currentValue: '甲的新标题',
    });

    // force: true 覆盖成功
    const forced = await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      headers: headers(projectA.user.cookie),
      payload: {
        changes: { title: '乙强行保留的标题' },
        baseValues: { title: '原标题' },
        force: true,
      },
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().title).toBe('乙强行保留的标题');
  });

  it('A24: 并发抢认领恰好 1 人成功、另一人 409 STAGE_ALREADY_CLAIMED，且状态保持 not_started', async () => {
    const task = (
      await env.app.inject({
        method: 'POST',
        url: `/api/worksheets/${wsId}/tasks`,
        headers: headers(projectA.admin.cookie),
        payload: { title: '抢认领任务' },
      })
    ).json();

    const [c1, c2] = await Promise.all([
      env.app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/stages/${stageColId}/claim`,
        headers: headers(projectA.admin.cookie),
      }),
      env.app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/stages/${stageColId}/claim`,
        headers: headers(projectA.user.cookie),
      }),
    ]);

    const codes = [c1.statusCode, c2.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    const winner = c1.statusCode === 200 ? c1 : c2;
    const loser = c1.statusCode === 409 ? c1 : c2;
    expect(winner.json().cell.status).toBe('not_started');
    expect(winner.json().cell.assignees).toHaveLength(1);
    expect(loser.json().error.code).toBe('STAGE_ALREADY_CLAIMED');
    expect(loser.json().error.message).toMatch(/已被 .* 认领/);

    // 工序格 baseRevision 冲突检测
    const stageConflict = await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}/stages/${stageColId}`,
      headers: headers(projectA.admin.cookie),
      payload: { status: 'in_progress', baseRevision: 0 },
    });
    expect(stageConflict.statusCode).toBe(409);
    expect(stageConflict.json().error.code).toBe('FIELD_CONFLICT');
    expect(stageConflict.json().error.details.currentCell.revision).toBe(1);

    // 正常带上最新 baseRevision + 支持项目用户与纯文本名字并存
    const stageOk = await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}/stages/${stageColId}`,
      headers: headers(projectA.admin.cookie),
      payload: {
        assignees: [
          { type: 'user', userId: projectA.user.id },
          { type: 'text', name: '外援小王' },
        ],
        status: 'in_progress',
        note: '初校已完成',
        baseRevision: 1,
      },
    });
    expect(stageOk.statusCode).toBe(200);
    expect(stageOk.json().cell.revision).toBe(2);
    expect(stageOk.json().cell.assignees).toHaveLength(2);
  });

  it('软删除写入快照、修改记录显示 canRestore、一键恢复完整还原数据与作品，且跨项目隔离全部 404', async () => {
    const task = (
      await env.app.inject({
        method: 'POST',
        url: `/api/worksheets/${wsId}/tasks`,
        headers: headers(projectA.admin.cookie),
        payload: { title: '待删后恢复任务', workName: '独立作品乙' },
      })
    ).json();

    await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}/stages/${stageColId}`,
      headers: headers(projectA.admin.cookie),
      payload: {
        assignees: [{ type: 'text', name: '官中' }],
        status: 'done',
        baseRevision: 0,
      },
    });

    // 跨项目隔离检查
    const crossList = [
      {
        method: 'POST',
        url: `/api/worksheets/${wsId}/tasks`,
        payload: { title: '入侵' },
      },
      {
        method: 'PATCH',
        url: `/api/tasks/${task.id}`,
        payload: { changes: { title: '入侵' } },
      },
      { method: 'DELETE', url: `/api/tasks/${task.id}` },
      { method: 'POST', url: `/api/tasks/${task.id}/restore` },
      {
        method: 'POST',
        url: `/api/worksheets/${wsId}/tasks/reorder`,
        payload: { taskId: task.id },
      },
      {
        method: 'PATCH',
        url: `/api/tasks/${task.id}/stages/${stageColId}`,
        payload: { status: 'done', baseRevision: 1 },
      },
      { method: 'POST', url: `/api/tasks/${task.id}/stages/${stageColId}/claim` },
    ] as const;

    for (const c of crossList) {
      const r = await env.app.inject({
        method: c.method,
        url: c.url,
        headers: headers(projectB.admin.cookie),
        payload: 'payload' in c ? c.payload : undefined,
      });
      expect(r.statusCode, `cross-project ${c.method} ${c.url}`).toBe(404);
    }

    // 删除任务 -> 独立作品乙因无未删任务自动隐藏
    const del = await env.app.inject({
      method: 'DELETE',
      url: `/api/tasks/${task.id}`,
      headers: headers(projectA.admin.cookie),
    });
    expect(del.statusCode).toBe(204);

    const wsAfterDel = (
      await env.app.inject({
        method: 'GET',
        url: `/api/worksheets/${wsId}`,
        headers: headers(projectA.admin.cookie, false),
      })
    ).json();
    expect(wsAfterDel.works.some((w: { name: string }) => w.name === '独立作品乙')).toBe(false);

    // 修改记录中删除条目带 canRestore: true 与快照
    const logs = (
      await env.app.inject({
        method: 'GET',
        url: `/api/worksheets/${wsId}/change-logs`,
        headers: headers(projectA.user.cookie, false),
      })
    ).json();
    const delLog = logs.items.find(
      (i: { action: string; taskId: string }) =>
        i.action === 'task.deleted' && i.taskId === task.id,
    );
    expect(delLog).toBeTruthy();
    expect(delLog.canRestore).toBe(true);
    expect(delLog.changes.snapshot.workName).toBe('独立作品乙');

    // 普通用户一键恢复
    const restored = await env.app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/restore`,
      headers: headers(projectA.user.cookie),
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().title).toBe('待删后恢复任务');
    expect(restored.json().stageCells[stageColId].status).toBe('done');
    expect(restored.json().stageCells[stageColId].assignees).toEqual([
      { type: 'text', name: '官中' },
    ]);

    // 恢复后独立作品乙重新可见，修改记录 canRestore 变 false、wasRestored 变 true
    const wsAfterRestore = (
      await env.app.inject({
        method: 'GET',
        url: `/api/worksheets/${wsId}`,
        headers: headers(projectA.user.cookie, false),
      })
    ).json();
    expect(wsAfterRestore.works.some((w: { name: string }) => w.name === '独立作品乙')).toBe(true);

    const logsAfter = (
      await env.app.inject({
        method: 'GET',
        url: `/api/worksheets/${wsId}/change-logs`,
        headers: headers(projectA.user.cookie, false),
      })
    ).json();
    const delLogAfter = logsAfter.items.find(
      (i: { action: string; taskId: string }) =>
        i.action === 'task.deleted' && i.taskId === task.id,
    );
    expect(delLogAfter.canRestore).toBe(false);
    expect(delLogAfter.wasRestored).toBe(true);
  });

  it('任务短链定位接口 GET /api/tasks/:taskId/locate 校验鉴权、跨项目隔离与工序存在性', async () => {
    const createWs = await env.app.inject({
      method: 'POST',
      url: '/api/worksheets',
      headers: headers(projectA.admin.cookie),
      payload: { name: '分享定位表', color: 'sky', template: 'standard_video' },
    });
    expect(createWs.statusCode).toBe(201);
    const { worksheet, columns } = createWs.json() as {
      worksheet: { id: string };
      columns: Array<{ id: string; name: string; type: string }>;
    };
    const timingCol = columns.find((c) => c.name === '时轴');
    const transCol = columns.find((c) => c.name === '翻译');
    expect(timingCol && transCol).toBeTruthy();

    const task = (
      await env.app.inject({
        method: 'POST',
        url: `/api/worksheets/${worksheet.id}/tasks`,
        headers: headers(projectA.user.cookie),
        payload: { title: '短链定位任务', workName: '短链作品' },
      })
    ).json() as { id: string };

    // 未登录 -> 401
    const unauth = await env.app.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/locate`,
    });
    expect(unauth.statusCode).toBe(401);

    // 跨项目 -> 404
    const cross = await env.app.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/locate?stageId=${timingCol!.id}`,
      headers: headers(projectB.admin.cookie, false),
    });
    expect(cross.statusCode).toBe(404);

    // 正常任务级定位
    const locTask = await env.app.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/locate`,
      headers: headers(projectA.user.cookie, false),
    });
    expect(locTask.statusCode).toBe(200);
    expect(locTask.json()).toEqual({
      taskId: task.id,
      worksheetId: worksheet.id,
      worksheetKind: 'task',
      worksheetPlacement: 'topbar',
      stageColumnId: null,
      stageExists: false,
    });

    // 正常工序级定位
    const locStage = await env.app.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/locate?stageId=${timingCol!.id}`,
      headers: headers(projectA.user.cookie, false),
    });
    expect(locStage.statusCode).toBe(200);
    expect(locStage.json()).toEqual({
      taskId: task.id,
      worksheetId: worksheet.id,
      worksheetKind: 'task',
      worksheetPlacement: 'topbar',
      stageColumnId: timingCol!.id,
      stageExists: true,
    });

    // 软删工序列后 stageExists 为 false
    const delCol = await env.app.inject({
      method: 'DELETE',
      url: `/api/worksheets/${worksheet.id}/columns/${transCol!.id}`,
      headers: headers(projectA.admin.cookie),
    });
    expect(delCol.statusCode).toBe(204);

    const locDeletedStage = await env.app.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/locate?stageId=${transCol!.id}`,
      headers: headers(projectA.user.cookie, false),
    });
    expect(locDeletedStage.statusCode).toBe(200);
    expect(locDeletedStage.json().stageExists).toBe(false);

    // 软删任务后返回 404
    await env.app.inject({
      method: 'DELETE',
      url: `/api/tasks/${task.id}`,
      headers: headers(projectA.admin.cookie),
    });
    const locDeletedTask = await env.app.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/locate`,
      headers: headers(projectA.user.cookie, false),
    });
    expect(locDeletedTask.statusCode).toBe(404);
  });

  it('GET /api/stages/assignee-stats 按工序名跨工作表统计负责人频次并排除已删除任务与不适用格', async () => {
    const ws1Data = (
      await env.app.inject({
        method: 'POST',
        url: '/api/worksheets',
        headers: headers(projectA.admin.cookie),
        payload: { name: '频次统计表1', color: 'sky', template: 'standard_video' },
      })
    ).json<{ worksheet: { id: string }; columns: Array<{ id: string; name: string }> }>();
    const ws2Data = (
      await env.app.inject({
        method: 'POST',
        url: '/api/worksheets',
        headers: headers(projectA.admin.cookie),
        payload: { name: '频次统计表2', color: 'emerald', template: 'standard_video' },
      })
    ).json<{ worksheet: { id: string }; columns: Array<{ id: string; name: string }> }>();

    const ws1 = ws1Data.worksheet;
    const ws2 = ws2Data.worksheet;
    const timing1 = ws1Data.columns.find((c) => c.name === '时轴')!.id;
    const timing2 = ws2Data.columns.find((c) => c.name === '时轴')!.id;
    const trans1 = ws1Data.columns.find((c) => c.name === '翻译')!.id;

    const createTask = async (worksheetId: string, title: string) =>
      (
        await env.app.inject({
          method: 'POST',
          url: `/api/worksheets/${worksheetId}/tasks`,
          headers: headers(projectA.user.cookie),
          payload: { title },
        })
      ).json<{ id: string }>();

    const t1 = await createTask(ws1.id, '统计任务1');
    const t2 = await createTask(ws2.id, '统计任务2');
    const t3 = await createTask(ws1.id, '已删统计任务');

    // 表1 时轴：user + 频次测试外援
    await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${t1.id}/stages/${timing1}`,
      headers: headers(projectA.user.cookie),
      payload: {
        assignees: [
          { type: 'user', userId: projectA.user.id },
          { type: 'text', name: '频次测试外援' },
        ],
        status: 'in_progress',
        baseRevision: 0,
      },
    });

    // 表2 时轴：user + admin
    await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${t2.id}/stages/${timing2}`,
      headers: headers(projectA.user.cookie),
      payload: {
        assignees: [
          { type: 'user', userId: projectA.user.id },
          { type: 'user', userId: projectA.admin.id },
        ],
        status: 'done',
        baseRevision: 0,
      },
    });

    // 表1 翻译：标记为 na 不应计入频次
    await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${t1.id}/stages/${trans1}`,
      headers: headers(projectA.user.cookie),
      payload: {
        assignees: [{ type: 'user', userId: projectA.admin.id }],
        status: 'na',
        baseRevision: 0,
      },
    });

    // 已删除任务的工序不应计入频次
    await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${t3.id}/stages/${timing1}`,
      headers: headers(projectA.user.cookie),
      payload: {
        assignees: [{ type: 'text', name: '已删外援' }],
        status: 'in_progress',
        baseRevision: 0,
      },
    });
    await env.app.inject({
      method: 'DELETE',
      url: `/api/tasks/${t3.id}`,
      headers: headers(projectA.user.cookie),
    });

    const statsRes = await env.app.inject({
      method: 'GET',
      url: '/api/stages/assignee-stats',
      headers: headers(projectA.user.cookie, false),
    });
    expect(statsRes.statusCode).toBe(200);
    const body = statsRes.json<{
      byStageName: Record<string, { users: Record<string, number>; texts: Record<string, number> }>;
    }>();

    expect(body.byStageName['时轴']?.users[projectA.user.id]).toBeGreaterThanOrEqual(2);
    expect(body.byStageName['时轴']?.users[projectA.admin.id]).toBeGreaterThanOrEqual(1);
    expect(body.byStageName['时轴']?.texts['频次测试外援']).toBe(1);
    expect(body.byStageName['时轴']?.texts['已删外援']).toBeUndefined();
    expect(body.byStageName['翻译']?.users[projectA.admin.id]).toBeUndefined();
  });
});
