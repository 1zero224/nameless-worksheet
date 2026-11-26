import { readFileSync } from 'node:fs';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import pg from 'pg';
import { expectNoHorizontalOverflow, loginViaUi, readE2eState } from './helpers.js';

const ORIGIN = 'http://127.0.0.1:3100';
const ADMIN_LOGIN = 'admin_e2e';
const ADMIN_PW = 'AdminE2eSecret_2026!';
const USER_A_LOGIN = 'p5_alice';
const USER_A_NAME = '五期小爱';
const USER_A_PW = 'Phase5Alice_2026!';

interface GridGeometryHost extends HTMLDivElement {
  __nwGridGeometry?: {
    getCellPoint: (taskId: string, columnKey: string) => { x: number; y: number } | null;
    getHeaderPoint: (columnKey: string) => { x: number; y: number } | null;
  };
}

async function clickCanvasCell(page: Page, taskId: string, columnKey: string, dbl = false) {
  let pt: { x: number; y: number } | null = null;
  await expect
    .poll(async () => {
      pt = await page.getByTestId('worksheet-canvas-grid').evaluate(
        (el, { tId, cKey }) => {
          return (el as GridGeometryHost).__nwGridGeometry?.getCellPoint(tId, cKey) ?? null;
        },
        { tId: taskId, cKey: columnKey },
      );
      return pt !== null;
    })
    .toBe(true);
  if (!pt) throw new Error(`Canvas cell point not found: ${taskId}:${columnKey}`);
  const resolved = pt as { x: number; y: number };
  await page.mouse.move(resolved.x, resolved.y);
  if (dbl) {
    await page.mouse.dblclick(resolved.x, resolved.y);
  } else {
    await page.mouse.click(resolved.x, resolved.y);
  }
}

async function clickCanvasHeader(page: Page, columnKey: string) {
  let pt: { x: number; y: number } | null = null;
  await expect
    .poll(async () => {
      pt = await page.getByTestId('worksheet-canvas-grid').evaluate((el, cKey) => {
        return (el as GridGeometryHost).__nwGridGeometry?.getHeaderPoint(cKey) ?? null;
      }, columnKey);
      return pt !== null;
    })
    .toBe(true);
  if (!pt) throw new Error(`Canvas header point not found: ${columnKey}`);
  const resolved = pt as { x: number; y: number };
  await page.mouse.move(resolved.x, resolved.y);
  await page.mouse.click(resolved.x, resolved.y);
}

async function ensureAdminCookie(request: APIRequestContext): Promise<string> {
  const tryLogin = await request.post(`${ORIGIN}/api/auth/login`, {
    headers: { origin: ORIGIN },
    data: { loginName: ADMIN_LOGIN, password: ADMIN_PW },
  });
  if (tryLogin.ok()) {
    const cookie = (tryLogin.headers()['set-cookie'] ?? '').match(/nw_session=[^;]+/)?.[0];
    if (cookie) return cookie;
  }

  const { resetUrl } = readE2eState();
  const token = resetUrl.split('/reset/')[1];
  const resetRes = await request.post(`${ORIGIN}/api/password-resets/${token}`, {
    headers: { origin: ORIGIN },
    data: { password: ADMIN_PW },
  });
  expect(resetRes.ok()).toBe(true);

  const login2 = await request.post(`${ORIGIN}/api/auth/login`, {
    headers: { origin: ORIGIN },
    data: { loginName: ADMIN_LOGIN, password: ADMIN_PW },
  });
  expect(login2.ok()).toBe(true);
  const cookie = (login2.headers()['set-cookie'] ?? '').match(/nw_session=[^;]+/)?.[0];
  if (!cookie) throw new Error('登录未返回会话 Cookie');
  return cookie;
}

async function ensureUser(
  request: APIRequestContext,
  adminCookie: string,
  opts: { loginName: string; displayName: string; password: string },
): Promise<{ cookie: string; userId: string }> {
  const tryLogin = await request.post(`${ORIGIN}/api/auth/login`, {
    headers: { origin: ORIGIN },
    data: { loginName: opts.loginName, password: opts.password },
  });
  if (tryLogin.ok()) {
    const cookie = (tryLogin.headers()['set-cookie'] ?? '').match(/nw_session=[^;]+/)?.[0] ?? '';
    const me = (await (
      await request.get(`${ORIGIN}/api/auth/me`, { headers: { cookie } })
    ).json()) as { user: { id: string } };
    return { cookie, userId: me.user.id };
  }

  const invRes = await request.post(`${ORIGIN}/api/invites`, {
    headers: { cookie: adminCookie, origin: ORIGIN },
    data: { role: 'user', expiresInDays: 1, maxUses: 1 },
  });
  expect(invRes.ok()).toBe(true);
  const invBody = (await invRes.json()) as { url: string };
  const token = invBody.url.split('/invite/')[1];

  const regRes = await request.post(`${ORIGIN}/api/invites/by-token/${token}/register`, {
    headers: { origin: ORIGIN },
    data: {
      loginName: opts.loginName,
      displayName: opts.displayName,
      password: opts.password,
    },
  });
  expect(regRes.ok()).toBe(true);
  const cookie = (regRes.headers()['set-cookie'] ?? '').match(/nw_session=[^;]+/)?.[0] ?? '';
  const me = (await (
    await request.get(`${ORIGIN}/api/auth/me`, { headers: { cookie } })
  ).json()) as { user: { id: string } };
  return { cookie, userId: me.user.id };
}

async function seedUnclaimedUserInE2eDb(displayName: string): Promise<string> {
  const { dbName } = readE2eState();
  const baseAdminUrl =
    process.env.TEST_DATABASE_ADMIN_URL ??
    `postgres://postgres:postgres@localhost:${process.env.LOCAL_DB_PORT ?? 54320}/postgres`;
  const u = new URL(baseAdminUrl);
  u.pathname = `/${dbName}`;
  const client = new pg.Client({ connectionString: u.toString() });
  await client.connect();
  try {
    const {
      rows: [proj],
    } = await client.query<{ id: string }>(`SELECT id FROM projects LIMIT 1`);
    if (!proj) throw new Error('E2E 数据库未找到项目');
    const {
      rows: [usr],
    } = await client.query<{ id: string }>(
      `INSERT INTO users (login_name, display_name, password_hash, claimed_at)
       VALUES (NULL, $1, NULL, NULL)
       RETURNING id`,
      [displayName],
    );
    if (!usr) throw new Error('创建待认领用户失败');
    await client.query(
      `INSERT INTO memberships (project_id, user_id, role) VALUES ($1, $2, 'user')`,
      [proj.id, usr.id],
    );
    return usr.id;
  } finally {
    await client.end();
  }
}

test.describe('阶段 5 端到端验收（V1–V4 & V8：自由表格、/docs 在线表格、已搁置状态、待认领认领闭环与窄屏）', () => {
  let adminCookie = '';
  let userA: { cookie: string; userId: string };

  test.beforeAll(async ({ request }) => {
    adminCookie = await ensureAdminCookie(request);
    userA = await ensureUser(request, adminCookie, {
      loginName: USER_A_LOGIN,
      displayName: USER_A_NAME,
      password: USER_A_PW,
    });
  });

  test('V1 + V8: 自由表格（空白文档）无固定任务列、首列可自由改名、多行文本编辑与首页看板隔离', async ({
    browser,
    request,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await loginViaUi(page, USER_A_LOGIN, USER_A_PW);

      // 点击顶栏 + 新建自由表格（空白文档）
      await page.getByTestId('topbar-create-worksheet').click();
      await page.getByLabel('工作表名称').fill('五期自由表');
      await page.getByTestId('worksheet-template-free_blank').click();
      await page.getByRole('button', { name: '创建工作表' }).click();

      await expect(page).toHaveURL(/\/worksheets\/[0-9a-f-]+$/);
      const wsId = page.url().split('/worksheets/')[1] ?? '';
      await expect(page.getByTestId('topbar-worksheets')).toContainText('五期自由表');

      // 确认无任务固定列，有 3 列空白文本列
      const mainTable = page.getByTestId('worksheet-main-table');
      await expect(mainTable).not.toContainText('标题 / 分段');
      await expect(mainTable).not.toContainText('优先级');
      await expect(mainTable).not.toContainText('发布信息');
      await expect(mainTable).not.toContainText('分工说明');

      // 拉取工作表结构拿到列 ID
      const wsFull = (await (
        await request.get(`${ORIGIN}/api/worksheets/${wsId}`, {
          headers: { cookie: userA.cookie },
        })
      ).json()) as {
        worksheet: { kind: string };
        columns: Array<{ id: string; name: string }>;
      };
      expect(wsFull.worksheet.kind).toBe('free');
      expect(wsFull.columns.length).toBe(3);
      const col0 = wsFull.columns[0];
      expect(col0).toBeTruthy();

      // 新增一行数据
      await page.getByLabel('新建行首列内容').fill('自由首行');
      await page.getByLabel('新建行首列内容').press('Enter');
      await expect(mainTable).toContainText('自由首行');

      const row = page.locator('[data-task-row]', { hasText: '自由首行' });
      const rowId = (await row.getAttribute('data-task-row')) ?? '';
      expect(rowId).toBeTruthy();

      // 双击首格触发多行 textarea 编辑（Shift+Enter 换行，Enter 保存）
      await clickCanvasCell(page, rowId, col0?.id ?? '', true);
      const editor = page.getByTestId(`canvas-editor-${rowId}-${col0?.id ?? ''}`);
      const textarea = editor.locator('textarea');
      await expect(textarea).toBeVisible();
      await textarea.fill('第一行正文');
      await textarea.press('Shift+Enter');
      await textarea.type('第二行正文');
      await textarea.press('Enter');
      await expect(editor).toBeHidden();

      // 刷新确认多行内容落库不丢失
      await page.reload();
      const wsAfterEdit = (await (
        await request.get(`${ORIGIN}/api/worksheets/${wsId}`, {
          headers: { cookie: userA.cookie },
        })
      ).json()) as { tasks: Array<{ id: string; customValues: Record<string, string | null> }> };
      const editedRow = wsAfterEdit.tasks.find((t) => t.id === rowId);
      expect(editedRow?.customValues[col0?.id ?? '']).toBe('第一行正文\n第二行正文');

      // 首列可点击列头打开菜单并自由改名
      await clickCanvasHeader(page, col0?.id ?? '');
      const renameInput = page.getByLabel(`修改列名 ${col0?.name ?? '列 1'}`);
      await expect(renameInput).toBeVisible();
      await renameInput.fill('条款项');
      await renameInput.press('Enter');
      await expect(mainTable).toContainText('条款项');

      // 自由表格「新增列」弹层不提供「工序」类型
      await page.getByRole('button', { name: '新增列' }).click();
      await expect(page.getByRole('button', { name: '文本' })).toBeVisible();
      await expect(page.getByRole('button', { name: '工序' })).toHaveCount(0);
      await page.keyboard.press('Escape');

      // 390×844 手机端窄屏零横向溢出
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(mainTable).toBeVisible();
      await expectNoHorizontalOverflow(page);

      // 回到首页看板：自由表格与行内容彻底不上看板（主区域 main 不含自由表或行内容）
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto('/');
      await expect(page.locator('main')).not.toContainText('第一行正文');
      await expect(page.locator('main')).not.toContainText('五期自由表');
    } finally {
      await ctx.close();
    }
  });

  test('V2 + V8: /docs 双模式（在线表格默认展示 + 公共文件切换）、全局检索直达与窄屏验收', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await loginViaUi(page, USER_A_LOGIN, USER_A_PW);
      await page.goto('/docs');
      await expect(page.getByTestId('docs-tabs-bar')).toBeVisible();

      // 在 /docs 新建一张在线自由表格
      await page.getByTestId('docs-create-sheet-btn').click();
      await page.getByLabel('表格名称').fill('五期术语对照表');
      await page.getByRole('button', { name: '创建表格' }).click();

      await expect(page.getByTestId('docs-tabs-bar')).toContainText('五期术语对照表');
      await expect(page.getByTestId('docs-sheet-view')).toBeVisible();
      // 确认不出现在顶栏工作表轨
      await expect(page.getByTestId('topbar-worksheets')).not.toContainText('五期术语对照表');

      // 录入一行术语数据
      await page.getByLabel('新建行首列内容').fill('专有术语XYZ99');
      await page.getByLabel('新建行首列内容').press('Enter');
      await expect(page.getByTestId('worksheet-main-table')).toContainText('专有术语XYZ99');

      // 切到「公共文件」标签页正常可用
      await page.getByTestId('docs-files-tab').click();
      await expect(page.getByTestId('docs-create-btn')).toBeVisible();

      // 重新无参进入 /docs 默认选中首张在线表格
      await page.goto('/docs');
      await expect(page.getByTestId('docs-sheet-view')).toBeVisible();

      // 390×844 手机端 /docs 零横向溢出
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByTestId('docs-tabs-bar')).toBeVisible();
      await expectNoHorizontalOverflow(page);

      // 回到首页全局搜索「专有术语XYZ99」，在通用文档分区命中并直达 /docs?sheetId=...
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto('/');
      const searchInput = page.getByLabel('筛选关键词');
      await searchInput.fill('专有术语XYZ99');
      const dropdown = page.getByTestId('global-search-dropdown');
      await expect(dropdown).toBeVisible();
      await expect(dropdown.getByTestId('search-docs-section')).toContainText('专有术语XYZ99');
      await dropdown.getByTestId('search-docs-section').getByText('专有术语XYZ99').first().click();

      await expect(page).toHaveURL(/\/docs\?sheetId=/);
      await expect(page.getByTestId('docs-sheet-view')).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test('V3 + V8: 已搁置状态移出看板与我的任务、顶部与已发布并列折叠及一键恢复', async ({
    browser,
    request,
  }) => {
    const authHdr = { cookie: userA.cookie, origin: ORIGIN };
    // API 准备制作表、1 条待搁置任务（分配给 userA）、1 条已发布任务
    const wsRes = await request.post(`${ORIGIN}/api/worksheets`, {
      headers: authHdr,
      data: { name: '五期搁置验证表', color: 'slate', template: 'standard_video' },
    });
    expect(wsRes.ok()).toBe(true);
    const { worksheet, columns } = (await wsRes.json()) as {
      worksheet: { id: string };
      columns: Array<{ id: string; name: string; type: string }>;
    };
    const stageCol = columns.find((c) => c.type === 'stage');
    expect(stageCol).toBeTruthy();

    const t1Res = await request.post(`${ORIGIN}/api/worksheets/${worksheet.id}/tasks`, {
      headers: authHdr,
      data: { title: '五期待搁置任务' },
    });
    const t1 = (await t1Res.json()) as { id: string };
    await request.patch(`${ORIGIN}/api/tasks/${t1.id}/stages/${stageCol?.id}`, {
      headers: authHdr,
      data: {
        assignees: [{ type: 'user', userId: userA.userId }],
        status: 'in_progress',
        note: '',
        baseRevision: 0,
        force: true,
      },
    });

    const t2Res = await request.post(`${ORIGIN}/api/worksheets/${worksheet.id}/tasks`, {
      headers: authHdr,
      data: { title: '五期已发布任务' },
    });
    const t2 = (await t2Res.json()) as { id: string };
    await request.patch(`${ORIGIN}/api/tasks/${t2.id}`, {
      headers: authHdr,
      data: { changes: { publishStatus: 'published' }, force: true },
    });

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await loginViaUi(page, USER_A_LOGIN, USER_A_PW);
      // 首页可见「五期待搁置任务」
      await expect(page.locator('body')).toContainText('五期待搁置任务');

      // 进入工作表，顶部仅有「已发布（1 条）」
      await page.goto(`/worksheets/${worksheet.id}`);
      await expect(page.getByTestId('published-section')).toContainText('已发布（1 条）');
      await expect(page.getByTestId('shelved-section')).toHaveCount(0);

      // 点击发布信息格改为「已搁置」
      await clickCanvasCell(page, t1.id, 'publish');
      const pubPopover = page.getByTestId('publish-cell-popover');
      await expect(pubPopover).toBeVisible();
      await pubPopover.getByRole('button', { name: '已搁置', exact: true }).click();
      await pubPopover.getByRole('button', { name: '保存', exact: true }).click();

      // 移出主网格，顶部并列出现「已搁置（1 条）」
      await expect(page.getByTestId('worksheet-main-table')).not.toContainText('五期待搁置任务');
      await expect(page.getByTestId('published-section')).toContainText('已发布（1 条）');
      await expect(page.getByTestId('shelved-section')).toContainText('已搁置（1 条）');

      // 390×844 窄屏下并列折叠条无横向溢出
      await page.setViewportSize({ width: 390, height: 844 });
      await expectNoHorizontalOverflow(page);
      await page.setViewportSize({ width: 1280, height: 800 });

      // 首页看板与我的任务中彻底消失
      await page.goto('/');
      await expect(page.locator('body')).not.toContainText('五期待搁置任务');

      // 回到工作表展开已搁置区并一键「改为未发布」恢复
      await page.goto(`/worksheets/${worksheet.id}`);
      await page
        .getByTestId('shelved-section')
        .getByRole('button', { name: /已搁置（1 条）/ })
        .click();
      await expect(page.getByTestId('shelved-section')).toContainText('五期待搁置任务');
      await page.getByTestId('shelved-section').getByRole('button', { name: '改为未发布' }).click();

      await expect(page.getByTestId('shelved-section')).toHaveCount(0);
      await expect(page.getByTestId('worksheet-main-table')).toContainText('五期待搁置任务');

      // 回到首页再次可见
      await page.goto('/');
      await expect(page.locator('body')).toContainText('五期待搁置任务');
    } finally {
      await ctx.close();
    }
  });

  test('V4 + V8: 待认领用户筛选、生成/重发作废旧链接、/claim/:token 认领自动登录立见我的任务与零令牌泄漏', async ({
    browser,
    request,
  }) => {
    const authHdr = { cookie: adminCookie, origin: ORIGIN };
    // 1. 造一位待认领用户并预分配一条任务工序给他
    const unclaimedUserId = await seedUnclaimedUserInE2eDb('待认领小五');

    const wsRes = await request.post(`${ORIGIN}/api/worksheets`, {
      headers: authHdr,
      data: { name: '五期认领验证表', color: 'slate', template: 'standard_video' },
    });
    const { worksheet, columns } = (await wsRes.json()) as {
      worksheet: { id: string };
      columns: Array<{ id: string; type: string }>;
    };
    const stageCol = columns.find((c) => c.type === 'stage');
    const taskRes = await request.post(`${ORIGIN}/api/worksheets/${worksheet.id}/tasks`, {
      headers: authHdr,
      data: { title: '小五的预分配任务' },
    });
    const task = (await taskRes.json()) as { id: string };
    await request.patch(`${ORIGIN}/api/tasks/${task.id}/stages/${stageCol?.id}`, {
      headers: authHdr,
      data: {
        assignees: [{ type: 'user', userId: unclaimedUserId }],
        status: 'not_started',
        note: '',
        baseRevision: 0,
        force: true,
      },
    });

    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    const claimCtx = await browser.newContext();
    const claimPage = await claimCtx.newPage();

    try {
      // 2. 管理员进入 /admin/users 筛选待认领并连续生成两次链接
      await loginViaUi(adminPage, ADMIN_LOGIN, ADMIN_PW);
      await adminPage.goto('/admin/users');
      await adminPage.getByTestId('admin-users-filter-unclaimed').click();

      const userRow = adminPage.getByTestId(`admin-user-row-${unclaimedUserId}`);
      await expect(userRow).toContainText('待认领小五');
      await expect(userRow).toContainText('未生成');

      // 第一次生成认领链接
      await adminPage.getByTestId(`generate-claim-link-${unclaimedUserId}`).click();
      await adminPage.getByTestId('confirm-generate-claim-link').click();
      const linkInput = adminPage.getByTestId('one-time-link-input');
      await expect(linkInput).toBeVisible();
      const link1 = await linkInput.inputValue();
      expect(link1).toContain('/claim/');
      await adminPage.getByRole('button', { name: '我已保存' }).click();
      await expect(userRow).toContainText('有效至');

      // 第二次重新生成认领链接（自动作废旧链接）
      await adminPage.getByTestId(`generate-claim-link-${unclaimedUserId}`).click();
      await adminPage.getByTestId('confirm-generate-claim-link').click();
      await expect(linkInput).toBeVisible();
      const link2 = await linkInput.inputValue();
      expect(link2).toContain('/claim/');
      expect(link2).not.toBe(link1);
      await adminPage.getByRole('button', { name: '我已保存' }).click();

      // 390×844 /admin/users 窄屏零溢出
      await adminPage.setViewportSize({ width: 390, height: 844 });
      await expectNoHorizontalOverflow(adminPage);

      // 3. 未登录访问旧链接 link1 -> 统一提示无效或已过期
      await claimPage.goto(link1);
      await expect(claimPage.getByTestId('claim-invalid-card')).toContainText(
        '认领链接无效或已过期，请联系管理员',
      );

      // 4. 访问新链接 link2 -> 窄屏无溢出 -> 完成认领自动登录进入首页并立见「小五的预分配任务」
      await claimPage.setViewportSize({ width: 390, height: 844 });
      await claimPage.goto(link2);
      await expect(claimPage.getByTestId('claim-account-card')).toBeVisible();
      await expect(claimPage.getByLabel('显示名')).toHaveValue('待认领小五');
      await expectNoHorizontalOverflow(claimPage);

      await claimPage.setViewportSize({ width: 1280, height: 800 });
      await claimPage.getByLabel('登录名').fill('p5_claimed_five');
      await claimPage.getByLabel('密码', { exact: true }).fill('ClaimedPass_2026!');
      await claimPage.getByLabel('确认密码').fill('ClaimedPass_2026!');
      await claimPage.getByRole('button', { name: '完成认领并登录' }).click();

      await expect(claimPage).toHaveURL(/\/$/);
      await expect(claimPage.locator('body')).toContainText('小五的预分配任务');

      // 5. 校验服务端日志文件零认领令牌泄漏
      const { logPath } = readE2eState();
      const serverLog = readFileSync(logPath, 'utf8');
      const token1 = link1.split('/claim/')[1] ?? '';
      const token2 = link2.split('/claim/')[1] ?? '';
      expect(token1.length).toBeGreaterThan(10);
      expect(token2.length).toBeGreaterThan(10);
      expect(serverLog).not.toContain(token1);
      expect(serverLog).not.toContain(token2);
    } finally {
      await adminCtx.close();
      await claimCtx.close();
    }
  });
});
