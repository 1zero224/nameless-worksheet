import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestEnv,
  createTwoProjects,
  type SeededProject,
  TEST_ORIGIN,
  type TestEnv,
} from './helpers.js';

describe('阶段 2 T3：看板列、工作表、列配置与作品接口（含普通用户开放与跨项目隔离）', () => {
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

  const headers = (cookie: string, isWrite = true) => ({
    cookie,
    ...(isWrite ? { origin: TEST_ORIGIN, 'content-type': 'application/json' } : {}),
  });

  it('普通用户可管理看板列、模板建表自动匹配看板列、1:1 映射冲突返回 409、删看板列自动置空', async () => {
    // 1. 普通用户读取默认 4 个看板列
    const bcList = await env.app.inject({
      method: 'GET',
      url: '/api/board-columns',
      headers: headers(projectA.user.cookie, false),
    });
    expect(bcList.statusCode).toBe(200);
    const cols = bcList.json() as Array<{ id: string; name: string }>;
    expect(cols.map((c) => c.name)).toEqual(['时轴', '翻译', '校对', '嵌字']);

    // 2. 普通用户新增看板列「压制」并改名
    const bcCreate = await env.app.inject({
      method: 'POST',
      url: '/api/board-columns',
      headers: headers(projectA.user.cookie),
      payload: { name: '压制' },
    });
    expect(bcCreate.statusCode).toBe(201);
    const newBc = bcCreate.json();

    // 重名 409
    const bcDup = await env.app.inject({
      method: 'POST',
      url: '/api/board-columns',
      headers: headers(projectA.user.cookie),
      payload: { name: '压制' },
    });
    expect(bcDup.statusCode).toBe(409);

    // 3. 普通用户按标准视频模板新建工作表 -> 自动匹配 4 个看板列
    const wsRes = await env.app.inject({
      method: 'POST',
      url: '/api/worksheets',
      headers: headers(projectA.user.cookie),
      payload: { name: '视频表', color: 'sky', template: 'standard_video' },
    });
    expect(wsRes.statusCode).toBe(201);
    const { worksheet, columns } = wsRes.json();
    expect(columns.map((c: { name: string }) => c.name)).toEqual(['时轴', '翻译', '校对', '嵌字']);
    for (const c of columns) {
      const matched = cols.find((bc) => bc.name === c.name);
      expect(c.boardColumnId).toBe(matched?.id);
    }

    // 4. 在同表内尝试再绑定同一看板列「时轴」 -> 409
    const dupBind = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${worksheet.id}/columns`,
      headers: headers(projectA.user.cookie),
      payload: { name: '二轴', type: 'stage', boardColumnId: cols[0]!.id },
    });
    expect(dupBind.statusCode).toBe(409);

    // 5. 新增绑定到「压制」的工序列 + 自定义链接列
    const encodeColRes = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${worksheet.id}/columns`,
      headers: headers(projectA.user.cookie),
      payload: { name: '压制', type: 'stage' }, // 未显式传 boardColumnId 自动按名匹配
    });
    expect(encodeColRes.statusCode).toBe(201);
    expect(encodeColRes.json().boardColumnId).toBe(newBc.id);

    const linkColBad = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${worksheet.id}/columns`,
      headers: headers(projectA.user.cookie),
      payload: { name: '源视频', type: 'link', boardColumnId: newBc.id },
    });
    expect(linkColBad.statusCode).toBe(400);

    const linkColRes = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${worksheet.id}/columns`,
      headers: headers(projectA.user.cookie),
      payload: { name: '源视频', type: 'link' },
    });
    expect(linkColRes.statusCode).toBe(201);

    // 6. 删除看板列「压制」 -> 对应工序列 boardColumnId 自动置 null，列本身保留
    const bcDel = await env.app.inject({
      method: 'DELETE',
      url: `/api/board-columns/${newBc.id}`,
      headers: headers(projectA.user.cookie),
    });
    expect(bcDel.statusCode).toBe(204);

    const wsFull = await env.app.inject({
      method: 'GET',
      url: `/api/worksheets/${worksheet.id}`,
      headers: headers(projectA.user.cookie, false),
    });
    expect(wsFull.statusCode).toBe(200);
    const encodeColAfter = wsFull
      .json()
      .columns.find((c: { id: string }) => c.id === encodeColRes.json().id);
    expect(encodeColAfter).toBeTruthy();
    expect(encodeColAfter.boardColumnId).toBeNull();

    // 7. 软删除列与修改记录校验
    const delCol = await env.app.inject({
      method: 'DELETE',
      url: `/api/worksheets/${worksheet.id}/columns/${linkColRes.json().id}`,
      headers: headers(projectA.user.cookie),
    });
    expect(delCol.statusCode).toBe(204);

    // 8. 作品创建（幂等）与改名
    const w1 = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${worksheet.id}/works`,
      headers: headers(projectA.user.cookie),
      payload: { name: '5th 演唱会' },
    });
    expect(w1.statusCode).toBe(201);
    const w1Again = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${worksheet.id}/works`,
      headers: headers(projectA.user.cookie),
      payload: { name: '5th 演唱会' },
    });
    expect(w1Again.json().id).toBe(w1.json().id);

    const wRename = await env.app.inject({
      method: 'PATCH',
      url: `/api/worksheets/${worksheet.id}/works/${w1.json().id}`,
      headers: headers(projectA.user.cookie),
      payload: { name: '5th 演唱会花絮' },
    });
    expect(wRename.statusCode).toBe(200);
    expect(wRename.json().name).toBe('5th 演唱会花絮');

    // 9. 查看工作表修改记录
    const logs = await env.app.inject({
      method: 'GET',
      url: `/api/worksheets/${worksheet.id}/change-logs`,
      headers: headers(projectA.user.cookie, false),
    });
    expect(logs.statusCode).toBe(200);
    const actions = logs.json().items.map((i: { action: string }) => i.action);
    expect(actions).toContain('worksheet.created');
    expect(actions).toContain('column.created');
    expect(actions).toContain('column.deleted');

    // 10. 跨项目隔离：projectB 访问 projectA 的所有带 ID 接口均返回 404
    const bcA = cols[0]!.id;
    const colA = columns[0].id;
    const workA = w1.json().id;
    const crossChecks = [
      { method: 'PATCH', url: `/api/board-columns/${bcA}`, payload: { name: '入侵' } },
      { method: 'DELETE', url: `/api/board-columns/${bcA}` },
      { method: 'GET', url: `/api/worksheets/${worksheet.id}` },
      { method: 'PATCH', url: `/api/worksheets/${worksheet.id}`, payload: { name: '入侵' } },
      { method: 'DELETE', url: `/api/worksheets/${worksheet.id}` },
      {
        method: 'POST',
        url: `/api/worksheets/${worksheet.id}/columns`,
        payload: { name: '入侵列', type: 'text' },
      },
      {
        method: 'PATCH',
        url: `/api/worksheets/${worksheet.id}/columns/${colA}`,
        payload: { name: '入侵' },
      },
      { method: 'DELETE', url: `/api/worksheets/${worksheet.id}/columns/${colA}` },
      {
        method: 'POST',
        url: `/api/worksheets/${worksheet.id}/works`,
        payload: { name: '入侵作品' },
      },
      {
        method: 'PATCH',
        url: `/api/worksheets/${worksheet.id}/works/${workA}`,
        payload: { name: '入侵作品2' },
      },
      { method: 'GET', url: `/api/worksheets/${worksheet.id}/change-logs` },
    ] as const;

    for (const c of crossChecks) {
      const isWrite = c.method !== 'GET';
      const r = await env.app.inject({
        method: c.method,
        url: c.url,
        headers: headers(projectB.admin.cookie, isWrite),
        payload: 'payload' in c ? c.payload : undefined,
      });
      expect(r.statusCode, `cross-project ${c.method} ${c.url}`).toBe(404);
    }

    // 11. 软删除工作表后无法再 GET
    const delWs = await env.app.inject({
      method: 'DELETE',
      url: `/api/worksheets/${worksheet.id}`,
      headers: headers(projectA.user.cookie),
    });
    expect(delWs.statusCode).toBe(204);
    const getDeleted = await env.app.inject({
      method: 'GET',
      url: `/api/worksheets/${worksheet.id}`,
      headers: headers(projectA.user.cookie, false),
    });
    expect(getDeleted.statusCode).toBe(404);
  });
});
