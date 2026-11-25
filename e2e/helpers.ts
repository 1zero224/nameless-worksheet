import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type APIRequestContext, expect, type Page } from '@playwright/test';

export interface E2eState {
  resetUrl: string;
  dbName: string;
  logPath: string;
}

export function readE2eState(): E2eState {
  const p = path.resolve(process.cwd(), 'e2e', '.state.json');
  return JSON.parse(readFileSync(p, 'utf8')) as E2eState;
}

/**
 * 通过 API 快速登录（用于阶段 2+ E2E 用例独立造数，避免 test.describe.serial 耦合）。
 */
export async function apiLogin(
  request: APIRequestContext,
  origin: string,
  loginName: string,
  password: string,
): Promise<string> {
  const res = await request.post(`${origin}/api/auth/login`, {
    headers: { origin },
    data: { loginName, password },
  });
  expect(res.ok(), `apiLogin(${loginName}) 失败: ${res.status()}`).toBe(true);
  const setCookie = res.headers()['set-cookie'] ?? '';
  const match = setCookie.match(/nw_session=[^;]+/);
  if (!match) {
    throw new Error('登录响应未返回 nw_session Cookie');
  }
  return match[0];
}

/**
 * 管理员通过 API 生成单次或限次邀请并直接注册新用户，返回该用户的会话 Cookie。
 */
export async function apiSeedUser(
  request: APIRequestContext,
  origin: string,
  adminCookie: string,
  user: {
    loginName: string;
    displayName: string;
    password: string;
    role?: 'admin' | 'user';
  },
): Promise<{ cookie: string; inviteUrl: string }> {
  const invRes = await request.post(`${origin}/api/invites`, {
    headers: { cookie: adminCookie, origin },
    data: { role: user.role ?? 'user', expiresInDays: 1, maxUses: 1 },
  });
  expect(invRes.ok(), `创建邀请失败: ${invRes.status()}`).toBe(true);
  const invBody = (await invRes.json()) as { inviteUrl: string };
  const token = invBody.inviteUrl.split('/invite/')[1];
  if (!token) throw new Error(`无效邀请链接: ${invBody.inviteUrl}`);

  const regRes = await request.post(`${origin}/api/invites/by-token/${token}/register`, {
    headers: { origin },
    data: {
      loginName: user.loginName,
      displayName: user.displayName,
      password: user.password,
    },
  });
  expect(regRes.ok(), `注册用户 ${user.loginName} 失败: ${regRes.status()}`).toBe(true);
  const setCookie = regRes.headers()['set-cookie'] ?? '';
  const match = setCookie.match(/nw_session=[^;]+/);
  if (!match) throw new Error('注册响应未返回 nw_session Cookie');
  return { cookie: match[0], inviteUrl: invBody.inviteUrl };
}

/**
 * 通过登录页完成 UI 登录并确认进入首页。
 */
export async function loginViaUi(page: Page, loginName: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('登录名').fill(loginName);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/$/);
}

/**
 * 校验当前视口无页面级横向溢出（用于 390×844 手机端验收）。
 */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow, '页面不应出现横向溢出').toBe(false);
}
