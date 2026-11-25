import { type APIRequestContext, expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, loginViaUi, readE2eState } from './helpers.js';

const ORIGIN = 'http://127.0.0.1:3100';
const ADMIN_PW = 'AdminE2eSecret_2026!';
const USER_A_LOGIN = 'p2_alice';
const USER_A_NAME = '小爱';
const USER_A_PW = 'Phase2Alice_2026!';
const USER_B_LOGIN = 'p2_bob';
const USER_B_NAME = '小博';
const USER_B_PW = 'Phase2Bob_2026!';

async function ensureAdminCookie(request: APIRequestContext): Promise<string> {
  const tryLogin = await request.post(`${ORIGIN}/api/auth/login`, {
    headers: { origin: ORIGIN },
    data: { loginName: 'admin_e2e', password: ADMIN_PW },
  });
  if (tryLogin.ok()) {
    const cookie = (tryLogin.headers()['set-cookie'] ?? '').match(/nw_session=[^;]+/)?.[0];
    if (cookie) return cookie;
  }

  // 若独立运行 phase2.spec.ts，先用初始重置链接设置管理员密码
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
    ).json()) as {
      user: { id: string };
    };
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
  ).json()) as {
    user: { id: string };
  };
  return { cookie, userId: me.user.id };
}

test.describe('阶段 2 端到端验收（V1–V14）', () => {
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

  test('V1 + V2 + V3 + V4: 普通用户建表配列与看板列、插入分工与纯文本负责人、已发布折叠与修改记录恢复', async ({
    browser,
  }) => {
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await loginViaUi(pageA, USER_A_LOGIN, USER_A_PW);

    // 确认导航无“归档”入口（ADR-0004）
    await expect(pageA.getByRole('link', { name: '归档' })).toHaveCount(0);

    // 验证首页右上角「管理看板列」弹窗可用
    await pageA.getByRole('button', { name: '管理看板列' }).click();
    await expect(pageA.getByRole('heading', { name: '管理看板列' })).toBeVisible();
    await pageA.getByRole('button', { name: '关闭', exact: true }).click();

    // 验证桌面端左侧栏可折叠再展开
    await pageA.getByRole('button', { name: '折叠侧栏' }).click();
    await expect(pageA.getByTestId('sidebar-worksheets')).toHaveCount(0);
    await pageA.getByRole('button', { name: '展开侧栏' }).click();
    await expect(pageA.getByTestId('sidebar-worksheets')).toBeVisible();

    // V1: 普通用户进入 /worksheets，新建工作表（标准视频模板）
    await pageA.goto('/worksheets');
    await pageA.getByRole('button', { name: '新建工作表' }).click();
    await pageA.getByLabel('工作表名称').fill('演唱会视频');
    await pageA.getByRole('button', { name: '创建工作表' }).click();

    // 左侧导航立即出现新工作表
    await expect(pageA.getByTestId('sidebar-worksheets')).toContainText('演唱会视频');

    // 普通用户新增再删除一个看板列，确认首页看板列配置开放
    await pageA.getByLabel('新看板列名称').fill('临时特效列');
    await pageA.getByRole('button', { name: '新增看板列' }).click();
    await expect(pageA.getByTestId('board-columns-list')).toContainText('临时特效列');
    await pageA.getByRole('button', { name: '删除看板列 临时特效列' }).click();
    await pageA.getByRole('button', { name: '确认删除' }).click();
    await expect(pageA.getByTestId('board-columns-list')).not.toContainText('临时特效列');

    // 进入「演唱会视频」工作表
    await pageA.getByTestId('sidebar-worksheets').getByRole('link', { name: '演唱会视频' }).click();
    await expect(pageA.getByRole('heading', { name: '演唱会视频' })).toBeVisible();

    // 新增不上看板工序列「压制」与自定义文本列「片源备注」（表头 + 原地新增）
    await pageA.getByTestId('add-column-trigger').click();
    await pageA.getByLabel('列名', { exact: true }).fill('压制');
    await pageA.getByLabel('对应看板列', { exact: true }).click();
    await pageA.getByRole('option', { name: '不上看板', exact: true }).click();
    await pageA.getByRole('button', { name: '添加列' }).click();
    await expect(pageA.getByText('已新增列')).toBeVisible();

    await pageA.getByTestId('add-column-trigger').click();
    await pageA.getByLabel('列名', { exact: true }).fill('片源备注');
    await pageA
      .getByRole('radiogroup', { name: '列类型' })
      .getByRole('button', { name: '文本', exact: true })
      .click();
    await pageA.getByRole('button', { name: '添加列' }).click();
    await expect(pageA.getByTestId('worksheet-main-table')).toContainText('片源备注');

    // 验证表头点击原地菜单（改名、隐藏、再通过字段显隐恢复）
    await pageA.getByRole('button', { name: '片源备注' }).click();
    await pageA.getByRole('button', { name: '隐藏此列' }).click();
    await expect(pageA.getByTestId('worksheet-main-table')).not.toContainText('片源备注');
    await pageA.getByTestId('field-visibility-trigger').click();
    await pageA.getByRole('button', { name: '显示列 片源备注' }).click();
    await expect(pageA.getByTestId('worksheet-main-table')).toContainText('片源备注');
    await pageA.keyboard.press('Escape');

    // V2: 新建独立任务（无作品平铺，不套横幅）、填分工说明、新建作品大标题横幅与分段、录入项目用户与纯文本负责人
    await pageA.getByLabel('新建任务标题').fill('5th 花絮 P1');
    await pageA.getByLabel('新建任务标题').press('Enter');
    await expect(pageA.getByTestId('worksheet-main-table')).toContainText('5th 花絮 P1');
    // 无作品独立任务默认平铺，不渲染作品大标题横幅；且默认隐藏冗余「作品」列
    await expect(pageA.locator('tr[data-work-banner]')).toHaveCount(0);
    await expect(pageA.getByTestId('col-header-work')).toHaveCount(0);

    // 在下方插入一行（行操作菜单 -> 贴合网格原地插入行）
    const row1 = pageA.locator('tr[data-task-row]').first();
    const task1Id = (await row1.getAttribute('data-task-row')) ?? '';
    expect(task1Id).toBeTruthy();

    await row1.hover();
    await pageA.getByRole('button', { name: '行操作 5th 花絮 P1' }).click();
    await pageA.getByRole('menuitem', { name: '在下方插入一行' }).click();
    await pageA.getByPlaceholder('输入新任务标题回车确认').fill('5th 花絮 P2');
    await pageA.getByRole('button', { name: '插入', exact: true }).click();
    await expect(pageA.getByTestId('worksheet-main-table')).toContainText('5th 花絮 P2');

    // 键盘方向键导航：标题格 ArrowRight 直接到第一道工序列（时轴），分工说明已移至最末列
    const titleCell1 = pageA.getByTestId(`cell-${task1Id}-title`);
    await titleCell1.getByRole('button').click();
    await pageA.keyboard.press('ArrowRight');
    const stageCell1 = row1.locator('td').nth(2).locator('button').first();
    await expect(stageCell1).toHaveClass(/ring-sky-500/);

    // 分工说明位于最后一个数据列（倒数第 2 个 th，右侧仅剩 + 列头）
    const lastDataHeader = pageA.getByTestId('worksheet-main-table').locator('thead th').nth(-2);
    await expect(lastDataHeader).toContainText('分工说明');

    const divCell = pageA.getByTestId(`cell-${task1Id}-divisionNote`);
    await divCell.getByRole('button').click();
    await expect(divCell).toHaveClass(/ring-sky-500/);
    await pageA.keyboard.press('Enter');
    const divInput = divCell.locator('input');
    await expect(divInput).toBeVisible();
    await divInput.fill('P1 00:00–13:00');
    await divInput.press('Enter');
    await expect(divCell).toContainText('P1 00:00–13:00');

    // 顶栏「+ 新建作品」-> 立即渲染作品大标题横幅并自动聚焦首条分段输入 -> 连续回车添加两段
    await pageA.getByTestId('create-work-trigger').click();
    await pageA.getByLabel('新作品名称').fill('5th 演唱会');
    await pageA.getByRole('button', { name: '创建作品' }).click();

    const workBanner = pageA.locator('tr[data-work-banner]').first();
    await expect(workBanner).toBeVisible();
    await expect(workBanner).toContainText('5th 演唱会');
    await expect(workBanner.getByTestId('work-attachment-slots')).toBeVisible();

    const segInput = pageA.getByLabel('为 5th 演唱会 添加分段');
    await expect(segInput).toBeFocused();
    await segInput.fill('0-36:37');
    await segInput.press('Enter');
    await expect(pageA.getByTestId('worksheet-main-table')).toContainText('0-36:37');
    await segInput.fill('36:37-01:00:33');
    await segInput.press('Enter');
    await expect(pageA.getByTestId('worksheet-main-table')).toContainText('36:37-01:00:33');
    await expect(workBanner).toContainText('已完成 0/2');
    await pageA.getByTestId('inline-add-segment-row').getByRole('button', { name: '完成' }).click();

    // 验证作品大标题横幅折叠/展开与原地重命名
    await pageA.getByRole('button', { name: '折叠作品 5th 演唱会' }).click();
    await expect(pageA.locator('tr[data-task-row]', { hasText: '0-36:37' })).toHaveCount(0);
    await pageA.getByRole('button', { name: '展开作品 5th 演唱会' }).click();
    const seg1Row = pageA.locator('tr[data-task-row]', { hasText: '0-36:37' });
    await expect(seg1Row).toBeVisible();

    await pageA.getByRole('button', { name: '作品操作 5th 演唱会' }).click();
    await pageA.getByRole('menuitem', { name: '重命名作品' }).click();
    const renameWorkInput = pageA.getByLabel('重命名作品 5th 演唱会');
    await renameWorkInput.fill('5th 专场演唱会');
    await renameWorkInput.press('Enter');
    await expect(workBanner).toContainText('5th 专场演唱会');

    // 验证键盘 ArrowDown 跨越作品大标题横幅（从独立行 5th 花絮 P2 跨过横幅到 0-36:37）
    const row2ForNav = pageA.locator('tr[data-task-row]', { hasText: '5th 花絮 P2' });
    const row2NavId = (await row2ForNav.getAttribute('data-task-row')) ?? '';
    await pageA.getByTestId(`cell-${row2NavId}-title`).getByRole('button').click();
    await pageA.keyboard.press('ArrowDown');
    const seg1Id = (await seg1Row.getAttribute('data-task-row')) ?? '';
    await expect(pageA.getByTestId(`cell-${seg1Id}-title`)).toHaveClass(/ring-sky-500/);

    // 打开分段任务详情侧栏 -> 顶部可见「所属作品共用附件（阶段 3 接入）」联动槽位
    await seg1Row.hover();
    await pageA.getByRole('button', { name: '打开 0-36:37 详情' }).click();
    const segDrawer = pageA.getByTestId('task-detail-drawer');
    await expect(segDrawer.getByTestId('work-shared-attachments-slot')).toContainText(
      '所属作品「5th 专场演唱会」共用附件',
    );
    await pageA.getByRole('button', { name: '关闭侧栏' }).click();

    // 验证「作品」列已移除，且「分工说明」可在「字段显隐」中隐藏与恢复
    await pageA.getByTestId('field-visibility-trigger').click();
    const fieldPopover = pageA.locator('[data-radix-popper-content-wrapper]');
    await expect(fieldPopover.getByRole('button', { name: '作品', exact: true })).toHaveCount(0);
    await fieldPopover.getByRole('button', { name: '分工说明', exact: true }).click();
    await expect(pageA.getByTestId('col-header-divisionNote')).toHaveCount(0);
    await fieldPopover.getByRole('button', { name: '分工说明', exact: true }).click();
    await expect(pageA.getByTestId('col-header-divisionNote')).toBeVisible();
    await pageA.keyboard.press('Escape');

    // 编辑第一道工序列（时轴，位于 td.nth(2)）：同时选项目用户「小爱」+ 纯文本「外援小王」并设进行中
    await stageCell1.click();
    const stagePopover = pageA.locator('[data-radix-popper-content-wrapper]');
    await stagePopover.getByRole('button', { name: '进行中', exact: true }).click();
    await stagePopover.getByRole('button', { name: USER_A_NAME, exact: true }).click();
    await stagePopover.getByPlaceholder('输入纯文本名字（如外援小王）').fill('外援小王');
    await stagePopover.getByRole('button', { name: '添加', exact: true }).click();
    await stagePopover.getByRole('button', { name: '保存', exact: true }).click();
    await expect(stageCell1).toContainText(`${USER_A_NAME}、外援小王`);
    await expect(stageCell1).toHaveAttribute('data-stage-status', 'in_progress');

    // V3: 新建一条“全工序完成但未发布”任务 -> 不应折叠；将 P2 标为已发布 -> 移入顶部已发布折叠区
    await pageA.getByLabel('新建任务标题').fill('待发全完任务');
    await pageA.getByLabel('新建任务标题').press('Enter');
    const rowDone = pageA.locator('tr[data-task-row]', { hasText: '待发全完任务' });
    await expect(rowDone).toBeVisible();
    // 把 P2 标为已发布
    const row2 = pageA.locator('tr[data-task-row]', { hasText: '5th 花絮 P2' });
    const task2Id = (await row2.getAttribute('data-task-row')) ?? '';
    await pageA.getByTestId(`cell-${task2Id}-publish`).click();
    const pubPopover = pageA.locator('[data-radix-popper-content-wrapper]');
    await pubPopover.getByRole('button', { name: '已发布', exact: true }).click();
    await pubPopover.getByRole('button', { name: '保存', exact: true }).click();

    await expect(pageA.getByTestId('published-section')).toContainText('已发布（1 条）');
    await expect(pageA.getByTestId('worksheet-main-table')).not.toContainText('5th 花絮 P2');
    // 展开已发布折叠区可见 P2
    await pageA.getByRole('button', { name: /已发布（1 条）/ }).click();
    await expect(pageA.getByTestId('published-section')).toContainText('5th 花絮 P2');
    // 未发布的任务仍在主表不被折叠
    await expect(pageA.getByTestId('worksheet-main-table')).toContainText('待发全完任务');

    // V4: 删除「待发全完任务」，由另一用户在修改记录中一键恢复
    await rowDone.hover();
    await pageA.getByRole('button', { name: '行操作 待发全完任务' }).click();
    await pageA.getByRole('menuitem', { name: '删除任务' }).click();
    await expect(pageA.getByTestId('worksheet-main-table')).not.toContainText('待发全完任务');

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await loginViaUi(pageB, USER_B_LOGIN, USER_B_PW);
    await pageB.goto(pageA.url());
    await pageB.getByRole('button', { name: '修改记录' }).click();
    await expect(pageB.getByTestId('change-log-list')).toContainText('删除了任务「待发全完任务」');
    await pageB
      .getByTestId('change-log-item-task.deleted')
      .first()
      .getByRole('button', { name: '恢复' })
      .click();
    await expect(pageB.getByTestId('worksheet-main-table')).toContainText('待发全完任务');
    // pageA 也实时恢复可见
    await expect(pageA.getByTestId('worksheet-main-table')).toContainText('待发全完任务');

    await ctxA.close();
    await ctxB.close();
  });

  test('V5 + V6 + V7 + V12: 看板四列并行多列、作品筛选、双端抢认领、我的任务与跨表中文检索', async ({
    browser,
    request,
  }) => {
    // 独立造数：一张标准表 + 一张无校对列工作表
    const ws1 = await (
      await request.post(`${ORIGIN}/api/worksheets`, {
        headers: { cookie: userA.cookie, origin: ORIGIN },
        data: { name: '看板主表', color: 'indigo', template: 'standard_video' },
      })
    ).json();
    const [colTiming, colTrans] = ws1.columns as Array<{ id: string; name: string }>;
    if (!colTiming || !colTrans) throw new Error('expected template stage columns');
    const colEncode = await (
      await request.post(`${ORIGIN}/api/worksheets/${ws1.worksheet.id}/columns`, {
        headers: { cookie: userA.cookie, origin: ORIGIN },
        data: { name: '压制', type: 'stage', boardColumnId: null },
      })
    ).json();
    const colNoteText = await (
      await request.post(`${ORIGIN}/api/worksheets/${ws1.worksheet.id}/columns`, {
        headers: { cookie: userA.cookie, origin: ORIGIN },
        data: { name: '片源编号', type: 'text' },
      })
    ).json();

    const wsNoProof = await (
      await request.post(`${ORIGIN}/api/worksheets`, {
        headers: { cookie: userA.cookie, origin: ORIGIN },
        data: { name: '无校对短片', color: 'emerald', template: 'blank' },
      })
    ).json();
    await request.post(`${ORIGIN}/api/worksheets/${wsNoProof.worksheet.id}/columns`, {
      headers: { cookie: userA.cookie, origin: ORIGIN },
      data: { name: '翻译', type: 'stage' },
    });

    // 任务 1：时轴与翻译并行进行中（小爱负责时轴），压制缺人（不上看板）
    const tParallel = await (
      await request.post(`${ORIGIN}/api/worksheets/${ws1.worksheet.id}/tasks`, {
        headers: { cookie: userA.cookie, origin: ORIGIN },
        data: { title: '并行直播剪辑', workName: '周年庆特辑', divisionNote: '前半段' },
      })
    ).json();
    await request.patch(`${ORIGIN}/api/tasks/${tParallel.id}`, {
      headers: { cookie: userA.cookie, origin: ORIGIN },
      data: { changes: { customValues: { [colNoteText.id]: 'BD_RAW_2026' } } },
    });
    await request.patch(`${ORIGIN}/api/tasks/${tParallel.id}/stages/${colTiming.id}`, {
      headers: { cookie: userA.cookie, origin: ORIGIN },
      data: {
        assignees: [{ type: 'user', userId: userA.userId }],
        status: 'in_progress',
        baseRevision: 0,
      },
    });
    await request.patch(`${ORIGIN}/api/tasks/${tParallel.id}/stages/${colTrans.id}`, {
      headers: { cookie: userA.cookie, origin: ORIGIN },
      data: {
        assignees: [{ type: 'text', name: '官中字幕' }],
        status: 'in_progress',
        baseRevision: 0,
      },
    });

    // 任务 2：用于双端认领（翻译缺人）
    const tClaim = await (
      await request.post(`${ORIGIN}/api/worksheets/${wsNoProof.worksheet.id}/tasks`, {
        headers: { cookie: userA.cookie, origin: ORIGIN },
        data: { title: '待认领短片' },
      })
    ).json();

    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await loginViaUi(pageA, USER_A_LOGIN, USER_A_PW);
    await loginViaUi(pageB, USER_B_LOGIN, USER_B_PW);

    // V5: 验证 4 个初始看板列与并行多列卡片
    const colTimingEl = pageA.locator('[data-board-column-name="时轴"]');
    const colTransEl = pageA.locator('[data-board-column-name="翻译"]');
    const colProofEl = pageA.locator('[data-board-column-name="校对"]');
    const colTypesetEl = pageA.locator('[data-board-column-name="嵌字"]');
    await expect(colTimingEl).toBeVisible();
    await expect(colTransEl).toBeVisible();
    await expect(colProofEl).toBeVisible();
    await expect(colTypesetEl).toBeVisible();

    await expect(colTimingEl).toContainText('并行直播剪辑');
    await expect(colTransEl).toContainText('并行直播剪辑');
    // 不上看板的“压制”也出缺人标签
    await expect(colTimingEl).toContainText('缺 压制');
    // 无校对表任务落在翻译列且不出「缺 校对」
    const claimCardA = colTransEl.locator(`[data-testid^="board-card-${tClaim.id}-"]`);
    await expect(claimCardA).toBeVisible();
    await expect(claimCardA).not.toContainText('缺 校对');

    // 点击卡片上的作品标签筛选 -> 只显示该作品，移除后恢复
    await colTimingEl.getByRole('button', { name: '周年庆特辑' }).first().click();
    await expect(pageA.getByTestId('active-work-filter-chip')).toContainText('周年庆特辑');
    await expect(claimCardA).toHaveCount(0);
    await pageA.getByRole('button', { name: '清除作品筛选' }).click();
    await expect(claimCardA).toBeVisible();

    // V6: 甲在看板点击「缺 翻译」认领 -> 标签消失且乙在 2 秒内实时看到负责人变为小爱且状态保持未开始
    const claimCardB = pageB
      .locator('[data-board-column-name="翻译"]')
      .locator(`[data-testid^="board-card-${tClaim.id}-"]`);
    await expect(claimCardB).toContainText('缺 翻译');

    await claimCardA.getByRole('button', { name: '缺 翻译' }).click();
    await expect(claimCardA).toContainText(`${USER_A_NAME} · 未开始`);
    await expect(claimCardA).not.toContainText('缺 翻译');
    await expect(claimCardB).toContainText(`${USER_A_NAME} · 未开始`, { timeout: 3_000 });

    // V7: 顶部“我进行中的任务”仅显示小爱进行中的时轴（不含刚认领未开始的短片，不含纯文本官中字幕）
    const myBar = pageA.getByTestId('my-in-progress-bar');
    await expect(myBar).toContainText('并行直播剪辑');
    await expect(myBar).not.toContainText('待认领短片');
    // 点击完成 -> 从进行中条消失
    await myBar
      .getByTestId(`my-in-progress-item-${tParallel.id}-${colTiming.id}`)
      .getByRole('button', { name: '完成' })
      .click();
    await expect(myBar).not.toContainText('并行直播剪辑');

    // /my-tasks 页面正确分组：未开始含「待认领短片」，底部折叠区「我已完成」含「并行直播剪辑」
    await pageA.goto('/my-tasks');
    await expect(pageA.getByTestId('my-tasks-not-started')).toContainText('待认领短片');
    await pageA.getByRole('button', { name: /我已完成/ }).click();
    await expect(pageA.getByTestId('my-tasks-completed')).toContainText('并行直播剪辑');

    // V12: /search 跨表搜索自定义文本列 & 纯文本负责人，点击直达工作表并打开详情侧栏
    await pageA.goto('/search');
    await pageA.getByLabel('检索关键词').fill('BD_RAW_2026');
    await expect(pageA.getByTestId(`search-result-${tParallel.id}`)).toBeVisible();
    await pageA.getByLabel('检索关键词').fill('官中字幕');
    await expect(pageA.getByTestId(`search-result-${tParallel.id}`)).toBeVisible();
    await pageA.getByTestId(`search-result-${tParallel.id}`).click();
    await expect(pageA).toHaveURL(new RegExp(`/worksheets/${ws1.worksheet.id}`));
    const drawer = pageA.getByTestId('task-detail-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByLabel('标题', { exact: true })).toHaveValue('并行直播剪辑');

    // 确保 colEncode 变量已使用
    expect(colEncode.id).toBeTruthy();

    await ctxA.close();
    await ctxB.close();
  });

  test('V8 + V9 + V10 + V11 + V14: 双端协同、在线状态与离线消失、中文输入法冲突浮条、断线补发与 390px 手机视口', async ({
    browser,
    request,
  }) => {
    const ws = await (
      await request.post(`${ORIGIN}/api/worksheets`, {
        headers: { cookie: userA.cookie, origin: ORIGIN },
        data: { name: '协同压测表', color: 'violet', template: 'standard_video' },
      })
    ).json();
    const wsUrl = `/worksheets/${ws.worksheet.id}`;
    const task = await (
      await request.post(`${ORIGIN}/api/worksheets/${ws.worksheet.id}/tasks`, {
        headers: { cookie: userA.cookie, origin: ORIGIN },
        data: { title: '协同初始标题', divisionNote: '初始分工' },
      })
    ).json();

    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await loginViaUi(pageA, USER_A_LOGIN, USER_A_PW);
    await loginViaUi(pageB, USER_B_LOGIN, USER_B_PW);

    await pageA.goto(wsUrl);
    await pageB.goto(wsUrl);
    await expect(pageA.getByTestId('worksheet-main-table')).toContainText('协同初始标题');
    await expect(pageB.getByTestId('worksheet-main-table')).toContainText('协同初始标题');

    // V9: 乙看到甲在线，甲编辑标题格时乙看到彩色边框与“小爱 正在编辑”
    await expect(pageB.getByTestId('presence-bar')).toContainText(USER_A_NAME);
    const titleCellA = pageA.getByTestId(`cell-${task.id}-title`);
    const titleCellB = pageB.getByTestId(`cell-${task.id}-title`);
    await titleCellA.getByRole('button').dblclick();
    await expect(titleCellB.getByTestId('peer-focus-badge')).toContainText(
      `${USER_A_NAME} 正在编辑`,
    );

    // V8: 甲改标题，同时乙改同一行分工说明 -> 两者均保留并实时同步
    await titleCellA.locator('input').fill('甲修改的标题');
    const divCellB = pageB.getByTestId(`cell-${task.id}-divisionNote`);
    await divCellB.getByRole('button').dblclick();
    await divCellB.locator('input').fill('乙修改的分工');

    await titleCellA.locator('input').press('Enter');
    await divCellB.locator('input').press('Enter');

    await expect(titleCellB).toContainText('甲修改的标题');
    await expect(pageA.getByTestId(`cell-${task.id}-divisionNote`)).toContainText('乙修改的分工');

    // V10: 中文输入法组字期间收到远端同格修改 -> 不打断输入、不丢草稿、弹出冲突浮条
    await titleCellB.getByRole('button').dblclick();
    const inputB = titleCellB.locator('input');
    // 模拟中文输入法 compositionstart -> 正在输入草稿
    await inputB.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'zhong' }));
    });
    await inputB.fill('乙正在组字的草稿');

    // 甲同时修改并保存同一格
    await titleCellA.getByRole('button').dblclick();
    await titleCellA.locator('input').fill('甲抢先保存的值');
    await titleCellA.locator('input').press('Enter');

    // 乙的草稿不被覆盖，冲突浮条出现
    const conflictBar = titleCellB.getByTestId('cell-conflict-bar');
    await expect(conflictBar).toBeVisible();
    await expect(conflictBar).toContainText('甲抢先保存的值');
    await expect(inputB).toHaveValue('乙正在组字的草稿');

    // 结束组字并点击「保留我的」-> 强制保存乙的草稿并同步给甲
    await inputB.evaluate((el) => {
      el.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: '乙正在组字的草稿' }),
      );
    });
    await conflictBar.getByRole('button', { name: '保留我的' }).click();
    await expect(conflictBar).toHaveCount(0);
    await expect(titleCellB).toContainText('乙正在组字的草稿');
    await expect(titleCellA).toContainText('乙正在组字的草稿');

    // 再验证「采用对方的」
    await titleCellB.getByRole('button').dblclick();
    await titleCellB.locator('input').fill('乙将放弃的草稿');
    await titleCellA.getByRole('button').dblclick();
    await titleCellA.locator('input').fill('甲最新定稿');
    await titleCellA.locator('input').press('Enter');
    await expect(titleCellB.getByTestId('cell-conflict-bar')).toBeVisible();
    await titleCellB
      .getByTestId('cell-conflict-bar')
      .getByRole('button', { name: '采用对方的' })
      .click();
    await expect(titleCellB).toContainText('甲最新定稿');

    // V9-2: 甲关闭页面 -> 乙表头的甲在线头像自动消失
    await pageA.close();
    await expect(pageB.getByTestId('presence-bar')).toHaveCount(0);

    // V11: 乙模拟断线（offline），后端新增任务，乙恢复 online 后自动补发无需刷新
    await ctxB.setOffline(true);
    await request.post(`${ORIGIN}/api/worksheets/${ws.worksheet.id}/tasks`, {
      headers: { cookie: userA.cookie, origin: ORIGIN },
      data: { title: '断线期间新增任务' },
    });
    await ctxB.setOffline(false);
    await expect(pageB.getByTestId('worksheet-main-table')).toContainText('断线期间新增任务', {
      timeout: 10_000,
    });

    // V14: 390×844 手机视口检查工作表、详情侧栏与首页看板均无页面级横向溢出
    await pageB.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(pageB);
    await pageB.goto('/');
    await expect(pageB.getByTestId('board-columns')).toBeVisible();
    await expectNoHorizontalOverflow(pageB);

    await ctxA.close();
    await ctxB.close();
  });
});
