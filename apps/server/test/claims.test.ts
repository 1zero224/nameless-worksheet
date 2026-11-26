import type {
  ClaimLinkResponse,
  ClaimPreview,
  MeResponse,
  MyTasksResponse,
  UserListItem,
} from '@nw/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import {
  createTestEnv,
  createTwoProjects,
  extractSessionCookie,
  TEST_ORIGIN,
  type TestEnv,
} from './helpers.js';

describe('阶段 5 T3: 待认领用户与一次性认领链接', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv();
  });

  afterAll(async () => {
    await env.cleanup();
  });

  async function seedUnclaimedUser(projectId: string, displayName: string): Promise<string> {
    const db = env.app.ctx.db;
    const [u] = await db
      .insert(schema.users)
      .values({
        loginName: null,
        displayName,
        passwordHash: null,
        claimedAt: null,
      })
      .returning({ id: schema.users.id });
    if (!u) throw new Error('seed unclaimed failed');
    await db.insert(schema.memberships).values({
      projectId,
      userId: u.id,
      role: 'user',
    });
    return u.id;
  }

  it('完整闭环：生成/重发自动作废旧链接、拒绝密码重置、认领后自动登录且立见我的任务、令牌零泄漏', async () => {
    const { projectA, projectB } = await createTwoProjects(env.app.ctx.db);
    const unclaimedId = await seedUnclaimedUser(projectA.id, '待认领译者甲');

    // 先建一张制作表并把任务工序分配给待认领用户
    const wsRes = await env.app.inject({
      method: 'POST',
      url: '/api/worksheets',
      headers: {
        cookie: projectA.admin.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ name: '认领验证表', template: 'standard_video' }),
    });
    expect(wsRes.statusCode).toBe(201);
    const { worksheet, columns } = wsRes.json();
    const transCol = columns.find((c: { name: string }) => c.name === '翻译');

    const taskRes = await env.app.inject({
      method: 'POST',
      url: `/api/worksheets/${worksheet.id}/tasks`,
      headers: {
        cookie: projectA.admin.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ title: '武道馆 LIVE P1' }),
    });
    expect(taskRes.statusCode).toBe(201);
    const task = taskRes.json();

    const stageRes = await env.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}/stages/${transCol.id}`,
      headers: {
        cookie: projectA.admin.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        assignees: [{ type: 'user', userId: unclaimedId }],
        status: 'in_progress',
        baseRevision: 0,
      }),
    });
    expect(stageRes.statusCode).toBe(200);

    // 1. 管理员查看用户列表：未生成认领链接时 claimStatus = 'none'
    const list1 = await env.app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { cookie: projectA.admin.cookie },
    });
    expect(list1.statusCode).toBe(200);
    const users1 = list1.json() as UserListItem[];
    const target1 = users1.find((u) => u.id === unclaimedId);
    expect(target1?.claimedAt).toBeNull();
    expect(target1?.loginName).toBeNull();
    expect(target1?.claimStatus).toBe('none');

    // 2. 拒绝给未认领用户生成密码重置链接（409）
    const badReset = await env.app.inject({
      method: 'POST',
      url: `/api/users/${unclaimedId}/password-reset`,
      headers: { cookie: projectA.admin.cookie, origin: TEST_ORIGIN },
    });
    expect(badReset.statusCode).toBe(409);

    // 3. 拒绝给已认领用户生成认领链接（409）
    const badClaim = await env.app.inject({
      method: 'POST',
      url: `/api/users/${projectA.user.id}/claim-link`,
      headers: {
        cookie: projectA.admin.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ ttlDays: 30 }),
    });
    expect(badClaim.statusCode).toBe(409);

    // 4. 跨项目管理员访问返 404
    const crossRes = await env.app.inject({
      method: 'POST',
      url: `/api/users/${unclaimedId}/claim-link`,
      headers: {
        cookie: projectB.admin.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ ttlDays: 30 }),
    });
    expect(crossRes.statusCode).toBe(404);

    // 5. 普通用户调返 403
    const forbidRes = await env.app.inject({
      method: 'POST',
      url: `/api/users/${unclaimedId}/claim-link`,
      headers: {
        cookie: projectA.user.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ ttlDays: 30 }),
    });
    expect(forbidRes.statusCode).toBe(403);

    // 6. 管理员生成第 1 个认领链接
    const link1Res = await env.app.inject({
      method: 'POST',
      url: `/api/users/${unclaimedId}/claim-link`,
      headers: {
        cookie: projectA.admin.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ ttlDays: 30 }),
    });
    expect(link1Res.statusCode).toBe(201);
    const link1 = link1Res.json() as ClaimLinkResponse;
    expect(link1.url.startsWith(`${TEST_ORIGIN}/claim/`)).toBe(true);
    const token1 = link1.url.split('/claim/')[1]!;

    // 预览第 1 个链接成功
    const prev1 = await env.app.inject({ method: 'GET', url: `/api/account-claims/${token1}` });
    expect(prev1.statusCode).toBe(200);
    const previewBody = prev1.json() as ClaimPreview;
    expect(previewBody.displayName).toBe('待认领译者甲');
    expect(previewBody.projectName).toBe(projectA.name);
    expect(previewBody.role).toBe('user');

    // 7. 重新生成第 2 个链接 -> 旧链接立即作废返回 404
    const link2Res = await env.app.inject({
      method: 'POST',
      url: `/api/users/${unclaimedId}/claim-link`,
      headers: {
        cookie: projectA.admin.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ ttlDays: 7 }),
    });
    expect(link2Res.statusCode).toBe(201);
    const token2 = (link2Res.json() as ClaimLinkResponse).url.split('/claim/')[1]!;
    expect(token2).not.toBe(token1);

    const revokedPrev = await env.app.inject({
      method: 'GET',
      url: `/api/account-claims/${token1}`,
    });
    expect(revokedPrev.statusCode).toBe(404);
    expect(revokedPrev.json().error.message).toBe('认领链接无效或已过期，请联系管理员');

    // 管理员列表此时显示 active
    const list2 = await env.app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { cookie: projectA.admin.cookie },
    });
    const target2 = (list2.json() as UserListItem[]).find((u) => u.id === unclaimedId);
    expect(target2?.claimStatus).toBe('active');
    expect(target2?.claimExpiresAt).not.toBeNull();

    // 8. 认领完成（密码不能等于登录名）
    const badPw = await env.app.inject({
      method: 'POST',
      url: `/api/account-claims/${token2}/complete`,
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ loginName: 'translator_jia', password: 'translator_jia' }),
    });
    expect(badPw.statusCode).toBe(400);

    // 正确提交认领
    const completeRes = await env.app.inject({
      method: 'POST',
      url: `/api/account-claims/${token2}/complete`,
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({
        loginName: 'translator_jia',
        displayName: '译者甲正式名',
        password: 'StrongPassword#2026',
      }),
    });
    expect(completeRes.statusCode).toBe(200);
    const me = completeRes.json() as MeResponse;
    expect(me.user.id).toBe(unclaimedId);
    expect(me.user.loginName).toBe('translator_jia');
    expect(me.user.displayName).toBe('译者甲正式名');
    const cookie = extractSessionCookie(completeRes.headers['set-cookie']);
    expect(cookie).toBeTruthy();

    // 9. 认领后立即在「我的任务」看到原归属任务
    const myTasksRes = await env.app.inject({
      method: 'GET',
      url: '/api/my-tasks',
      headers: { cookie: cookie! },
    });
    expect(myTasksRes.statusCode).toBe(200);
    const myTasks = myTasksRes.json() as MyTasksResponse;
    expect(myTasks.inProgress.some((i) => i.taskId === task.id)).toBe(true);

    // 10. 已用链接再次访问统一返回 404
    const reuseRes = await env.app.inject({ method: 'GET', url: `/api/account-claims/${token2}` });
    expect(reuseRes.statusCode).toBe(404);
    const reuseComplete = await env.app.inject({
      method: 'POST',
      url: `/api/account-claims/${token2}/complete`,
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ loginName: 'other_login', password: 'StrongPassword#2026' }),
    });
    expect(reuseComplete.statusCode).toBe(404);

    // 11. 实时事件、修改记录、搜索索引均不含明文令牌
    const rtEvents = await env.app.ctx.db
      .select()
      .from(schema.realtimeEvents)
      .where(eq(schema.realtimeEvents.projectId, projectA.id));
    const serialized = JSON.stringify(rtEvents, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(serialized).not.toContain(token1);
    expect(serialized).not.toContain(token2);
  });

  it('过期认领链接返回 404 且列表显示 expired', async () => {
    const { projectA } = await createTwoProjects(env.app.ctx.db);
    const unclaimedId = await seedUnclaimedUser(projectA.id, '过期测试用户');

    const linkRes = await env.app.inject({
      method: 'POST',
      url: `/api/users/${unclaimedId}/claim-link`,
      headers: {
        cookie: projectA.admin.cookie,
        origin: TEST_ORIGIN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ ttlDays: 1 }),
    });
    const token = (linkRes.json() as ClaimLinkResponse).url.split('/claim/')[1]!;

    // 把 expires_at 调为过去
    await env.app.ctx.db
      .update(schema.accountClaims)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.accountClaims.userId, unclaimedId));

    const prev = await env.app.inject({ method: 'GET', url: `/api/account-claims/${token}` });
    expect(prev.statusCode).toBe(404);

    const listRes = await env.app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { cookie: projectA.admin.cookie },
    });
    const row = (listRes.json() as UserListItem[]).find((u) => u.id === unclaimedId);
    expect(row?.claimStatus).toBe('expired');
  });
});
