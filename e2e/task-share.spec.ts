import { type APIRequestContext, expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, loginViaUi, readE2eState } from './helpers.js';

const ORIGIN = 'http://127.0.0.1:3100';
const ADMIN_LOGIN = 'admin_e2e';
const ADMIN_PW = 'AdminE2eSecret_2026!';
const SHARE_USER_LOGIN = 'share_alice';
const SHARE_USER_NAME = '分享测试爱丽丝';
const SHARE_USER_PW = 'ShareAlice_2026!';

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

async function ensureShareUser(
  request: APIRequestContext,
  adminCookie: string,
): Promise<{ userId: string; cookie: string }> {
  const tryLogin = await request.post(`${ORIGIN}/api/auth/login`, {
    headers: { origin: ORIGIN },
    data: { loginName: SHARE_USER_LOGIN, password: SHARE_USER_PW },
  });
  if (tryLogin.ok()) {
    const cookie = (tryLogin.headers()['set-cookie'] ?? '').match(/nw_session=[^;]+/)?.[0];
    const body = (await tryLogin.json()) as { user: { id: string } };
    if (cookie) return { userId: body.user.id, cookie };
  }

  const invRes = await request.post(`${ORIGIN}/api/invites`, {
    headers: { cookie: adminCookie, origin: ORIGIN },
    data: { role: 'user', expiresInDays: 1, maxUses: 1 },
  });
  expect(invRes.ok()).toBe(true);
  const { url: inviteUrl } = (await invRes.json()) as { url: string };
  const token = inviteUrl.split('/invite/')[1];
  const regRes = await request.post(`${ORIGIN}/api/invites/by-token/${token}/register`, {
    headers: { origin: ORIGIN },
    data: {
      loginName: SHARE_USER_LOGIN,
      displayName: SHARE_USER_NAME,
      password: SHARE_USER_PW,
    },
  });
  expect(regRes.ok()).toBe(true);
  const cookie = (regRes.headers()['set-cookie'] ?? '').match(/nw_session=[^;]+/)?.[0];
  if (!cookie) throw new Error('注册未返回会话 Cookie');
  const me = (await (
    await request.get(`${ORIGIN}/api/auth/me`, { headers: { cookie } })
  ).json()) as { user: { id: string } };
  return { userId: me.user.id, cookie };
}

test.describe('任务与工序快速分享 + 无状态短链定位', () => {
  test('完整闭环：任务/工序复制格式、完工 Toast 交接分享、桌面直开资源浮层、未登录回跳与 390×844 窄屏降级', async ({
    browser,
    request,
  }) => {
    const adminCookie = await ensureAdminCookie(request);
    const alice = await ensureShareUser(request, adminCookie);

    // 1. 造数：工作表 + 作品 + 任务 + 多态工序（含备注）+ 工序资源
    const wsRes = await request.post(`${ORIGIN}/api/worksheets`, {
      headers: { cookie: adminCookie, origin: ORIGIN },
      data: { name: '快速分享测试表', color: 'sky', template: 'standard_video' },
    });
    expect(wsRes.status()).toBe(201);
    const { worksheet, columns } = (await wsRes.json()) as {
      worksheet: { id: string };
      columns: Array<{ id: string; name: string; type: string }>;
    };
    const timingCol = columns.find((c) => c.name === '时轴');
    const transCol = columns.find((c) => c.name === '翻译');
    const proofCol = columns.find((c) => c.name === '校对');
    const typesetCol = columns.find((c) => c.name === '嵌字');
    expect(timingCol && transCol && proofCol && typesetCol).toBeTruthy();

    const taskRes = await request.post(`${ORIGIN}/api/worksheets/${worksheet.id}/tasks`, {
      headers: { cookie: adminCookie, origin: ORIGIN },
      data: { title: 'P1 00:00-15:00', workName: '分享专题演唱会' },
    });
    expect(taskRes.status()).toBe(201);
    const task = (await taskRes.json()) as { id: string };

    // 时轴：已完成 + 写备注（验证分享文本不附带备注）
    await request.patch(`${ORIGIN}/api/tasks/${task.id}/stages/${timingCol!.id}`, {
      headers: { cookie: adminCookie, origin: ORIGIN },
      data: {
        assignees: [{ type: 'text', name: '轴君' }],
        status: 'done',
        note: '这是内部备注不应出现在分享里',
        baseRevision: 0,
      },
    });
    // 翻译：Alice 进行中（用于在首页「我的任务」点完成并触发交接分享 Toast）
    await request.patch(`${ORIGIN}/api/tasks/${task.id}/stages/${transCol!.id}`, {
      headers: { cookie: adminCookie, origin: ORIGIN },
      data: {
        assignees: [{ type: 'user', userId: alice.userId }],
        status: 'in_progress',
        note: '翻译内部备注',
        baseRevision: 0,
      },
    });
    // 校对：空缺（默认 not_started 且无负责人）
    // 嵌字：已认领未开始
    await request.patch(`${ORIGIN}/api/tasks/${task.id}/stages/${typesetCol!.id}`, {
      headers: { cookie: adminCookie, origin: ORIGIN },
      data: {
        assignees: [{ type: 'text', name: '后期小王' }],
        status: 'not_started',
        baseRevision: 0,
      },
    });

    // 为「翻译」工序挂 1 个资源（验证短链直开资源卡片能看到该资源）
    const artRes = await request.post(`${ORIGIN}/api/artifacts`, {
      headers: { cookie: alice.cookie, origin: ORIGIN },
      data: {
        scope: { kind: 'stage', taskId: task.id, stageColumnId: transCol!.id },
        name: '翻译初稿.ass',
        initialLocation: {
          provider: 'baidu',
          url: 'https://pan.baidu.com/s/1sharetest123',
          extractCode: 'abcd',
          isFolder: false,
        },
      },
    });
    expect(artRes.status()).toBe(201);

    // 2. 开启带剪贴板权限的桌面上下文，登录 Alice
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await ctx.newPage();
    await loginViaUi(page, SHARE_USER_LOGIN, SHARE_USER_PW);

    // 2a. 在首页看板卡片点击「分享」按钮 -> 校验行首圆点格式、无备注、无提取码、短链格式
    const boardShareBtn = page.getByTestId(`card-share-btn-${task.id}-${transCol!.id}`);
    await expect(boardShareBtn).toBeVisible();
    await boardShareBtn.click();
    await expect(page.getByText('已复制任务进度与链接')).toBeVisible();

    const taskShareText = await page.evaluate(() => navigator.clipboard.readText());
    expect(taskShareText).toContain('分享专题演唱会 - P1 00:00-15:00');
    expect(taskShareText).toContain('🟢 时轴：轴君');
    expect(taskShareText).toContain(`🟠 翻译：${SHARE_USER_NAME}`);
    expect(taskShareText).toContain('🔴 校对：空缺');
    expect(taskShareText).toContain('⚪ 嵌字：后期小王');
    expect(taskShareText).not.toContain('这是内部备注不应出现在分享里');
    expect(taskShareText).not.toContain('abcd');
    const taskUrlMatch = taskShareText.match(/https?:\/\/\S+\/t\/[A-Za-z0-9_-]{22}/);
    expect(taskUrlMatch).toBeTruthy();
    const taskShortUrl = taskUrlMatch![0];

    // 2b. 在左侧「我的任务」点「完成」-> Toast 出现「复制交接分享」-> 点击复制并验证状态更新为 🟢 + 工序短链
    const myTaskCard = page.getByTestId(`my-in-progress-item-${task.id}-${transCol!.id}`);
    await expect(myTaskCard).toBeVisible();
    await myTaskCard.getByRole('button', { name: '完成' }).click();

    const handoverBtn = page.getByRole('button', { name: '复制交接分享' });
    await expect(handoverBtn).toBeVisible();
    await handoverBtn.click();
    await expect(page.getByText('已复制「翻译」工序分享')).toBeVisible();

    const stageShareText = await page.evaluate(() => navigator.clipboard.readText());
    expect(stageShareText).toContain('分享专题演唱会 - P1 00:00-15:00 · 翻译');
    expect(stageShareText).toContain(`🟢 翻译：${SHARE_USER_NAME}（本次分享 · 1 个资源）`);
    expect(stageShareText).not.toContain('翻译内部备注');
    const stageUrlMatch = stageShareText.match(
      /https?:\/\/\S+\/t\/[A-Za-z0-9_-]{22}\/[A-Za-z0-9_-]{22}/,
    );
    expect(stageUrlMatch).toBeTruthy();
    const stageShortUrl = stageUrlMatch![0];

    // 3. 桌面端直接访问「工序短链」-> 自动定位工作表并直接弹出「翻译 · 工序资源」浮层
    await page.goto(stageShortUrl);
    await expect(page).toHaveURL(new RegExp(`/worksheets/${worksheet.id}$`));
    const quickPopover = page.getByTestId('artifact-quick-popover');
    await expect(quickPopover).toBeVisible();
    await expect(quickPopover).toContainText('翻译 · 工序资源');
    await expect(quickPopover).toContainText('翻译初稿.ass');
    // 资源浮层顶栏也支持直接分享本工序
    await expect(page.getByTestId('quick-popover-share-btn')).toBeVisible();
    await expect(page.getByTestId('task-detail-drawer')).toHaveCount(0);

    // 4. 桌面端直接访问「任务短链」-> 自动打开任务详情侧栏
    await page.goto(taskShortUrl);
    await expect(page).toHaveURL(new RegExp(`/worksheets/${worksheet.id}$`));
    await expect(page.getByTestId('task-detail-drawer')).toBeVisible();
    await expect(page.getByTestId('drawer-share-task-btn')).toBeVisible();
    await expect(page.getByTestId(`drawer-share-stage-${transCol!.id}`)).toBeVisible();

    // 5. 非法短链给出友好提示页
    await page.goto(`${ORIGIN}/t/invalid-short-code`);
    await expect(page.getByTestId('short-link-error')).toBeVisible();

    await ctx.close();

    // 6. 未登录访问工序短链 -> 跳转 /login?next=... -> 登录后自动直达资源浮层（桌面）
    const anonCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const anonPage = await anonCtx.newPage();
    await anonPage.goto(stageShortUrl);
    await expect(anonPage).toHaveURL(/\/login\?next=/);
    await anonPage.getByLabel('登录名').fill(SHARE_USER_LOGIN);
    await anonPage.getByLabel('密码').fill(SHARE_USER_PW);
    await anonPage.getByRole('button', { name: '登录' }).click();
    await expect(anonPage).toHaveURL(new RegExp(`/worksheets/${worksheet.id}$`));
    await expect(anonPage.getByTestId('artifact-quick-popover')).toBeVisible();
    await expect(anonPage.getByTestId('artifact-quick-popover')).toContainText('翻译初稿.ass');
    await anonCtx.close();

    // 7. 手机窄屏 390×844 访问工序短链 -> 自动降级打开全屏任务详情侧栏并展示对应工序卡片且无横向溢出
    const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobilePage = await mobileCtx.newPage();
    await loginViaUi(mobilePage, SHARE_USER_LOGIN, SHARE_USER_PW);
    await mobilePage.goto(stageShortUrl);
    await expect(mobilePage).toHaveURL(new RegExp(`/worksheets/${worksheet.id}$`));
    await expect(mobilePage.getByTestId('task-detail-drawer')).toBeVisible();
    await expect(mobilePage.getByTestId(`drawer-stage-files-${transCol!.id}`)).toBeVisible();
    await expect(mobilePage.getByTestId(`drawer-stage-files-${transCol!.id}`)).toContainText(
      '翻译初稿.ass',
    );
    await expectNoHorizontalOverflow(mobilePage);
    await mobileCtx.close();
  });
});
