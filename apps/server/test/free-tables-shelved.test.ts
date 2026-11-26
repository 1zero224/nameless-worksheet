import type { BoardResponse, MyTasksResponse, SearchResponse, WorksheetSummary } from '@nw/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, createTwoProjects, TEST_ORIGIN, type TestEnv } from './helpers.js';

describe('阶段 5 T4: 自由表格、通用文档在线表与已搁置状态', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv();
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('自由表格 CRUD、禁建工序列、多行文本、/docs 放置、搜索与看板彻底隔离', async () => {
    const { projectA, projectB } = await createTwoProjects(env.app.ctx.db);

    // 1. 新建顶栏自由表格（默认 3 列）
    const freeRes = await env.app.inject({
      method: 'POST',
      url: '/api/worksheets',
      headers: {
        cookie: projectA.user.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ name: '相关收益自由表', template: 'free_blank' }),
    });
    expect(freeRes.statusCode).toBe(201);
    const { worksheet: freeWs, columns: freeCols } = freeRes.json();
    expect(freeWs.kind).toBe('free');
    expect(freeWs.placement).toBe('topbar');
    expect(freeCols).toHaveLength(3);

    // 2. 自由表禁止新增 stage 工序列
    const badStage = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${freeWs.id}/columns`,
      headers: {
        cookie: projectA.user.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ name: '非法工序', type: 'stage' }),
    });
    expect(badStage.statusCode).toBe(400);

    // 3. 自由表允许省略 title 直接写多行 customValues（上限 2000 字符）
    const multilineNote = '第一行说明\r\n第二行详情\n第三行备注';
    const rowRes = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${freeWs.id}/tasks`,
      headers: {
        cookie: projectA.user.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        customValues: { [freeCols[0].id]: multilineNote, [freeCols[1].id]: '800元' },
      }),
    });
    expect(rowRes.statusCode).toBe(201);
    const freeRow = rowRes.json();
    expect(freeRow.customValues[freeCols[0].id]).toBe('第一行说明\n第二行详情\n第三行备注');
    expect(freeRow.title).toBe('第一行说明 第二行详情 第三行备注');

    // 4. 在 /docs 建在线自由表格（placement='docs' 自动强制 kind='free'）
    const docsSheetRes = await env.app.inject({
      method: 'POST',
      url: '/api/worksheets',
      headers: {
        cookie: projectA.user.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        name: '⭐翻译对照表⭐',
        placement: 'docs',
        initialColumns: [
          { name: '日文/原词', type: 'text' },
          { name: '中文译名', type: 'text' },
        ],
      }),
    });
    expect(docsSheetRes.statusCode).toBe(201);
    const { worksheet: docsWs, columns: docsCols } = docsSheetRes.json();
    expect(docsWs.kind).toBe('free');
    expect(docsWs.placement).toBe('docs');
    expect(docsCols).toHaveLength(2);

    const termRowRes = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${docsWs.id}/tasks`,
      headers: {
        cookie: projectA.user.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        workName: '通用日语',
        customValues: {
          [docsCols[0].id]: 'トゲナシトゲアリ',
          [docsCols[1].id]: '无刺有刺',
        },
      }),
    });
    expect(termRowRes.statusCode).toBe(201);
    const termRow = termRowRes.json();

    // 5. GET /api/worksheets?placement=topbar 与 ?placement=docs 严格过滤
    const topbarList = (
      await env.app.inject({
        method: 'GET',
        url: '/api/worksheets?placement=topbar',
        headers: { cookie: projectA.user.cookie },
      })
    ).json() as WorksheetSummary[];
    expect(topbarList.map((w) => w.id)).toEqual([freeWs.id]);

    const docsList = (
      await env.app.inject({
        method: 'GET',
        url: '/api/worksheets?placement=docs',
        headers: { cookie: projectA.user.cookie },
      })
    ).json() as WorksheetSummary[];
    expect(docsList.map((w) => w.id)).toEqual([docsWs.id]);

    // 6. 融合搜索命中 /docs 在线表格归入 docSheets，且跨项目 404/不可见
    const searchRes = await env.app.inject({
      method: 'GET',
      url: `/api/search?q=${encodeURIComponent('无刺有刺')}`,
      headers: { cookie: projectA.user.cookie },
    });
    expect(searchRes.statusCode).toBe(200);
    const searchBody = searchRes.json() as SearchResponse;
    expect(
      searchBody.docSheets?.some((d) => d.worksheetId === docsWs.id && d.taskId === termRow.id),
    ).toBe(true);

    const searchCross = await env.app.inject({
      method: 'GET',
      url: `/api/search?q=${encodeURIComponent('无刺有刺')}`,
      headers: { cookie: projectB.user.cookie },
    });
    expect((searchCross.json() as SearchResponse).docSheets ?? []).toHaveLength(0);

    // 7. 看板与我的任务绝不出现自由表格
    const boardRes = await env.app.inject({
      method: 'GET',
      url: '/api/board',
      headers: { cookie: projectA.user.cookie },
    });
    const board = boardRes.json() as BoardResponse;
    expect(board.worksheets.some((w) => w.id === freeWs.id || w.id === docsWs.id)).toBe(false);
    expect(board.cards).toHaveLength(0);
  });

  it('已搁置（shelved）任务离开看板与我的任务，切回未发布后恢复上看板', async () => {
    const { projectA } = await createTwoProjects(env.app.ctx.db);

    const wsRes = await env.app.inject({
      method: 'POST',
      url: '/api/worksheets',
      headers: {
        cookie: projectA.admin.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ name: '视频制作表', template: 'standard_video' }),
    });
    const { worksheet, columns } = wsRes.json();
    const axisCol = columns.find((c: { name: string }) => c.name === '时轴');

    const taskRes = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${worksheet.id}/tasks`,
      headers: {
        cookie: projectA.admin.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ title: '撞车待搁置任务' }),
    });
    const task = taskRes.json();

    // 分配给普通用户并设为进行中
    await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}/stages/${axisCol.id}`,
      headers: {
        cookie: projectA.admin.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        assignees: [{ type: 'user', userId: projectA.user.id }],
        status: 'in_progress',
        baseRevision: 0,
      }),
    });

    // 初始出现在看板与我的任务
    const board1 = (
      await env.app.inject({
        method: 'GET',
        url: '/api/board',
        headers: { cookie: projectA.user.cookie },
      })
    ).json() as BoardResponse;
    expect(board1.cards.some((c) => c.taskId === task.id)).toBe(true);
    expect(board1.myInProgress.some((c) => c.taskId === task.id)).toBe(true);

    // 设为已搁置
    const shelveRes = await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      headers: {
        cookie: projectA.admin.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ changes: { publishStatus: 'shelved' } }),
    });
    expect(shelveRes.statusCode).toBe(200);
    expect(shelveRes.json().publishStatus).toBe('shelved');

    // 立即离开看板与我的任务
    const board2 = (
      await env.app.inject({
        method: 'GET',
        url: '/api/board',
        headers: { cookie: projectA.user.cookie },
      })
    ).json() as BoardResponse;
    expect(board2.cards.some((c) => c.taskId === task.id)).toBe(false);
    expect(board2.myInProgress.some((c) => c.taskId === task.id)).toBe(false);

    const myTasks2 = (
      await env.app.inject({
        method: 'GET',
        url: '/api/my-tasks',
        headers: { cookie: projectA.user.cookie },
      })
    ).json() as MyTasksResponse;
    expect([...myTasks2.inProgress, ...myTasks2.notStarted, ...myTasks2.completed]).toHaveLength(0);

    // 切回未发布后立刻回到看板
    const reactivateRes = await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      headers: {
        cookie: projectA.admin.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ changes: { publishStatus: 'unpublished' } }),
    });
    expect(reactivateRes.statusCode).toBe(200);
    const board3 = (
      await env.app.inject({
        method: 'GET',
        url: '/api/board',
        headers: { cookie: projectA.user.cookie },
      })
    ).json() as BoardResponse;
    expect(board3.cards.some((c) => c.taskId === task.id)).toBe(true);
  });
});
