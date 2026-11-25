import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestEnv,
  createTwoProjects,
  type SeededProject,
  TEST_ORIGIN,
  type TestEnv,
} from './helpers.js';

describe('阶段 2 T5：看板、我的任务与跨表检索接口', () => {
  let env: TestEnv;
  let projectA: SeededProject;
  let projectB: SeededProject;

  const headers = (cookie: string, isWrite = true) => ({
    cookie,
    ...(isWrite ? { origin: TEST_ORIGIN, 'content-type': 'application/json' } : {}),
  });

  beforeAll(async () => {
    env = await createTestEnv();
    const seeded = await createTwoProjects(env.app.ctx.db);
    projectA = seeded.projectA;
    projectB = seeded.projectB;
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('多表聚合、并行多列、已发布离开、纯文本不进我的任务、跨表中文搜索与跨项目隔离', async () => {
    // 表 1：标准视频（时轴、翻译、校对、嵌字） + 自定义文本列 + 不上看板工序「压制」
    const ws1 = (
      await env.app.inject({
        method: 'POST',
        url: '/api/worksheets',
        headers: headers(projectA.admin.cookie),
        payload: { name: '长视频', color: 'sky', template: 'standard_video' },
      })
    ).json();
    const ws1Id = ws1.worksheet.id;
    const [colTiming, colTrans, colProof] = ws1.columns;
    const colEncode = (
      await env.app.inject({
        method: 'POST',
        url: `/api/worksheets/${ws1Id}/columns`,
        headers: headers(projectA.admin.cookie),
        payload: { name: '压制', type: 'stage', boardColumnId: null },
      })
    ).json();
    const colCustom = (
      await env.app.inject({
        method: 'POST',
        url: `/api/worksheets/${ws1Id}/columns`,
        headers: headers(projectA.admin.cookie),
        payload: { name: '片源说明', type: 'text' },
      })
    ).json();

    // 表 2：空白表，随后仅加翻译列（无校对列），测试多表聚合
    const ws2 = (
      await env.app.inject({
        method: 'POST',
        url: '/api/worksheets',
        headers: headers(projectA.admin.cookie),
        payload: { name: '短切片', color: 'emerald', template: 'blank' },
      })
    ).json();
    const ws2Id = ws2.worksheet.id;
    await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${ws2Id}/columns`,
      headers: headers(projectA.admin.cookie),
      payload: { name: '翻译', type: 'stage' },
    });

    // 任务 1：时轴与翻译并行进行中，压制缺人（不上看板）
    const t1 = (
      await env.app.inject({
        method: 'POST',
        url: `/api/worksheets/${ws1Id}/tasks`,
        headers: headers(projectA.admin.cookie),
        payload: { title: '5th 花絮 P1', workName: '5th 演唱会', divisionNote: 'P1 00:00-13:00' },
      })
    ).json();
    await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${t1.id}`,
      headers: headers(projectA.admin.cookie),
      payload: { changes: { customValues: { [colCustom.id]: '蓝光原盘提取' } } },
    });
    await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${t1.id}/stages/${colTiming.id}`,
      headers: headers(projectA.admin.cookie),
      payload: {
        assignees: [{ type: 'user', userId: projectA.user.id }],
        status: 'in_progress',
        note: '双语时间轴',
        baseRevision: 0,
      },
    });
    await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${t1.id}/stages/${colTrans.id}`,
      headers: headers(projectA.admin.cookie),
      payload: {
        assignees: [{ type: 'text', name: '外援小王' }],
        status: 'in_progress',
        baseRevision: 0,
      },
    });
    await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${t1.id}/stages/${colProof.id}`,
      headers: headers(projectA.admin.cookie),
      payload: {
        assignees: [{ type: 'user', userId: projectA.user.id }],
        status: 'not_started',
        baseRevision: 0,
      },
    });

    // 任务 2：已发布，不应出现在看板或 myInProgress，但出现在 /my-tasks.completed 与 /search
    const t2 = (
      await env.app.inject({
        method: 'POST',
        url: `/api/worksheets/${ws1Id}/tasks`,
        headers: headers(projectA.admin.cookie),
        payload: { title: '已发布旧片' },
      })
    ).json();
    await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${t2.id}/stages/${colTiming.id}`,
      headers: headers(projectA.admin.cookie),
      payload: {
        assignees: [{ type: 'user', userId: projectA.user.id }],
        status: 'in_progress',
        baseRevision: 0,
      },
    });
    await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${t2.id}`,
      headers: headers(projectA.admin.cookie),
      payload: { changes: { publishStatus: 'published', publishedAt: '2026-11-25' } },
    });

    // 任务 3：表 2 中的任务
    const t3 = (
      await env.app.inject({
        method: 'POST',
        url: `/api/worksheets/${ws2Id}/tasks`,
        headers: headers(projectA.admin.cookie),
        payload: { title: '短切片彩蛋' },
      })
    ).json();

    // 1. GET /api/board
    const board = (
      await env.app.inject({
        method: 'GET',
        url: '/api/board',
        headers: headers(projectA.user.cookie, false),
      })
    ).json();

    expect(board.boardColumns.map((c: { name: string }) => c.name)).toEqual([
      '时轴',
      '翻译',
      '校对',
      '嵌字',
    ]);
    // t1 出现在时轴和翻译两列；t2 已发布不出现；t3 出现在翻译列
    const t1Cards = board.cards.filter((c: { taskId: string }) => c.taskId === t1.id);
    expect(t1Cards).toHaveLength(2);
    expect(
      t1Cards[0].missingStages.some((m: { columnId: string }) => m.columnId === colEncode.id),
    ).toBe(true);
    expect(board.cards.some((c: { taskId: string }) => c.taskId === t2.id)).toBe(false);
    expect(board.cards.some((c: { taskId: string }) => c.taskId === t3.id)).toBe(true);

    // myInProgress 仅含 t1 的时轴（t2 已发布不计入，外援小王纯文本不计入）
    expect(board.myInProgress).toHaveLength(1);
    expect(board.myInProgress[0].taskId).toBe(t1.id);
    expect(board.myPendingCount).toBe(1); // 校对未开始

    // 2. GET /api/my-tasks
    const myTasks = (
      await env.app.inject({
        method: 'GET',
        url: '/api/my-tasks',
        headers: headers(projectA.user.cookie, false),
      })
    ).json();
    expect(myTasks.inProgress).toHaveLength(1);
    expect(myTasks.notStarted).toHaveLength(1);
    expect(myTasks.completed).toHaveLength(1);
    expect(myTasks.completed[0].taskId).toBe(t2.id);

    // 3. GET /api/search 跨表中文子串搜索（命中标题、作品、分工、纯文本负责人、备注、自定义文本列）
    for (const q of ['花絮', '演唱会', '00:00-13:00', '外援小王', '双语时间轴', '蓝光原盘']) {
      const s = (
        await env.app.inject({
          method: 'GET',
          url: `/api/search?q=${encodeURIComponent(q)}`,
          headers: headers(projectA.user.cookie, false),
        })
      ).json();
      expect(s.total, `search q=${q}`).toBe(1);
      expect(s.items[0].taskId).toBe(t1.id);
    }

    // hidePublished=true 过滤已发布任务
    const sAll = (
      await env.app.inject({
        method: 'GET',
        url: '/api/search?q=已发布旧片',
        headers: headers(projectA.user.cookie, false),
      })
    ).json();
    expect(sAll.total).toBe(1);

    const sHide = (
      await env.app.inject({
        method: 'GET',
        url: '/api/search?q=已发布旧片&hidePublished=true',
        headers: headers(projectA.user.cookie, false),
      })
    ).json();
    expect(sHide.total).toBe(0);

    // 4. 跨项目隔离：projectB 看不到 projectA 的任何卡片或搜索结果
    const boardB = (
      await env.app.inject({
        method: 'GET',
        url: '/api/board',
        headers: headers(projectB.admin.cookie, false),
      })
    ).json();
    expect(boardB.cards).toHaveLength(0);

    const searchB = (
      await env.app.inject({
        method: 'GET',
        url: '/api/search?q=花絮',
        headers: headers(projectB.admin.cookie, false),
      })
    ).json();
    expect(searchB.total).toBe(0);

    // 5. 软删除工作表 2 后，其任务不再出现在看板或搜索结果中
    await env.app.inject({
      method: 'DELETE',
      url: `/api/worksheets/${ws2Id}`,
      headers: headers(projectA.admin.cookie),
    });
    const searchAfterDel = (
      await env.app.inject({
        method: 'GET',
        url: '/api/search?q=短切片彩蛋',
        headers: headers(projectA.user.cookie, false),
      })
    ).json();
    expect(searchAfterDel.total).toBe(0);
  });
});
