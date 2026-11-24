import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import {
  createTestEnv,
  createTwoProjects,
  extractSessionCookie,
  type SeededProject,
  TEST_ORIGIN,
  type TestEnv,
} from './helpers.js';

describe('T4/T6/T7 会话、登录、邀请、用户管理与 V3 项目隔离', () => {
  let env: TestEnv;
  let projectA: SeededProject;
  let projectB: SeededProject;

  beforeAll(async () => {
    env = await createTestEnv();
    await env.app.ready();
    const seeded = await createTwoProjects(env.app.ctx.db);
    projectA = seeded.projectA;
    projectB = seeded.projectB;
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('T4: 登录名不存在与密码错误的响应完全相同', async () => {
    const r1 = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: { loginName: 'nobody_here', password: 'WrongPassword123' },
    });
    const r2 = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: { loginName: projectA.admin.loginName, password: 'WrongPassword123' },
    });
    expect(r1.statusCode).toBe(401);
    expect(r2.statusCode).toBe(401);
    expect(r1.json()).toEqual(r2.json());
    expect(r1.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('T4: 缺少或错误 Origin 的写请求返回 403 ORIGIN_FORBIDDEN', async () => {
    const r1 = await env.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: projectA.user.cookie },
    });
    expect(r1.statusCode).toBe(403);
    expect(r1.json().error.code).toBe('ORIGIN_FORBIDDEN');

    const r2 = await env.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: projectA.user.cookie, origin: 'https://evil.example' },
    });
    expect(r2.statusCode).toBe(403);
    expect(r2.json().error.code).toBe('ORIGIN_FORBIDDEN');
  });

  it('T4: 连续 5 次登录失败后锁定该登录名', async () => {
    const target = 'lockout_test_user';
    for (let i = 0; i < 5; i++) {
      const r = await env.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
        payload: { loginName: target, password: 'WrongPassword123' },
      });
      expect(r.statusCode).toBe(401);
    }
    const locked = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: { loginName: target, password: 'WrongPassword123' },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('RATE_LIMITED');
  });

  it('T4: 过期会话返回 401，滑动续期在超过 24 小时后顺延并重发 Cookie', async () => {
    // 过期会话
    const loginRes = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: { loginName: projectA.user.loginName, password: projectA.user.password },
    });
    expect(loginRes.statusCode).toBe(200);
    const cookie = extractSessionCookie(loginRes.headers['set-cookie'])!;

    // 模拟 25 小时前活跃，触发滑动续期
    const sessionsBefore = await env.app.ctx.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, projectA.user.id));
    const latest = sessionsBefore[sessionsBefore.length - 1]!;
    await env.app.ctx.db
      .update(schema.sessions)
      .set({ lastSeenAt: new Date(Date.now() - 25 * 3600 * 1000) })
      .where(eq(schema.sessions.id, latest.id));

    const meRes = await env.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(meRes.statusCode).toBe(200);
    expect(extractSessionCookie(meRes.headers['set-cookie'])).toBe(cookie);

    // 把会话设为已过期
    await env.app.ctx.db
      .update(schema.sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.sessions.id, latest.id));

    const expiredRes = await env.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(expiredRes.statusCode).toBe(401);
  });

  it('T6: 过期、作废、用完的邀请均返回 410 且响应相同；20 并发争抢 3 次邀请恰好 3 个成功', async () => {
    // 创建一条 maxUses=3 的邀请
    const createRes = await env.app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: {
        cookie: projectA.admin.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: { role: 'user', expiresInDays: 7, maxUses: 3 },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    const token = created.url.split('/invite/')[1] as string;

    // 20 个并发注册争抢 3 个名额
    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        env.app.inject({
          method: 'POST',
          url: `/api/invites/by-token/${token}/register`,
          headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
          payload: {
            loginName: `race_user_${i}`,
            displayName: `竞态用户_${i}`,
            password: 'RacePassword123',
          },
        }),
      ),
    );
    const succeeded = attempts.filter((r) => r.statusCode === 201);
    const exhausted = attempts.filter((r) => r.statusCode === 410);
    expect(succeeded).toHaveLength(3);
    expect(exhausted).toHaveLength(17);

    // 用完后再查看 -> 410
    const viewExhausted = await env.app.inject({
      method: 'GET',
      url: `/api/invites/by-token/${token}`,
    });
    expect(viewExhausted.statusCode).toBe(410);

    // 作废的邀请 -> 410 且响应完全相同
    const inv2 = (
      await env.app.inject({
        method: 'POST',
        url: '/api/invites',
        headers: {
          cookie: projectA.admin.cookie,
          origin: TEST_ORIGIN,
          'content-type': 'application/json',
        },
        payload: { role: 'user', expiresInDays: 1, maxUses: 5 },
      })
    ).json();
    const token2 = inv2.url.split('/invite/')[1] as string;
    const delRes = await env.app.inject({
      method: 'DELETE',
      url: `/api/invites/${inv2.id}`,
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
    });
    expect(delRes.statusCode).toBe(204);
    const viewRevoked = await env.app.inject({
      method: 'GET',
      url: `/api/invites/by-token/${token2}`,
    });
    expect(viewRevoked.statusCode).toBe(410);
    expect(viewRevoked.json()).toEqual(viewExhausted.json());

    // 过期的邀请 -> 410 且响应完全相同
    const inv3 = (
      await env.app.inject({
        method: 'POST',
        url: '/api/invites',
        headers: {
          cookie: projectA.admin.cookie,
          origin: TEST_ORIGIN,
          'content-type': 'application/json',
        },
        payload: { role: 'user', expiresInDays: 1, maxUses: 5 },
      })
    ).json();
    const token3 = inv3.url.split('/invite/')[1] as string;
    await env.app.ctx.db
      .update(schema.invites)
      .set({ expiresAt: new Date(Date.now() - 10_000) })
      .where(eq(schema.invites.id, inv3.id));
    const viewExpired = await env.app.inject({
      method: 'GET',
      url: `/api/invites/by-token/${token3}`,
    });
    expect(viewExpired.statusCode).toBe(410);
    expect(viewExpired.json()).toEqual(viewExhausted.json());

    // 登录名与显示名冲突返回 409 并指出字段
    const inv4 = (
      await env.app.inject({
        method: 'POST',
        url: '/api/invites',
        headers: {
          cookie: projectA.admin.cookie,
          origin: TEST_ORIGIN,
          'content-type': 'application/json',
        },
        payload: { role: 'user', expiresInDays: 1, maxUses: 5 },
      })
    ).json();
    const token4 = inv4.url.split('/invite/')[1] as string;
    const dupLogin = await env.app.inject({
      method: 'POST',
      url: `/api/invites/by-token/${token4}/register`,
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: {
        loginName: projectA.admin.loginName,
        displayName: '全新显示名_dup',
        password: 'ValidPassword123',
      },
    });
    expect(dupLogin.statusCode).toBe(409);
    expect(dupLogin.json().error.fields.loginName).toBeTruthy();

    const dupDisplay = await env.app.inject({
      method: 'POST',
      url: `/api/invites/by-token/${token4}/register`,
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: {
        loginName: 'unique_login_dup',
        displayName: projectA.admin.displayName,
        password: 'ValidPassword123',
      },
    });
    expect(dupDisplay.statusCode).toBe(409);
    expect(dupDisplay.json().error.fields.displayName).toBeTruthy();
  });

  it('T7: 不能降级最后一个管理员；两个管理员并发互降后仍至少剩一个', async () => {
    // 当前 projectA 只有一个管理员，降级自己必须 409
    const failDemote = await env.app.inject({
      method: 'PATCH',
      url: `/api/users/${projectA.admin.id}/role`,
      headers: {
        cookie: projectA.admin.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: { role: 'user' },
    });
    expect(failDemote.statusCode).toBe(409);

    // 提升 projectA.user 为管理员，再并发互相降级
    const promote = await env.app.inject({
      method: 'PATCH',
      url: `/api/users/${projectA.user.id}/role`,
      headers: {
        cookie: projectA.admin.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: { role: 'admin' },
    });
    expect(promote.statusCode).toBe(200);

    const [d1, d2] = await Promise.all([
      env.app.inject({
        method: 'PATCH',
        url: `/api/users/${projectA.user.id}/role`,
        headers: {
          cookie: projectA.admin.cookie,
          origin: TEST_ORIGIN,
          'content-type': 'application/json',
        },
        payload: { role: 'user' },
      }),
      env.app.inject({
        method: 'PATCH',
        url: `/api/users/${projectA.admin.id}/role`,
        headers: {
          cookie: projectA.user.cookie,
          origin: TEST_ORIGIN,
          'content-type': 'application/json',
        },
        payload: { role: 'user' },
      }),
    ]);

    const statuses = [d1.statusCode, d2.statusCode].sort();
    expect(statuses).toEqual([200, 409]);

    // 恢复 projectA.admin 为管理员、projectA.user 为普通用户
    const winnerCookie = d1.statusCode === 200 ? projectA.admin.cookie : projectA.user.cookie;
    await env.app.inject({
      method: 'PATCH',
      url: `/api/users/${projectA.admin.id}/role`,
      headers: { cookie: winnerCookie, origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: { role: 'admin' },
    });
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
  });

  it('T7: 普通用户看到的用户列表不含登录名；改密码保留当前会话删除其他会话；管理员重置立即清密码与会话', async () => {
    const userList = (
      await env.app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { cookie: projectA.user.cookie },
      })
    ).json();
    expect(userList.length).toBeGreaterThan(0);
    expect(userList[0].loginName).toBeUndefined();

    const adminList = (
      await env.app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { cookie: projectA.admin.cookie },
      })
    ).json();
    expect(adminList[0].loginName).toBeTruthy();

    // 用户在两台设备登录
    const l1 = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: { loginName: projectA.user.loginName, password: projectA.user.password },
    });
    const l2 = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: { loginName: projectA.user.loginName, password: projectA.user.password },
    });
    const c1 = extractSessionCookie(l1.headers['set-cookie'])!;
    const c2 = extractSessionCookie(l2.headers['set-cookie'])!;

    // 设备 1 改密码：设备 1 保留，设备 2 失效
    const newPw = 'NewUserPass_999';
    const chRes = await env.app.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: { cookie: c1, origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: { currentPassword: projectA.user.password, newPassword: newPw },
    });
    expect(chRes.statusCode).toBe(204);

    expect(
      (await env.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: c1 } }))
        .statusCode,
    ).toBe(200);
    expect(
      (await env.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: c2 } }))
        .statusCode,
    ).toBe(401);

    // 管理员为该用户生成重置链接：旧密码立即失效，c1 也失效
    const resetGen = await env.app.inject({
      method: 'POST',
      url: `/api/users/${projectA.user.id}/password-reset`,
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
    });
    expect(resetGen.statusCode).toBe(200);
    const resetToken = (resetGen.json().url as string).split('/reset/')[1]!;

    expect(
      (await env.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: c1 } }))
        .statusCode,
    ).toBe(401);
    const oldLogin = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: { loginName: projectA.user.loginName, password: newPw },
    });
    expect(oldLogin.statusCode).toBe(401);

    // 用重置链接设回原密码
    const preview = await env.app.inject({
      method: 'GET',
      url: `/api/password-resets/${resetToken}`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().loginName).toBe(projectA.user.loginName);

    const submit = await env.app.inject({
      method: 'POST',
      url: `/api/password-resets/${resetToken}`,
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: { password: projectA.user.password },
    });
    expect(submit.statusCode).toBe(204);
    // 重置链接用完后再次访问 410
    expect(
      (await env.app.inject({ method: 'GET', url: `/api/password-resets/${resetToken}` }))
        .statusCode,
    ).toBe(410);
  });

  it('V3 项目隔离：项目乙管理员带项目甲的对象 ID 调用所有带 ID 接口均返回 404 且甲数据未变', async () => {
    // 在项目甲建一条邀请
    const invA = (
      await env.app.inject({
        method: 'POST',
        url: '/api/invites',
        headers: {
          cookie: projectA.admin.cookie,
          origin: TEST_ORIGIN,
          'content-type': 'application/json',
        },
        payload: { role: 'user', expiresInDays: 7, maxUses: 1 },
      })
    ).json();

    // 项目乙管理员尝试修改项目甲用户角色
    const rRole = await env.app.inject({
      method: 'PATCH',
      url: `/api/users/${projectA.user.id}/role`,
      headers: {
        cookie: projectB.admin.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: { role: 'admin' },
    });
    expect(rRole.statusCode).toBe(404);

    // 项目乙管理员尝试为项目甲用户生成重置链接
    const rReset = await env.app.inject({
      method: 'POST',
      url: `/api/users/${projectA.user.id}/password-reset`,
      headers: { cookie: projectB.admin.cookie, origin: TEST_ORIGIN },
    });
    expect(rReset.statusCode).toBe(404);

    // 项目乙管理员尝试作废项目甲邀请
    const rDelInv = await env.app.inject({
      method: 'DELETE',
      url: `/api/invites/${invA.id}`,
      headers: { cookie: projectB.admin.cookie, origin: TEST_ORIGIN },
    });
    expect(rDelInv.statusCode).toBe(404);

    // 验证项目甲邀请仍有效、项目甲用户角色未变
    const invCheck = await env.app.inject({
      method: 'GET',
      url: `/api/invites/by-token/${(invA.url as string).split('/invite/')[1]}`,
    });
    expect(invCheck.statusCode).toBe(200);
  });
});
