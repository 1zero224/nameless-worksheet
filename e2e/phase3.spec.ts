import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { expectNoHorizontalOverflow, loginViaUi, readE2eState } from './helpers.js';

const ORIGIN = 'http://127.0.0.1:3100';
const ADMIN_PW = 'AdminE2eSecret_2026!';
const USER_A_LOGIN = 'p3_alice';
const USER_A_NAME = '三期小爱';
const USER_A_PW = 'Phase3Alice_2026!';
const USER_B_LOGIN = 'p3_bob';
const USER_B_NAME = '三期小博';
const USER_B_PW = 'Phase3Bob_2026!';

interface GridGeometryHost extends HTMLDivElement {
  __nwGridGeometry?: {
    getCellPoint: (taskId: string, columnKey: string) => { x: number; y: number } | null;
    getStageBadgePoint: (taskId: string, columnKey: string) => { x: number; y: number } | null;
    getHeaderPoint: (columnKey: string) => { x: number; y: number } | null;
    getRowExpandPoint: (taskId: string) => { x: number; y: number } | null;
  };
}

async function waitForCanvasPoint(
  page: Page,
  fn: 'getCellPoint' | 'getStageBadgePoint',
  taskId: string,
  columnKey: string,
) {
  let pt: { x: number; y: number } | null = null;
  await expect
    .poll(async () => {
      pt = await page.getByTestId('worksheet-canvas-grid').evaluate(
        (el, { method, tId, cKey }) => {
          return (el as GridGeometryHost).__nwGridGeometry?.[method](tId, cKey) ?? null;
        },
        { method: fn, tId: taskId, cKey: columnKey },
      );
      return pt !== null;
    })
    .toBe(true);
  if (!pt) throw new Error(`Canvas point not found: ${fn}(${taskId}, ${columnKey})`);
  return pt as { x: number; y: number };
}

async function clickCanvasPoint(
  page: Page,
  fn: 'getCellPoint' | 'getStageBadgePoint',
  taskId: string,
  columnKey: string,
  options?: { button?: 'left' | 'right' },
) {
  const pt = await waitForCanvasPoint(page, fn, taskId, columnKey);
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.click(pt.x, pt.y, options);
  return pt;
}

async function ensureAdminCookie(request: APIRequestContext): Promise<string> {
  const tryLogin = await request.post(`${ORIGIN}/api/auth/login`, {
    headers: { origin: ORIGIN },
    data: { loginName: 'admin_e2e', password: ADMIN_PW },
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
    data: { loginName: 'admin_e2e', password: ADMIN_PW },
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

test.describe('阶段 3 端到端验收（V1–V12：四级挂载、版本历史、网盘入口、通用文档与实时同步）', () => {
  let adminCookie = '';
  let userA: { cookie: string; userId: string };

  test.beforeAll(async ({ request }) => {
    adminCookie = await ensureAdminCookie(request);
    userA = await ensureUser(request, adminCookie, {
      loginName: USER_A_LOGIN,
      displayName: USER_A_NAME,
      password: USER_A_PW,
    });
    await ensureUser(request, adminCookie, {
      loginName: USER_B_LOGIN,
      displayName: USER_B_NAME,
      password: USER_B_PW,
    });
  });

  test('V1 + V3 + V4 + V5 + V6 + V9: 通用文档、分享文本解析、多入口、版本历史与回退、改名移动、修改记录恢复与融合检索', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginViaUi(page, USER_A_LOGIN, USER_A_PW);

    // 顶栏「任务看板」右侧可见「通用文档」标签，无「参考资料」「回收站」
    await expect(page.getByTestId('topbar-docs-tab')).toBeVisible();
    await expect(page.getByRole('link', { name: '参考资料' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '回收站' })).toHaveCount(0);

    await page.getByTestId('topbar-docs-tab').click();
    await expect(page).toHaveURL(/\/docs$/);
    await expect(page.getByRole('heading', { name: '通用文档' })).toBeVisible();

    // V3: 粘贴整段百度网盘分享文本自动解析并一步创建通用文档
    await page.getByTestId('docs-create-btn').click();
    await page
      .getByTestId('share-paste-input')
      .fill(
        '通过网盘分享的文件：字幕组术语对照表\n链接：https://pan.baidu.com/s/1p3doc001 \n提取码：ab12',
      );
    await expect(page.getByTestId('share-paste-hint')).toContainText('百度网盘');
    await expect(page.getByTestId('artifact-url-input')).toHaveValue(
      'https://pan.baidu.com/s/1p3doc001',
    );
    await expect(page.getByTestId('artifact-code-input')).toHaveValue('ab12');
    await expect(page.getByTestId('artifact-name-input')).toHaveValue('字幕组术语对照表');
    await page.getByTestId('artifact-submit-btn').click();

    const docCard = page
      .locator('[data-testid^="artifact-card-"]', { hasText: '字幕组术语对照表' })
      .first();
    await expect(docCard).toBeVisible();
    const docId = ((await docCard.getAttribute('data-testid')) ?? '').replace('artifact-card-', '');
    expect(docId).toBeTruthy();

    await expect(page.getByTestId(`artifact-latest-badge-${docId}`)).toHaveText('v1');
    await expect(docCard).toContainText('百度网盘');
    await expect(docCard).toContainText('ab12');
    await expect(docCard.getByRole('link', { name: '打开链接' })).toHaveAttribute(
      'target',
      '_blank',
    );
    await expect(docCard.getByRole('link', { name: '打开链接' })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );

    // V3: 同版本通过 ··· 菜单补充第二个多网盘链接（MEGA）-> 不升版本号
    await page.getByTestId(`artifact-menu-${docId}`).click();
    await page.getByTestId(`artifact-add-location-${docId}`).click();
    await page.getByTestId('location-url-input').fill('https://mega.nz/file/p3mirror001');
    await page.getByTestId('location-submit-btn').click();
    await expect(docCard).toContainText('MEGA');
    await expect(page.getByTestId(`artifact-latest-badge-${docId}`)).toHaveText('v1');

    // V4: 登记新版本 v2（留空链接 -> 0 入口「待补充入口」）
    await page.getByTestId(`artifact-add-version-${docId}`).click();
    await page.getByTestId('version-note-input').fill('2026 修订版');
    await page.getByTestId('version-submit-btn').click();
    await expect(page.getByTestId(`artifact-latest-badge-${docId}`)).toHaveText('v2');
    await expect(docCard).toContainText('2026 修订版');
    await expect(docCard).toContainText('待补充多网盘');

    // 展开历史版本，删最新版 v2 需弹窗确认 -> 自动回退至 v1
    await page.getByTestId(`artifact-history-toggle-${docId}`).click();
    const historyBox = page.getByTestId(`artifact-history-${docId}`);
    await expect(historyBox).toContainText('v2');
    await expect(historyBox).toContainText('v1');

    const v2DeleteBtn = historyBox
      .locator('[data-testid^="version-item-"]', { hasText: '2026 修订版' })
      .locator('[data-testid^="delete-version-"]');
    await v2DeleteBtn.click();
    await expect(page.getByRole('heading', { name: '确认删除最新版本' })).toBeVisible();
    await page.getByRole('button', { name: '确认删除' }).click();
    await expect(page.getByTestId(`artifact-latest-badge-${docId}`)).toHaveText('v1');

    // V6: 从通用文档修改记录抽屉恢复 v2 -> 自动重新以 v2 为最新
    await page.getByTestId('docs-change-logs-btn').click();
    const verDelLog = page.getByTestId('change-log-item-artifact_version.deleted').first();
    await expect(verDelLog).toBeVisible();
    await verDelLog.getByRole('button', { name: '恢复' }).click();
    await expect(verDelLog).toContainText('已恢复');
    await page.getByRole('button', { name: '关闭侧栏' }).click();
    await expect(page.getByTestId(`artifact-latest-badge-${docId}`)).toHaveText('v2');

    // V5: 改名不升版本号
    await page.getByTestId(`artifact-menu-${docId}`).click();
    await page.getByRole('menuitem', { name: '改名 / 移动归属' }).click();
    await page.getByTestId('edit-artifact-name-input').fill('字幕组术语规范-已改名');
    await page.getByTestId('edit-artifact-submit').click();
    await expect(page.getByTestId(`artifact-card-${docId}`)).toContainText('字幕组术语规范-已改名');
    await expect(page.getByTestId(`artifact-latest-badge-${docId}`)).toHaveText('v2');

    // V6: 软删通用文档 -> 从修改记录恢复
    await page.getByTestId(`artifact-menu-${docId}`).click();
    await page.getByRole('menuitem', { name: '删除资源' }).click();
    await expect(page.getByTestId(`artifact-card-${docId}`)).toHaveCount(0);

    await page.getByTestId('docs-change-logs-btn').click();
    const artDelLog = page.getByTestId('change-log-item-artifact.deleted').first();
    await artDelLog.getByRole('button', { name: '恢复' }).click();
    await page.getByRole('button', { name: '关闭侧栏' }).click();
    await expect(page.getByTestId(`artifact-card-${docId}`)).toBeVisible();

    // V9: 首页融合检索命中通用文档并直达定位，且绝不命中提取码
    await page.getByTestId('top-nav-tabs').getByRole('link', { name: '任务看板' }).click();
    const searchInput = page.getByLabel('筛选关键词');
    await searchInput.click();
    await searchInput.fill('ab12');
    await expect(page.getByTestId('global-search-dropdown')).toContainText(
      '没有找到匹配的任务、资源或通用文档',
    );

    await searchInput.fill('术语规范-已改名');
    const docsSection = page.getByTestId('search-docs-section');
    await expect(docsSection).toContainText('字幕组术语规范-已改名');
    await page.getByTestId(`search-doc-result-${docId}`).click();
    await expect(page).toHaveURL(/\/docs/);
    await expect(page.getByTestId(`artifact-card-${docId}`)).toBeVisible();

    await ctx.close();
  });

  test('V1 + V2 + V7 + V8: 四级挂载（作品横幅直跳/弹窗、0 任务空作品刷新保留、工序格角标、删列降级、解散分组保护与看板弹层）', async ({
    browser,
    request,
  }) => {
    const authHdr = { cookie: userA.cookie, origin: ORIGIN };
    const wsName = `阶段3资源表-${Date.now().toString(36)}`;
    // API 预置一张工作表 + 1 个空作品（0 任务），让前端全程交互走真实 UI
    const wsRes = await request.post(`${ORIGIN}/api/worksheets`, {
      headers: authHdr,
      data: { name: wsName, template: 'standard_video' },
    });
    expect(wsRes.ok()).toBe(true);
    const { worksheet, columns } = (await wsRes.json()) as {
      worksheet: { id: string };
      columns: Array<{ id: string; name: string; type: string }>;
    };
    const timingCol = columns.find((c) => c.name === '时轴')!;

    const workRes = await request.post(`${ORIGIN}/api/worksheets/${worksheet.id}/works`, {
      headers: authHdr,
      data: { name: '5th-BD' },
    });
    expect(workRes.ok()).toBe(true);
    const work = (await workRes.json()) as { id: string; name: string };

    // 先挂 1 个无提取码单入口共用资源（验证 0 任务空作品刷新不消失 & 单入口直跳）
    const directWorkArtRes = await request.post(`${ORIGIN}/api/artifacts`, {
      headers: authHdr,
      data: {
        scope: { kind: 'work', workId: work.id },
        name: '全篇原片',
        location: { url: 'https://mega.nz/file/p3workraw', isFolder: false },
      },
    });
    expect(directWorkArtRes.ok()).toBe(true);
    const directWorkArt = (await directWorkArtRes.json()) as { id: string };

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginViaUi(page, USER_A_LOGIN, USER_A_PW);
    await page.goto(`/worksheets/${worksheet.id}`);

    // V8: 0 任务但有共用资源的作品横幅刷新后仍可见，无提取码单入口胶囊为 <a> 直跳
    await expect(page.getByTestId(`work-banner-${work.id}`)).toBeVisible();
    const directCapsule = page.getByTestId(`work-capsule-direct-${directWorkArt.id}`);
    await expect(directCapsule).toHaveAttribute('href', 'https://mega.nz/file/p3workraw');
    await expect(directCapsule).toHaveAttribute('target', '_blank');

    // 通过作品横幅 `+ 附件` 再挂两个带提取码的共用资源，并验证点击切换不同作品资源弹窗不会闪退
    await page.getByTestId(`work-add-attachment-${work.id}`).click();
    await page.getByTestId('quick-popover-add-btn').click();
    // 新建资源窗口弹出时，背后的资源浮层已自动关闭（只聚焦新建资源窗口）
    await expect(page.getByTestId('artifact-quick-popover')).toHaveCount(0);
    await expect(page.getByTestId('artifact-scope-tags')).toContainText(wsName);
    await expect(page.getByTestId('artifact-scope-tags')).toContainText('5th-BD');
    await page
      .getByTestId('share-paste-input')
      .fill('通用字体包 https://pan.baidu.com/s/1p3fonts 提取码：f0nt');
    await page.getByTestId('artifact-name-input').fill('通用字体包');
    await page.getByTestId('artifact-submit-btn').click();

    await expect(page.locator(`[data-work-attachment-slots="${work.id}"]`)).toContainText(
      '通用字体包',
    );

    // 挂第二个带提取码的共用资源（验证连续点击同一作品的两个共用资源胶囊弹窗稳定切换不闪退）
    const extraWorkArtRes = await request.post(`${ORIGIN}/api/artifacts`, {
      headers: authHdr,
      data: {
        scope: { kind: 'work', workId: work.id },
        name: '场刊扫描',
        location: {
          url: 'https://pan.baidu.com/s/1p3booklet',
          extractCode: 'bk22',
          isFolder: false,
        },
      },
    });
    expect(extraWorkArtRes.ok()).toBe(true);
    const extraWorkArt = (await extraWorkArtRes.json()) as { id: string };

    await page.reload();
    await expect(page.getByTestId(`work-banner-${work.id}`)).toBeVisible();
    const fontCapsule = page
      .locator(`[data-work-attachment-slots="${work.id}"] [data-testid^="work-capsule-popover-"]`, {
        hasText: '通用字体包',
      })
      .first();
    const bookletCapsule = page.getByTestId(`work-capsule-popover-${extraWorkArt.id}`);
    await fontCapsule.click();
    await expect(page.getByTestId('artifact-quick-popover')).toContainText('f0nt');
    // 直接点击同一作品的另一个共用资源胶囊 -> 浮层切换后保持稳定打开并显示新资源提取码
    await bookletCapsule.click();
    await expect(page.getByTestId('artifact-quick-popover')).toBeVisible();
    await expect(page.getByTestId('artifact-quick-popover')).toContainText('bk22');
    await page.getByTestId('quick-popover-close-btn').click();
    await expect(page.getByTestId('artifact-quick-popover')).toHaveCount(0);

    // 为作品添加一条分段任务，并让当前用户认领「时轴」为进行中（以便出现在看板与我的任务）
    const taskRes = await request.post(`${ORIGIN}/api/worksheets/${worksheet.id}/tasks`, {
      headers: authHdr,
      data: { title: 'Disc 1 正片', workId: work.id },
    });
    expect(taskRes.ok()).toBe(true);
    const task = (await taskRes.json()) as { id: string };

    await request.patch(`${ORIGIN}/api/tasks/${task.id}/stages/${timingCol.id}`, {
      headers: authHdr,
      data: {
        assignees: [{ type: 'user', userId: userA.userId }],
        status: 'in_progress',
        note: '先校时间轴',
        baseRevision: 0,
        force: true,
      },
    });

    await page.reload();
    await expect(page.getByTestId(`work-banner-${work.id}`)).toBeVisible();

    // V1: 点击「时轴」工序格 -> 点击「+ 添加资源」-> 验证亮色层级标签与默认资源名「作品名-任务名-工序」
    await clickCanvasPoint(page, 'getCellPoint', task.id, timingCol.id);
    await expect(page.getByTestId('stage-cell-popover')).toBeVisible();
    await page.getByTestId('stage-popover-manage-artifacts').click();
    await expect(page.getByTestId('artifact-quick-popover')).toBeVisible();
    await page.getByTestId('quick-popover-add-btn').click();
    await expect(page.getByTestId('artifact-quick-popover')).toHaveCount(0);
    await expect(page.getByTestId('artifact-scope-tags')).toContainText(wsName);
    await expect(page.getByTestId('artifact-scope-tags')).toContainText('5th-BD');
    await expect(page.getByTestId('artifact-scope-tags')).toContainText('Disc 1 正片');
    await expect(page.getByTestId('artifact-scope-tags')).toContainText('时轴');
    await expect(page.getByTestId('artifact-name-input')).toHaveValue('5th-BD-Disc 1 正片-时轴');
    await page
      .getByTestId('share-paste-input')
      .fill('https://pan.quark.cn/s/p3timingv1 提取码：qk88');
    await page.getByTestId('artifact-submit-btn').click();
    await expect(page.getByTestId('artifact-create-form')).toHaveCount(0);

    // 直接点击 Canvas 工序格右侧角标热区 -> 弹出靠左对齐的轻量快速取用浮层（非大侧栏）
    await clickCanvasPoint(page, 'getStageBadgePoint', task.id, timingCol.id);
    const quickPop = page.getByTestId('artifact-quick-popover');
    await expect(quickPop).toBeVisible();
    await expect(quickPop).toContainText('5th-BD-Disc 1 正片-时轴');
    await expect(quickPop).toContainText('qk88');
    await expect(quickPop.getByRole('button', { name: '复制提取码' })).toBeVisible();
    await page.keyboard.press('Escape');

    // 右键「时轴」单元格 -> 点击「查看单元格修改记录」-> 仅展示该单元格的修改记录并支持切至整条任务
    await clickCanvasPoint(page, 'getCellPoint', task.id, timingCol.id, { button: 'right' });
    await expect(page.getByTestId('context-menu-cell-history')).toBeVisible();
    await page.getByTestId('context-menu-cell-history').click();
    await expect(page.getByTestId('cell-history-scope-bar')).toContainText('Disc 1 正片');
    await expect(page.getByTestId('cell-history-scope-bar')).toContainText('时轴');
    await expect(page.getByTestId('change-log-list')).toContainText('时轴');
    await page.getByRole('button', { name: '关闭侧栏' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // 点击固定「文件」列 -> 打开 TaskDetailDrawer，作品共用资源位于最下方，上方按工序与任务分组
    await clickCanvasPoint(page, 'getCellPoint', task.id, 'files');
    const drawer = page.getByTestId('task-detail-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('work-shared-attachments-slot')).toContainText('全篇原片');
    await expect(page.getByTestId('work-shared-attachments-slot')).toContainText('通用字体包');
    await expect(page.getByTestId(`drawer-stage-files-${timingCol.id}`)).toContainText(
      '5th-BD-Disc 1 正片-时轴',
    );
    // 验证作品共用资源卡片位于任务文件区的下方（而非顶部）
    const taskFilesBox = await page.getByTestId('task-files-section').boundingBox();
    const workSharedBox = await page.getByTestId('work-shared-attachments-slot').boundingBox();
    expect(taskFilesBox && workSharedBox && workSharedBox.y > taskFilesBox.y).toBe(true);

    // 在详情侧栏新建任务级资源
    await page.getByTestId('drawer-add-task-artifact').click();
    await page.getByTestId('artifact-name-input').fill('任务校对备注');
    await page.getByTestId('artifact-url-input').fill('https://www.alipan.com/s/p3tasknote');
    await page.getByTestId('artifact-submit-btn').click();
    await expect(page.getByTestId('drawer-task-other-files')).toContainText('任务校对备注');
    await page.getByRole('button', { name: '关闭侧栏' }).click();

    // V2: 首页看板与左侧「我的任务」竖栏点击资源弹层直接取用作品共用 + 本列工序 + 任务资源
    await page.getByTestId('top-nav-tabs').getByRole('link', { name: '任务看板' }).click();
    await expect(page).toHaveURL(/\/$/);
    const boardCardResBtn = page
      .getByTestId('board-columns')
      .getByTestId(`card-resources-btn-${task.id}`)
      .first();
    await expect(boardCardResBtn).toContainText('5'); // 3 work shared + 1 stage + 1 task
    await boardCardResBtn.click();
    const resPopover = page.getByTestId(`task-resources-popover-${task.id}`);
    await expect(resPopover).toContainText('全篇原片');
    await expect(resPopover).toContainText('5th-BD-Disc 1 正片-时轴');
    await expect(resPopover).toContainText('任务校对备注');
    await expect(resPopover.getByRole('button', { name: '复制提取码' }).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(resPopover).toHaveCount(0);

    // 左侧「我的任务」竖栏同样可直接打开资源弹层
    const myTaskResBtn = page
      .getByTestId('my-in-progress-bar')
      .getByTestId(`card-resources-btn-${task.id}`)
      .first();
    await expect(myTaskResBtn).toBeVisible();
    await myTaskResBtn.click();
    await expect(page.getByTestId(`task-resources-popover-${task.id}`)).toContainText('全篇原片');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId(`task-resources-popover-${task.id}`)).toHaveCount(0);

    // V7: 回到工作表删除「时轴」工序列 -> 原工序资源降级为任务级并保留原名
    await page.goto(`/worksheets/${worksheet.id}`);
    const delColRes = await request.delete(
      `${ORIGIN}/api/worksheets/${worksheet.id}/columns/${timingCol.id}`,
      { headers: authHdr },
    );
    expect(delColRes.status()).toBe(204);
    await page.reload();

    await clickCanvasPoint(page, 'getCellPoint', task.id, 'files');
    await expect(page.getByTestId('drawer-task-other-files')).toContainText(
      '5th-BD-Disc 1 正片-时轴',
    );
    await page.getByRole('button', { name: '关闭侧栏' }).click();

    // V8: 解散分组保护（默认保留作品横幅与共用资源；勾选后一并软删并可在修改记录恢复）
    await page.getByRole('button', { name: `作品操作 ${work.name}` }).click();
    await page.getByRole('menuitem', { name: '解散分组（移出任务）' }).click();
    await expect(page.getByTestId('ungroup-shared-dialog')).toContainText('3 个共用资源');
    await expect(page.getByTestId('ungroup-delete-shared-checkbox')).not.toBeChecked();
    await page.getByTestId('ungroup-confirm-btn').click();
    // 默认保留 -> 作品横幅与共用资源仍在
    await expect(page.getByTestId(`work-banner-${work.id}`)).toBeVisible();

    // 再次解散并勾选同时删除共用资源 -> 作品横幅消失
    await page.getByRole('button', { name: `作品操作 ${work.name}` }).click();
    await page.getByRole('menuitem', { name: '解散分组（移出任务）' }).click();
    await page.getByTestId('ungroup-delete-shared-checkbox').check();
    await page.getByTestId('ungroup-confirm-btn').click();
    await expect(page.getByTestId(`work-banner-${work.id}`)).toHaveCount(0);

    // 从修改记录恢复被删共用资源 -> 作品横幅重新可见
    await page.getByRole('button', { name: '修改记录' }).click();
    const deletedSharedLog = page.getByTestId('change-log-item-artifact.deleted').first();
    await deletedSharedLog.getByRole('button', { name: '恢复' }).click();
    await page.getByRole('button', { name: '关闭侧栏' }).click();
    await expect(page.getByTestId(`work-banner-${work.id}`)).toBeVisible();

    await ctx.close();
  });

  test('V10 + V12: 双浏览器实时同步（通用文档与工作表资源）与 390×844 手机窄屏零横向溢出', async ({
    browser,
    request,
  }) => {
    const authHdr = { cookie: userA.cookie, origin: ORIGIN };
    const wsRes = await request.post(`${ORIGIN}/api/worksheets`, {
      headers: authHdr,
      data: { name: `实时同步资源表-${Date.now().toString(36)}`, template: 'standard_video' },
    });
    const { worksheet } = (await wsRes.json()) as { worksheet: { id: string } };
    const work = (await (
      await request.post(`${ORIGIN}/api/worksheets/${worksheet.id}/works`, {
        headers: authHdr,
        data: { name: '实时作品' },
      })
    ).json()) as { id: string; name: string };
    await request.post(`${ORIGIN}/api/worksheets/${worksheet.id}/tasks`, {
      headers: authHdr,
      data: { title: '实时任务 P1', workId: work.id },
    });

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await loginViaUi(pageA, USER_A_LOGIN, USER_A_PW);
    await loginViaUi(pageB, USER_B_LOGIN, USER_B_PW);

    // 1) 通用文档实时同步
    await pageA.goto('/docs');
    await pageB.goto('/docs');

    await pageA.getByTestId('docs-create-btn').click();
    await pageA.getByTestId('artifact-name-input').fill('双端实时通用文档');
    await pageA.getByTestId('artifact-url-input').fill('https://mega.nz/file/syncdoc01');
    await pageA.getByTestId('artifact-submit-btn').click();

    await expect(pageB.getByTestId('docs-page')).toContainText('双端实时通用文档');

    // 2) 工作表作品横幅资源实时同步
    await pageA.goto(`/worksheets/${worksheet.id}`);
    await pageB.goto(`/worksheets/${worksheet.id}`);
    await expect(pageB.getByTestId(`work-banner-${work.id}`)).toBeVisible();

    await pageA.getByTestId(`work-add-attachment-${work.id}`).click();
    await pageA.getByTestId('quick-popover-add-btn').click();
    await pageA.getByTestId('artifact-name-input').fill('实时同步原片');
    await pageA.getByTestId('artifact-url-input').fill('https://mega.nz/file/syncwork01');
    await pageA.getByTestId('artifact-submit-btn').click();

    await expect(pageB.locator(`[data-work-attachment-slots="${work.id}"]`)).toContainText(
      '实时同步原片',
    );

    await ctxA.close();
    await ctxB.close();

    // V12: 390×844 手机窄屏零横向溢出检查
    const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobilePage = await mobileCtx.newPage();
    await loginViaUi(mobilePage, USER_A_LOGIN, USER_A_PW);

    await expectNoHorizontalOverflow(mobilePage);

    await mobilePage.goto('/docs');
    await expect(mobilePage.getByTestId('docs-page')).toBeVisible();
    await expectNoHorizontalOverflow(mobilePage);

    await mobilePage.getByTestId('docs-create-btn').click();
    await expect(mobilePage.getByTestId('artifact-create-form')).toBeVisible();
    await expectNoHorizontalOverflow(mobilePage);
    await mobilePage.keyboard.press('Escape');

    await mobilePage.goto(`/worksheets/${worksheet.id}`);
    await expect(mobilePage.getByTestId(`work-banner-${work.id}`)).toBeVisible();
    await expectNoHorizontalOverflow(mobilePage);

    await mobileCtx.close();
  });
});
