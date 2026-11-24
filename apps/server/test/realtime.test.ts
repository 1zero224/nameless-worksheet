import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { withTx } from '../src/db/tx.js';
import { pruneRealtimeEvents } from '../src/jobs/index.js';
import {
  connectWs,
  createTestEnv,
  createTwoProjects,
  extractSessionCookie,
  type SeededProject,
  TEST_ORIGIN,
  type TestEnv,
} from './helpers.js';

describe('T8 实时通道服务端（含 V2/V3/V5b/V6）', () => {
  let env: TestEnv;
  let port: number;
  let projectA: SeededProject;
  let projectB: SeededProject;

  beforeAll(async () => {
    env = await createTestEnv({ realtimeReplayLimit: 10 });
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = env.app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
    port = addr.port;
    const seeded = await createTwoProjects(env.app.ctx.db);
    projectA = seeded.projectA;
    projectB = seeded.projectB;
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('V2: 无 Cookie 或 Origin 不符时 WebSocket 升级被拒', async () => {
    await expect(connectWs(port, { origin: TEST_ORIGIN })).rejects.toThrow('HTTP_401');
    await expect(
      connectWs(port, { origin: 'https://evil.example', cookie: projectA.admin.cookie }),
    ).rejects.toThrow('HTTP_403');
  });

  it('V3 & 权限: 订阅他项目范围、或普通用户订阅 diag 均被拒', async () => {
    const cAdminB = await connectWs(port, { origin: TEST_ORIGIN, cookie: projectB.admin.cookie });
    const cUserA = await connectWs(port, { origin: TEST_ORIGIN, cookie: projectA.user.cookie });
    try {
      await cAdminB.nextMessage((m) => m.t === 'hello');
      await cUserA.nextMessage((m) => m.t === 'hello');

      cAdminB.send({ t: 'subscribe', scope: { type: 'project', id: projectA.id } });
      const err1 = await cAdminB.nextMessage((m) => m.t === 'error');
      expect(err1).toMatchObject({ t: 'error', code: 'FORBIDDEN' });

      cAdminB.send({ t: 'subscribe', scope: { type: 'diag', id: projectA.id } });
      const err2 = await cAdminB.nextMessage((m) => m.t === 'error');
      expect(err2).toMatchObject({ t: 'error', code: 'FORBIDDEN' });

      cUserA.send({ t: 'subscribe', scope: { type: 'diag', id: projectA.id } });
      const err3 = await cUserA.nextMessage((m) => m.t === 'error');
      expect(err3).toMatchObject({ t: 'error', code: 'FORBIDDEN' });
    } finally {
      cAdminB.close();
      cUserA.close();
    }
  });

  it('甲触发事件乙收到，带 X-Connection-Id 的发起连接不收到；事务回滚不发事件', async () => {
    const c1 = await connectWs(port, { origin: TEST_ORIGIN, cookie: projectA.admin.cookie });
    const c2 = await connectWs(port, { origin: TEST_ORIGIN, cookie: projectA.admin.cookie });
    try {
      const h1 = await c1.nextMessage((m) => m.t === 'hello');
      const h2 = await c2.nextMessage((m) => m.t === 'hello');
      if (h1.t !== 'hello' || h2.t !== 'hello') throw new Error('expected hello');

      const diagScope = { type: 'diag', id: projectA.id };
      c1.send({ t: 'subscribe', scope: diagScope });
      c2.send({ t: 'subscribe', scope: diagScope });
      await c1.nextMessage((m) => m.t === 'subscribed');
      await c2.nextMessage((m) => m.t === 'subscribed');

      // c1 发起测试事件并带 X-Connection-Id
      const res = await env.app.inject({
        method: 'POST',
        url: '/api/diag/realtime-test',
        headers: {
          cookie: projectA.admin.cookie,
          origin: TEST_ORIGIN,
          'content-type': 'application/json',
          'x-connection-id': h1.connId,
        },
        payload: { message: 'hello-from-c1' },
      });
      expect(res.statusCode).toBe(200);
      const { eventId } = res.json();

      // c2 收到
      const ev = await c2.nextMessage((m) => m.t === 'event');
      expect(ev).toMatchObject({
        t: 'event',
        id: eventId,
        type: 'diag.ping',
        payload: { message: 'hello-from-c1' },
      });

      // c1 不应收到（短等确认）
      await expect(c1.nextMessage((m) => m.t === 'event', 200)).rejects.toThrow(/Timeout/);

      // 事务回滚不应产生事件
      await expect(
        withTx(env.app.ctx.db, env.app.ctx.bus, { projectId: projectA.id }, async ({ emit }) => {
          emit({
            scope: diagScope,
            type: 'diag.ping',
            payload: { message: 'rollback', sentAt: '' },
          });
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');

      await expect(c2.nextMessage((m) => m.t === 'event', 200)).rejects.toThrow(/Timeout/);
    } finally {
      c1.close();
      c2.close();
    }
  });

  it('带游标重连补齐且顺序正确；V5b 超过上限或早于清理水位触发 resync', async () => {
    const diagScope = { type: 'diag', id: projectA.id };
    const c1 = await connectWs(port, { origin: TEST_ORIGIN, cookie: projectA.admin.cookie });
    let startCursor: string;
    try {
      await c1.nextMessage((m) => m.t === 'hello');
      c1.send({ t: 'subscribe', scope: diagScope });
      const sub = await c1.nextMessage((m) => m.t === 'subscribed');
      if (sub.t !== 'subscribed') throw new Error('expected subscribed');
      startCursor = sub.cursor;
    } finally {
      c1.close();
    }

    // 断线期间发 3 条
    const ids: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const r = await env.app.inject({
        method: 'POST',
        url: '/api/diag/realtime-test',
        headers: {
          cookie: projectA.admin.cookie,
          origin: TEST_ORIGIN,
          'content-type': 'application/json',
        },
        payload: { message: `missed-${i}` },
      });
      ids.push(r.json().eventId);
    }

    // 带 startCursor 重连，按顺序补齐 3 条
    const c2 = await connectWs(port, { origin: TEST_ORIGIN, cookie: projectA.admin.cookie });
    try {
      await c2.nextMessage((m) => m.t === 'hello');
      c2.send({ t: 'subscribe', scope: diagScope, cursor: startCursor });
      await c2.nextMessage((m) => m.t === 'subscribed');
      const received: string[] = [];
      for (let i = 0; i < 3; i++) {
        const m = await c2.nextMessage((x) => x.t === 'event');
        if (m.t === 'event') {
          expect(m.replayed).toBe(true);
          received.push(m.id);
        }
      }
      expect(received).toEqual(ids);
    } finally {
      c2.close();
    }

    // V5b-1: 错过超过 replayLimit(10) 条 -> resync
    for (let i = 0; i < 12; i++) {
      await env.app.inject({
        method: 'POST',
        url: '/api/diag/realtime-test',
        headers: {
          cookie: projectA.admin.cookie,
          origin: TEST_ORIGIN,
          'content-type': 'application/json',
        },
        payload: { message: `overflow-${i}` },
      });
    }

    const c3 = await connectWs(port, { origin: TEST_ORIGIN, cookie: projectA.admin.cookie });
    try {
      await c3.nextMessage((m) => m.t === 'hello');
      c3.send({ t: 'subscribe', scope: diagScope, cursor: startCursor });
      await c3.nextMessage((m) => m.t === 'subscribed');
      const resync = await c3.nextMessage((m) => m.t === 'resync');
      expect(resync.t).toBe('resync');
    } finally {
      c3.close();
    }

    // V5b-2: 清理旧事件推进 prunedThrough，旧游标触发 resync
    await env.app.ctx.db
      .update(schema.realtimeEvents)
      .set({ createdAt: new Date(Date.now() - 48 * 3600 * 1000) })
      .where(eq(schema.realtimeEvents.projectId, projectA.id));
    await pruneRealtimeEvents(env.app.ctx.db, 24);

    const c4 = await connectWs(port, { origin: TEST_ORIGIN, cookie: projectA.admin.cookie });
    try {
      await c4.nextMessage((m) => m.t === 'hello');
      c4.send({ t: 'subscribe', scope: diagScope, cursor: '0' });
      await c4.nextMessage((m) => m.t === 'subscribed');
      const resync = await c4.nextMessage((m) => m.t === 'resync');
      expect(resync.t).toBe('resync');
    } finally {
      c4.close();
    }
  });

  it('并发 50 个写事务后事件编号顺序与提交顺序一致', async () => {
    const scope = { type: 'diag', id: projectB.id };
    const receivedIds: bigint[] = [];
    const unsub = env.app.ctx.bus.subscribe((evs) => {
      for (const e of evs) {
        if (e.projectId === projectB.id) receivedIds.push(e.id);
      }
    });

    try {
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          withTx(env.app.ctx.db, env.app.ctx.bus, { projectId: projectB.id }, async ({ emit }) => {
            emit({ scope, type: 'diag.ping', payload: { message: `c-${i}`, sentAt: '' } });
          }),
        ),
      );

      expect(receivedIds).toHaveLength(50);
      for (let i = 1; i < receivedIds.length; i++) {
        expect(receivedIds[i]! > receivedIds[i - 1]!).toBe(true);
      }
    } finally {
      unsub();
    }
  });

  it('V6: 登出、改密码、管理员重置后对应连接以 4401 关闭；管理员被降级后 diag 订阅取消', async () => {
    // 1. 登出关闭连接
    const l1 = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: { loginName: projectA.user.loginName, password: projectA.user.password },
    });
    const cookie1 = extractSessionCookie(l1.headers['set-cookie'])!;
    const ws1 = await connectWs(port, { origin: TEST_ORIGIN, cookie: cookie1 });
    await ws1.nextMessage((m) => m.t === 'hello');

    const closeP1 = ws1.waitClose();
    await env.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: cookie1, origin: TEST_ORIGIN },
    });
    expect((await closeP1).code).toBe(4401);

    // 2. 改密码关闭另一设备的连接
    const l2a = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: { loginName: projectA.user.loginName, password: projectA.user.password },
    });
    const l2b = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: { loginName: projectA.user.loginName, password: projectA.user.password },
    });
    const cookie2a = extractSessionCookie(l2a.headers['set-cookie'])!;
    const cookie2b = extractSessionCookie(l2b.headers['set-cookie'])!;
    const ws2b = await connectWs(port, { origin: TEST_ORIGIN, cookie: cookie2b });
    await ws2b.nextMessage((m) => m.t === 'hello');

    const closeP2 = ws2b.waitClose();
    const tmpPw = 'TempPassword_4401';
    await env.app.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: { cookie: cookie2a, origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: { currentPassword: projectA.user.password, newPassword: tmpPw },
    });
    expect((await closeP2).code).toBe(4401);

    // 3. 提升为管理员并订阅 diag，降级后收到 FORBIDDEN 错误；随后重置密码连接 4401 关闭
    await env.app.inject({
      method: 'PATCH',
      url: `/api/users/${projectA.user.id}/role`,
      headers: {
        cookie: projectA.admin.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: { role: 'admin' },
    });

    const wsAdmin = await connectWs(port, { origin: TEST_ORIGIN, cookie: cookie2a });
    await wsAdmin.nextMessage((m) => m.t === 'hello');
    wsAdmin.send({ t: 'subscribe', scope: { type: 'diag', id: projectA.id } });
    await wsAdmin.nextMessage((m) => m.t === 'subscribed');

    // 降级
    await env.app.inject({
      method: 'PATCH',
      url: `/api/users/${projectA.user.id}/role`,
      headers: {
        cookie: projectA.admin.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: { role: 'user' },
    });
    const revokedErr = await wsAdmin.nextMessage((m) => m.t === 'error');
    expect(revokedErr).toMatchObject({ t: 'error', code: 'FORBIDDEN' });

    // 管理员为该用户生成重置链接 -> wsAdmin 立即 4401 关闭
    const closeP3 = wsAdmin.waitClose();
    await env.app.inject({
      method: 'POST',
      url: `/api/users/${projectA.user.id}/password-reset`,
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
    });
    expect((await closeP3).code).toBe(4401);
  });
});
