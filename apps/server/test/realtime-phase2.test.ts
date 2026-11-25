import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectWs,
  createTestEnv,
  createTwoProjects,
  extractSessionCookie,
  type SeededProject,
  TEST_ORIGIN,
  type TestEnv,
} from './helpers.js';

describe('阶段 2 T6：worksheet 实时订阅、在线状态（Presence）与事件补发', () => {
  let env: TestEnv;
  let port: number;
  let projectA: SeededProject;
  let projectB: SeededProject;
  let wsId: string;
  let stageColId: string;

  const headers = (cookie: string, connId?: string) => ({
    cookie,
    origin: TEST_ORIGIN,
    'content-type': 'application/json',
    ...(connId ? { 'x-connection-id': connId } : {}),
  });

  beforeAll(async () => {
    env = await createTestEnv({ realtimeReplayLimit: 5 });
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = env.app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
    port = addr.port;
    const seeded = await createTwoProjects(env.app.ctx.db);
    projectA = seeded.projectA;
    projectB = seeded.projectB;

    const wsRes = await env.app.inject({
      method: 'POST',
      url: '/api/worksheets',
      headers: headers(projectA.admin.cookie),
      payload: { name: '实时协同表', color: 'sky', template: 'standard_video' },
    });
    const data = wsRes.json();
    wsId = data.worksheet.id;
    stageColId = data.columns[0].id;
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('跨项目订阅 worksheet 与已删工作表被拒（FORBIDDEN）', async () => {
    const cB = await connectWs(port, { origin: TEST_ORIGIN, cookie: projectB.admin.cookie });
    try {
      await cB.nextMessage((m) => m.t === 'hello');
      cB.send({ t: 'subscribe', scope: { type: 'worksheet', id: wsId } });
      const err = await cB.nextMessage((m) => m.t === 'error');
      expect(err).toMatchObject({ t: 'error', code: 'FORBIDDEN' });
    } finally {
      cB.close();
    }
  });

  it('在线状态：订阅收到快照、焦点切换仅广播给他人、取消订阅/断开/4401 踢线立即发 presence_leave', async () => {
    const wsScope = { type: 'worksheet', id: wsId };
    const c1 = await connectWs(port, { origin: TEST_ORIGIN, cookie: projectA.admin.cookie });
    const c2 = await connectWs(port, { origin: TEST_ORIGIN, cookie: projectA.user.cookie });
    try {
      const h1 = await c1.nextMessage((m) => m.t === 'hello');
      const h2 = await c2.nextMessage((m) => m.t === 'hello');
      if (h1.t !== 'hello' || h2.t !== 'hello') throw new Error('expected hello');

      // c1 先订阅，快照为空
      c1.send({ t: 'subscribe', scope: wsScope });
      await c1.nextMessage((m) => m.t === 'subscribed');
      const snap1 = await c1.nextMessage((m) => m.t === 'presence_snapshot');
      expect(snap1).toMatchObject({ t: 'presence_snapshot', peers: [] });

      // c2 再订阅：c2 快照包含 c1，c1 收到 c2 加入的 presence_update
      c2.send({ t: 'subscribe', scope: wsScope });
      await c2.nextMessage((m) => m.t === 'subscribed');
      const snap2 = await c2.nextMessage((m) => m.t === 'presence_snapshot');
      expect(snap2).toMatchObject({
        t: 'presence_snapshot',
        peers: [{ connId: h1.connId, userId: projectA.admin.id, focus: null }],
      });
      const joinUpd = await c1.nextMessage((m) => m.t === 'presence_update');
      expect(joinUpd).toMatchObject({
        t: 'presence_update',
        peer: { connId: h2.connId, userId: projectA.user.id, focus: null },
      });

      // c1 切换焦点：c2 收到，c1 不回发自己
      const fakeTaskId = '00000000-0000-7000-8000-000000000099';
      c1.send({
        t: 'presence',
        scope: wsScope,
        focus: { taskId: fakeTaskId, columnKey: 'title', editing: true },
      });
      const focusUpd = await c2.nextMessage((m) => m.t === 'presence_update');
      expect(focusUpd).toMatchObject({
        t: 'presence_update',
        peer: {
          connId: h1.connId,
          focus: { taskId: fakeTaskId, columnKey: 'title', editing: true },
        },
      });
      await expect(c1.nextMessage((m) => m.t === 'presence_update', 150)).rejects.toThrow(
        /Timeout/,
      );

      // c2 取消订阅：c1 立即收到 presence_leave
      c2.send({ t: 'unsubscribe', scope: wsScope });
      const leave1 = await c1.nextMessage((m) => m.t === 'presence_leave');
      expect(leave1).toMatchObject({ t: 'presence_leave', connId: h2.connId });

      // 登录一个临时会话订阅后登出（4401 踢线）-> c1 收到 presence_leave
      const loginRes = await env.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
        payload: { loginName: projectA.user.loginName, password: projectA.user.password },
      });
      const tempCookie = extractSessionCookie(loginRes.headers['set-cookie'])!;
      const c3 = await connectWs(port, { origin: TEST_ORIGIN, cookie: tempCookie });
      const h3 = await c3.nextMessage((m) => m.t === 'hello');
      if (h3.t !== 'hello') throw new Error('expected hello');
      c3.send({ t: 'subscribe', scope: wsScope });
      await c3.nextMessage((m) => m.t === 'subscribed');
      await c1.nextMessage((m) => m.t === 'presence_update');

      await env.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: tempCookie, origin: TEST_ORIGIN },
      });
      const leave3 = await c1.nextMessage((m) => m.t === 'presence_leave');
      expect(leave3).toMatchObject({ t: 'presence_leave', connId: h3.connId });
      c3.close();
    } finally {
      c1.close();
      c2.close();
    }
  });

  it('写任务与工序格同时广播 worksheet 与 project 事件、X-Connection-Id 去重、断线补发与超限 resync', async () => {
    const wsScope = { type: 'worksheet', id: wsId };
    const projScope = { type: 'project', id: projectA.id };

    const c1 = await connectWs(port, { origin: TEST_ORIGIN, cookie: projectA.admin.cookie });
    const c2 = await connectWs(port, { origin: TEST_ORIGIN, cookie: projectA.user.cookie });
    try {
      const h1 = await c1.nextMessage((m) => m.t === 'hello');
      const h2 = await c2.nextMessage((m) => m.t === 'hello');
      if (h1.t !== 'hello' || h2.t !== 'hello') throw new Error('expected hello');

      c1.send({ t: 'subscribe', scope: wsScope });
      c2.send({ t: 'subscribe', scope: wsScope });
      c2.send({ t: 'subscribe', scope: projScope });
      await c1.nextMessage((m) => m.t === 'subscribed');
      const subWs2 = await c2.nextMessage(
        (m) => m.t === 'subscribed' && m.scope.type === 'worksheet',
      );
      await c2.nextMessage((m) => m.t === 'subscribed' && m.scope.type === 'project');
      if (subWs2.t !== 'subscribed') throw new Error('expected subscribed');

      // c1 创建任务（带 X-Connection-Id）
      const tRes = await env.app.inject({
        method: 'POST',
        url: `/api/worksheets/${wsId}/tasks`,
        headers: headers(projectA.admin.cookie, h1.connId),
        payload: { title: '实时新任务' },
      });
      const task = tRes.json();

      // c2 同时在 worksheet 收到 task.created，在 project 收到 board.task_changed
      const evWs = await c2.nextMessage(
        (m) => m.t === 'event' && m.scope.type === 'worksheet' && m.type === 'task.created',
      );
      expect(evWs.t).toBe('event');
      const evProj = await c2.nextMessage(
        (m) => m.t === 'event' && m.scope.type === 'project' && m.type === 'board.task_changed',
      );
      expect(evProj.t).toBe('event');

      // c1 因 X-Connection-Id 不收到自己的 task.created
      await expect(c1.nextMessage((m) => m.t === 'event', 150)).rejects.toThrow(/Timeout/);

      // c2 断开连接，c1 改工序格再连创建 6 条任务（超过 replayLimit=5）
      const savedCursor = evWs.t === 'event' ? evWs.id : subWs2.cursor;
      c2.close();

      await env.app.inject({
        method: 'PATCH',
        url: `/api/tasks/${task.id}/stages/${stageColId}`,
        headers: headers(projectA.admin.cookie),
        payload: { status: 'in_progress', baseRevision: 0 },
      });

      // 先测试 1 条正常补发
      const cReplay = await connectWs(port, { origin: TEST_ORIGIN, cookie: projectA.user.cookie });
      await cReplay.nextMessage((m) => m.t === 'hello');
      cReplay.send({ t: 'subscribe', scope: wsScope, cursor: savedCursor });
      await cReplay.nextMessage((m) => m.t === 'subscribed');
      const replayed = await cReplay.nextMessage((m) => m.t === 'event');
      expect(replayed).toMatchObject({ t: 'event', type: 'stage.updated', replayed: true });
      cReplay.close();

      // 再制造 6 条事件触发超限 resync
      for (let i = 0; i < 6; i++) {
        await env.app.inject({
          method: 'POST',
          url: `/api/worksheets/${wsId}/tasks`,
          headers: headers(projectA.admin.cookie),
          payload: { title: `补发溢出_${i}` },
        });
      }

      const cOverflow = await connectWs(port, {
        origin: TEST_ORIGIN,
        cookie: projectA.user.cookie,
      });
      await cOverflow.nextMessage((m) => m.t === 'hello');
      cOverflow.send({ t: 'subscribe', scope: wsScope, cursor: savedCursor });
      await cOverflow.nextMessage((m) => m.t === 'subscribed');
      const resyncMsg = await cOverflow.nextMessage((m) => m.t === 'resync');
      expect(resyncMsg.t).toBe('resync');
      cOverflow.close();
    } finally {
      c1.close();
      c2.close();
    }
  });
});
