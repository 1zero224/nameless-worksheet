import { can } from '@nw/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, scrubTokenUrl } from '../src/app.js';
import { runInit, runResetLink } from '../src/cli.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { createPool, runMigrations } from '../src/db/index.js';
import {
  createIsolatedDatabase,
  createTestEnv,
  createTwoProjects,
  TEST_ORIGIN,
  type TestEnv,
} from './helpers.js';

describe('T2 配置、日志脱敏、健康检查与迁移', () => {
  it('缺少必填环境变量时抛出 ConfigError 并指明变量名', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({ NODE_ENV: 'production' });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).variables).toContain('DATABASE_URL');
    }
    try {
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).variables).toContain('APP_ORIGIN');
    }
  });

  it('日志 URL 脱敏替换邀请与重置令牌', () => {
    expect(scrubTokenUrl('/api/invites/by-token/secretToken123/register')).toBe(
      '/api/invites/by-token/:token/register',
    );
    expect(scrubTokenUrl('/api/invites/by-token/secretToken123')).toBe(
      '/api/invites/by-token/:token',
    );
    expect(scrubTokenUrl('/api/password-resets/resetToken456')).toBe('/api/password-resets/:token');
    expect(scrubTokenUrl('/api/users')).toBe('/api/users');
  });

  it('迁移可重复执行，health 正常且数据库断开时 ready 返回 503', async () => {
    const isolated = await createIsolatedDatabase();
    try {
      // 重复执行迁移不报错
      await expect(runMigrations(isolated.databaseUrl)).resolves.toBeUndefined();

      const pool = createPool(isolated.databaseUrl, 2);
      const config = loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: isolated.databaseUrl,
        APP_ORIGIN: TEST_ORIGIN,
        LOG_LEVEL: 'silent',
      });
      const app = await buildApp({
        config,
        pool,
        enableJobs: false,
        enableRateLimit: false,
        logger: false,
      });

      const h1 = await app.inject({ method: 'GET', url: '/api/health' });
      expect(h1.statusCode).toBe(200);
      expect(h1.json()).toEqual({ status: 'ok' });

      const r1 = await app.inject({ method: 'GET', url: '/api/health/ready' });
      expect(r1.statusCode).toBe(200);

      // 关闭连接池模拟数据库不可用
      await pool.end();
      const h2 = await app.inject({ method: 'GET', url: '/api/health' });
      expect(h2.statusCode).toBe(200);
      const r2 = await app.inject({ method: 'GET', url: '/api/health/ready' });
      expect(r2.statusCode).toBe(503);

      await app.close();
    } finally {
      await isolated.drop();
    }
  });
});

describe('T3 CLI init 与 reset-link', () => {
  it('init 创建项目和无密码管理员，输出 APP_ORIGIN 链接，重复执行报错不改数据', async () => {
    const isolated = await createIsolatedDatabase();
    try {
      const res = await runInit(isolated.databaseUrl, 'https://example.test/', {
        projectName: '无名字幕组',
        adminLoginName: 'Admin_01',
        displayName: '初始管理员',
      });
      expect(res.resetUrl.startsWith('https://example.test/reset/')).toBe(true);

      await expect(
        runInit(isolated.databaseUrl, 'https://example.test', {
          projectName: '第二个项目',
          adminLoginName: 'admin_02',
          displayName: '第二个管理员',
        }),
      ).rejects.toThrow(/已初始化/);

      const reset = await runResetLink(isolated.databaseUrl, 'https://example.test', 'ADMIN_01');
      expect(reset.resetUrl.startsWith('https://example.test/reset/')).toBe(true);
      expect(reset.resetUrl).not.toBe(res.resetUrl);
    } finally {
      await isolated.drop();
    }
  });
});

describe('T5 路由访问声明、V2 未登录拦截与 V4 普通用户权限拦截', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv();
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it('注册未声明 access 的 /api 路由在启动时报错', async () => {
    const app = await buildApp({
      config: env.config,
      pool: env.app.ctx.pool,
      enableJobs: false,
      enableRateLimit: false,
      logger: false,
    });
    app.get('/api/unprotected-test', async () => ({ ok: true }));
    await expect(app.ready()).rejects.toThrow(/未声明访问级别/);
    await app.close();
  });

  it('public 路由集合恰好等于文档清单', async () => {
    await env.app.ready();
    const routes = env.app.ctx.getRegisteredRoutes();
    const publicRoutes = routes
      .filter((r) => r.access === 'public')
      .map((r) => `${r.method} ${r.url}`)
      .sort();

    expect(publicRoutes).toEqual(
      [
        'GET /api/health',
        'GET /api/health/ready',
        'POST /api/auth/login',
        'GET /api/invites/by-token/:token',
        'POST /api/invites/by-token/:token/register',
        'GET /api/password-resets/:token',
        'POST /api/password-resets/:token',
      ].sort(),
    );
  });

  it('V2: 不带会话调用每一个非 public HTTP 接口均返回 401', async () => {
    await env.app.ready();
    const routes = env.app.ctx
      .getRegisteredRoutes()
      .filter((r) => r.access !== 'public' && r.access !== 'realtime');

    expect(routes.length).toBeGreaterThan(5);
    const dummyId = '00000000-0000-7000-8000-000000000001';

    for (const r of routes) {
      const url = r.url.replace(/:[a-zA-Z0-9_]+/g, dummyId);
      const isWrite = r.method !== 'GET' && r.method !== 'HEAD';
      const res = await env.app.inject({
        method: r.method as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
        url,
        headers: isWrite ? { origin: TEST_ORIGIN, 'content-type': 'application/json' } : {},
        payload: isWrite ? '{}' : undefined,
      });
      expect(res.statusCode, `${r.method} ${r.url} should be 401`).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('V4: 普通用户调用无权访问的权限键接口均返回 403，worksheets.manage 对普通用户开放', async () => {
    await env.app.ready();
    expect(can('user', 'worksheets.manage')).toBe(true);
    const { projectA } = await createTwoProjects(env.app.ctx.db);
    const routes = env.app.ctx
      .getRegisteredRoutes()
      .filter(
        (r) =>
          typeof r.access === 'object' &&
          'permission' in r.access &&
          !can('user', r.access.permission),
      );

    expect(routes.length).toBeGreaterThan(4);
    const dummyId = '00000000-0000-7000-8000-000000000001';

    for (const r of routes) {
      const url = r.url.replace(/:[a-zA-Z0-9_]+/g, dummyId);
      const isWrite = r.method !== 'GET' && r.method !== 'HEAD';
      const res = await env.app.inject({
        method: r.method as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
        url,
        headers: {
          cookie: projectA.user.cookie,
          ...(isWrite ? { origin: TEST_ORIGIN, 'content-type': 'application/json' } : {}),
        },
        payload: isWrite ? '{}' : undefined,
      });
      expect(res.statusCode, `${r.method} ${r.url} should be 403`).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    }
  });
});
