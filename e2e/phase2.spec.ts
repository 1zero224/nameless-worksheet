import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { expectNoHorizontalOverflow, loginViaUi, readE2eState } from './helpers.js';

const ORIGIN = 'http://127.0.0.1:3100';
const ADMIN_PW = 'AdminE2eSecret_2026!';
const USER_A_LOGIN = 'p2_alice';
const USER_A_NAME = '小爱';
const USER_A_PW = 'Phase2Alice_2026!';
const USER_B_LOGIN = 'p2_bob';
const USER_B_NAME = '小博';
const USER_B_PW = 'Phase2Bob_2026!';

interface GridGeometryHost extends HTMLDivElement {
  __nwGridGeometry?: {
    getCellPoint: (taskId: string, columnKey: string) => { x: number; y: number } | null;
    getHeaderPoint: (columnKey: string) => { x: number; y: number } | null;
    getRowExpandPoint: (taskId: string) => { x: number; y: number } | null;
  };
}

async function waitForCellPoint(page: Page, taskId: string, columnKey: string) {
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
  return pt as { x: number; y: number };
}

async function clickCanvasCell(page: Page, taskId: string, columnKey: string) {
  const pt = await waitForCellPoint(page, taskId, columnKey);
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.click(pt.x, pt.y);
}

async function dblClickCanvasCell(page: Page, taskId: string, columnKey: string) {
  const pt = await waitForCellPoint(page, taskId, columnKey);
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.dblclick(pt.x, pt.y);
}

async function rightClickCanvasCell(page: Page, taskId: string, columnKey: string) {
  const pt = await waitForCellPoint(page, taskId, columnKey);
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.click(pt.x, pt.y, { button: 'right' });
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
  const target = pt as { x: number; y: number };
  await page.mouse.move(target.x, target.y);
  await page.mouse.click(target.x, target.y);
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

test.describe('阶段 2 端到端验收（V1–V14 + Teable Canvas 表格与作品聚合看板）', () => {
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

  test('V1 + V2 + V3 + V4: Canvas 表格建表配列、作品大标题横幅、工序格绘制器、视图切换、已发布折叠与修改记录恢复', async ({
    browser,
  }) => {
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await loginViaUi(pageA, USER_A_LOGIN, USER_A_PW);

    // 确认无侧边栏、无「归档 / 我的任务 / 参考资料」入口，任务看板与工作表位于顶部标签栏
    await expect(pageA.locator('aside')).toHaveCount(0);
    await expect(pageA.getByRole('link', { name: '归档' })).toHaveCount(0);
    await expect(pageA.getByRole('link', { name: '我的任务' })).toHaveCount(0);
    await expect(pageA.getByRole('link', { name: '参考资料' })).toHaveCount(0);
    await expect(
      pageA.getByTestId('top-nav-tabs').getByRole('link', { name: '任务看板' }),
    ).toBeVisible();

    // 验证首页右上角「管理看板列」弹窗可用
    await pageA.getByRole('button', { name: '管理看板列' }).click();
    await expect(pageA.getByRole('heading', { name: '管理看板列' })).toBeVisible();
    await pageA.getByRole('button', { name: '关闭', exact: true }).click();

    // 验证右上角头像菜单包含个人设置与工作表总览
    await pageA.getByTestId('user-avatar-trigger').click();
    await expect(pageA.getByRole('menuitem', { name: '个人设置' })).toBeVisible();
    await pageA.getByRole('menuitem', { name: '工作表总览' }).click();

    // V1: 普通用户进入 /worksheets，新建工作表（标准视频模板）
    await pageA.getByRole('button', { name: '新建工作表' }).click();
    await pageA.getByLabel('工作表名称').fill('演唱会视频');
    await pageA.getByRole('button', { name: '创建工作表' }).click();

    // 顶部标签栏立即出现新工作表
    await expect(pageA.getByTestId('topbar-worksheets')).toContainText('演唱会视频');

    // 普通用户新增再删除一个看板列，确认首页看板列配置开放
    await pageA.getByLabel('新看板列名称').fill('临时特效列');
    await pageA.getByRole('button', { name: '新增看板列' }).click();
    await expect(pageA.getByTestId('board-columns-list')).toContainText('临时特效列');
    await pageA.getByRole('button', { name: '删除看板列 临时特效列' }).click();
    await pageA.getByRole('button', { name: '确认删除' }).click();
    await expect(pageA.getByTestId('board-columns-list')).not.toContainText('临时特效列');

    // 通过顶部标签页进入「演唱会视频」工作表
    await pageA.getByTestId('topbar-worksheets').getByRole('link', { name: '演唱会视频' }).click();
    await expect(pageA.getByRole('heading', { name: '演唱会视频' })).toBeVisible();

    // 新增不上看板工序列「压制」与自定义文本列「片源备注」
    await pageA.getByTestId('add-column-trigger').click();
    await pageA.getByLabel('列名', { exact: true }).fill('压制');
    await pageA.getByLabel('对应看板列', { exact: true }).click();
    await pageA.getByRole('option', { name: '不上看板', exact: true }).click();
    await pageA.getByRole('button', { name: '添加列' }).click();
    await expect(pageA.getByText('已新增列').first()).toBeVisible();

    await pageA.getByTestId('add-column-trigger').click();
    await pageA.getByLabel('列名', { exact: true }).fill('片源备注');
    await pageA
      .getByRole('radiogroup', { name: '列类型' })
      .getByRole('button', { name: '文本', exact: true })
      .click();
    await pageA.getByRole('button', { name: '添加列' }).click();
    await expect(pageA.getByTestId('worksheet-main-table')).toContainText('片源备注');

    // V2: 先新建一条独立任务，确保 Canvas Grid 渲染并检验默认隐藏冗余「作品」列
    await pageA.getByLabel('新建任务标题').fill('5th 花絮 P1');
    await pageA.getByLabel('新建任务标题').press('Enter');
    await expect(pageA.getByTestId('worksheet-main-table')).toContainText('5th 花絮 P1');
    await expect(pageA.locator('[data-work-banner]')).toHaveCount(0);
    await expect(pageA.getByTestId('col-header-work')).toHaveCount(0);

    // 验证点击 Canvas 列头原地菜单（隐藏「片源备注」列，再通过字段显隐恢复）
    const noteColHeader = pageA.locator('[data-testid^="col-header-"]', { hasText: '片源备注' });
    const noteColTestId = (await noteColHeader.getAttribute('data-testid')) ?? '';
    const noteColId = noteColTestId.replace('col-header-', '');
    await clickCanvasHeader(pageA, noteColId);
    await pageA.getByRole('button', { name: '隐藏此列' }).click();
    await expect(pageA.getByTestId(`col-header-${noteColId}`)).toHaveCount(0);
    await pageA.getByTestId('field-visibility-trigger').click();
    await pageA.getByRole('button', { name: '显示列 片源备注' }).click();
    await expect(pageA.getByTestId(`col-header-${noteColId}`)).toHaveCount(1);
    await pageA.keyboard.press('Escape');
    await expect(pageA.getByRole('button', { name: '隐藏列 片源备注' })).toHaveCount(0);

    // 获取首行任务 ID 与首道工序列 ID
    const row1 = pageA.locator('[data-task-row]').first();
    const task1Id = (await row1.getAttribute('data-task-row')) ?? '';
    expect(task1Id).toBeTruthy();

    // 在下方插入一行（Canvas 右键整行上下文菜单 -> 在下方插入一行）
    await rightClickCanvasCell(pageA, task1Id, 'title');
    await pageA.getByRole('menuitem', { name: '在下方插入一行' }).click();
    await pageA.getByPlaceholder('输入新任务标题回车确认').fill('5th 花絮 P2');
    await pageA.getByRole('button', { name: '插入', exact: true }).click();
    await expect(pageA.getByTestId('worksheet-main-table')).toContainText('5th 花絮 P2');

    // 键盘方向键导航：点击 Canvas 标题格 -> ArrowRight 到达第一道工序列（时轴）
    const stage1Header = pageA.locator('[data-testid^="col-header-"]', { hasText: '时轴' });
    const stage1ColId = ((await stage1Header.getAttribute('data-testid')) ?? '').replace(
      'col-header-',
      '',
    );
    expect(stage1ColId).toBeTruthy();

    await clickCanvasCell(pageA, task1Id, 'title');
    await expect(pageA.getByTestId('worksheet-main-table')).toHaveAttribute(
      'data-selected-cell',
      `${task1Id}:title`,
    );
    await pageA.keyboard.press('ArrowRight');
    await expect(pageA.getByTestId('worksheet-main-table')).toHaveAttribute(
      'data-selected-cell',
      `${task1Id}:${stage1ColId}`,
    );

    // 验证「分工说明」位于最后一个数据列
    const lastDataHeader = pageA.getByTestId('worksheet-main-table').locator('thead th').last();
    await expect(lastDataHeader).toContainText('分工说明');

    // 点击 Canvas「分工说明」格 -> 按 Enter 进入 DOM 内联编辑器 -> 填写并回车保存
    await clickCanvasCell(pageA, task1Id, 'divisionNote');
    await pageA.keyboard.press('Enter');
    const divInput = pageA.getByTestId(`canvas-editor-${task1Id}-divisionNote`).locator('input');
    await expect(divInput).toBeVisible();
    await divInput.fill('P1 00:00–13:00');
    await divInput.press('Enter');
    await expect(pageA.getByTestId(`cell-${task1Id}-divisionNote`)).toContainText('P1 00:00–13:00');

    // 确认不再有独立的「新建作品」工具栏按钮，且「新增」行紧贴最新任务下方并支持切换 任务 / 作品
    await expect(pageA.getByTestId('create-work-trigger')).toHaveCount(0);
    const addRowBox = await pageA.getByTestId('inline-quick-add-row').boundingBox();
    const gridBox = await pageA.getByTestId('worksheet-canvas-grid').boundingBox();
    expect(addRowBox && gridBox ? addRowBox.y - gridBox.y : 999).toBeLessThan(180);

    await pageA.getByTestId('quick-add-mode-trigger').click();
    await pageA.getByRole('menuitem', { name: '新增作品' }).click();
    await pageA.getByLabel('新作品名称').fill('5th 演唱会');
    await pageA.getByRole('button', { name: '创建作品' }).click();

    const workBanner = pageA.locator('[data-work-banner]').first();
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

    // 作品大标题横幅折叠 / 展开与原地重命名
    await pageA.getByRole('button', { name: '折叠作品 5th 演唱会' }).click();
    await expect(pageA.locator('[data-task-row]', { hasText: '0-36:37' })).toHaveCount(0);
    await pageA.getByRole('button', { name: '展开作品 5th 演唱会' }).click();
    const seg1Row = pageA.locator('[data-task-row]', { hasText: '0-36:37' });
    await expect(seg1Row).toHaveCount(1);

    await pageA.getByRole('button', { name: '作品操作 5th 演唱会' }).click();
    await pageA.getByRole('menuitem', { name: '重命名作品' }).click();
    const renameWorkInput = pageA.getByLabel('重命名作品 5th 演唱会');
    await renameWorkInput.fill('5th 专场演唱会');
    await renameWorkInput.press('Enter');
    await expect(workBanner).toContainText('5th 专场演唱会');

    // 验证键盘 ArrowDown 跨越作品大标题横幅（从独立行 5th 花絮 P2 跨过横幅到 0-36:37）
    const row2ForNav = pageA.locator('[data-task-row]', { hasText: '5th 花絮 P2' });
    const row2NavId = (await row2ForNav.getAttribute('data-task-row')) ?? '';
    const seg1Id = (await seg1Row.getAttribute('data-task-row')) ?? '';
    await clickCanvasCell(pageA, row2NavId, 'title');
    await pageA.keyboard.press('ArrowDown');
    await expect(pageA.getByTestId('worksheet-main-table')).toHaveAttribute(
      'data-selected-cell',
      `${seg1Id}:title`,
    );

    // 右键分段行打开任务详情侧栏 -> 顶部可见「所属作品共用附件（阶段 3 接入）」联动槽位
    await rightClickCanvasCell(pageA, seg1Id, 'title');
    await pageA.getByRole('menuitem', { name: '展开任务详情' }).click();
    const segDrawer = pageA.getByTestId('task-detail-drawer');
    await expect(segDrawer.getByTestId('work-shared-attachments-slot')).toContainText(
      '所属作品「5th 专场演唱会」共用附件',
    );
    await pageA.getByRole('button', { name: '关闭侧栏' }).click();

    // 验证「作品」列已从工作表与「字段显隐」中彻底移除，以及「分工说明」可显隐切换
    await pageA.getByTestId('field-visibility-trigger').click();
    const fieldPopover = pageA.locator('[data-radix-popper-content-wrapper]');
    await expect(fieldPopover.getByRole('button', { name: '作品', exact: true })).toHaveCount(0);
    await expect(pageA.getByTestId('col-header-work')).toHaveCount(0);

    await fieldPopover.getByRole('button', { name: '分工说明', exact: true }).click();
    await expect(pageA.getByTestId('col-header-divisionNote')).toHaveCount(0);
    await fieldPopover.getByRole('button', { name: '分工说明', exact: true }).click();
    await expect(pageA.getByTestId('col-header-divisionNote')).toHaveCount(1);
    await pageA.keyboard.press('Escape');

    // 确认工作表顶栏不再有重复的「表格视图 / 看板视图」切换（看板由顶栏「任务看板」标签统一承载）
    await expect(pageA.getByTestId('view-tab-grid')).toHaveCount(0);
    await expect(pageA.getByTestId('view-tab-board')).toHaveCount(0);

    // 点击 Canvas 第一道工序列（时轴）：锚定弹出 Radix StageCellEditor，选小爱 + 纯文本外援小王并设进行中
    await clickCanvasCell(pageA, task1Id, stage1ColId);
    const stagePopover = pageA.getByTestId('stage-cell-popover');
    await expect(stagePopover).toBeVisible();
    await stagePopover.getByRole('button', { name: '进行中', exact: true }).click();
    await stagePopover.getByRole('button', { name: USER_A_NAME, exact: true }).click();
    await stagePopover.getByPlaceholder('输入纯文本名字（如外援小王）').fill('外援小王');
    await stagePopover.getByRole('button', { name: '添加', exact: true }).click();
    await stagePopover.getByRole('button', { name: '保存', exact: true }).click();
    const stageCell1 = pageA.getByTestId(`cell-${task1Id}-${stage1ColId}`);
    await expect(stageCell1).toContainText(`${USER_A_NAME}、外援小王`);
    await expect(stageCell1).toHaveAttribute('data-stage-status', 'in_progress');

    // V3: 新建“待发全完任务”不折叠；将 P2 标为已发布 -> 移入顶部已发布折叠区
    await pageA.getByLabel('新建任务标题').fill('待发全完任务');
    await pageA.getByLabel('新建任务标题').press('Enter');
    await expect(pageA.getByTestId('worksheet-main-table')).toContainText('待发全完任务');

    await clickCanvasCell(pageA, row2NavId, 'publish');
    const pubPopover = pageA.getByTestId('publish-cell-popover');
    await expect(pubPopover).toBeVisible();
    await pubPopover.getByRole('button', { name: '已发布', exact: true }).click();
    await pubPopover.getByRole('button', { name: '保存', exact: true }).click();

    await expect(pageA.getByTestId('published-section')).toContainText('已发布（1 条）');
    await expect(pageA.getByTestId('worksheet-main-table')).not.toContainText('5th 花絮 P2');
    await pageA.getByRole('button', { name: /已发布（1 条）/ }).click();
    await expect(pageA.getByTestId('published-section')).toContainText('5th 花絮 P2');
    await expect(pageA.getByTestId('worksheet-main-table')).toContainText('待发全完任务');

    // V4: 删除「待发全完任务」，由另一用户在修改记录中一键恢复
    const doneRow = pageA.locator('[data-task-row]', { hasText: '待发全完任务' });
    const doneTaskId = (await doneRow.getAttribute('data-task-row')) ?? '';
    await rightClickCanvasCell(pageA, doneTaskId, 'title');
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
    await expect(pageA.getByTestId('worksheet-main-table')).toContainText('待发全完任务');

    await ctxA.close();
    await ctxB.close();
  });

  test('V5 + V6 + V7 + V12: 作品聚合看板、列竖向折叠、并行多列、双端抢认领、我的任务与跨表中文检索', async ({
    browser,
    request,
  }) => {
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

    // 任务 1：归属作品「周年庆特辑」，时轴与翻译并行进行中（小爱负责时轴），压制缺人（不上看板）
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

    // 任务 1B：同作品第二段（仅落在时轴列且缺人），用于验证时轴列 >=2 条默认展开作品父容器，翻译列仅 1 条不折叠
    const tParallel2 = await (
      await request.post(`${ORIGIN}/api/worksheets/${ws1.worksheet.id}/tasks`, {
        headers: { cookie: userA.cookie, origin: ORIGIN },
        data: { title: '并行直播后半段', workName: '周年庆特辑' },
      })
    ).json();

    // 任务 2：无作品独立任务，用于双端抢认领（翻译缺人）
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

    // V5: 验证 4 个初始看板列 + 看板列一键竖向折叠为 48px 窄条再展开
    const colTimingEl = pageA.locator('[data-board-column-name="时轴"]');
    const colTransEl = pageA.locator('[data-board-column-name="翻译"]');
    const colProofEl = pageA.locator('[data-board-column-name="校对"]');
    const colTypesetEl = pageA.locator('[data-board-column-name="嵌字"]');
    await expect(colTimingEl).toBeVisible();
    await expect(colTransEl).toBeVisible();
    await expect(colProofEl).toBeVisible();
    await expect(colTypesetEl).toBeVisible();

    await colTypesetEl.getByRole('button', { name: '折叠列 嵌字' }).click();
    await expect(colTypesetEl).toHaveAttribute('data-collapsed', 'true');
    await colTypesetEl.getByRole('button', { name: '展开列 嵌字' }).click();
    await expect(colTypesetEl).toHaveAttribute('data-collapsed', 'false');

    // 验证作品父子关系与排序（缺人优先，再进行中）：
    // 1) 「时轴」列同作品 >=2 条 -> 默认展开的作品父容器，标题右侧显示工作表名，无「仅看此作品」按钮，
    //    树形引导线子节点按「缺人 → 进行中」顺序展示
    const timingWorkGroup = colTimingEl.locator('[data-work-name="周年庆特辑"]');
    await expect(timingWorkGroup).toBeVisible();
    await expect(timingWorkGroup).toHaveAttribute('data-expanded', 'true');
    await expect(timingWorkGroup).toContainText('看板主表');
    await expect(timingWorkGroup.getByRole('button', { name: '筛选作品 周年庆特辑' })).toHaveCount(
      0,
    );
    const timingGroupCards = timingWorkGroup.locator('[data-testid^="board-card-"]');
    await expect(timingGroupCards).toHaveCount(2);
    // 第一条必为缺人（tParallel2），第二条为进行中（tParallel）
    await expect(timingGroupCards.nth(0)).toHaveAttribute(
      'data-testid',
      new RegExp(`^board-card-${tParallel2.id}-`),
    );
    await expect(timingGroupCards.nth(0)).toHaveAttribute('data-card-state', 'missing');
    await expect(timingGroupCards.nth(0)).toContainText('并行直播后半段');
    await expect(timingGroupCards.nth(0)).toContainText('时轴 · 缺人');
    await expect(timingGroupCards.nth(1)).toHaveAttribute(
      'data-testid',
      new RegExp(`^board-card-${tParallel.id}-`),
    );
    await expect(timingGroupCards.nth(1)).toHaveAttribute('data-card-state', 'in_progress');
    await expect(timingGroupCards.nth(1)).toContainText('并行直播剪辑');
    await expect(timingGroupCards.nth(1)).toContainText(`时轴 · ${USER_A_NAME} · 进行中`);
    await expect(timingGroupCards.nth(1)).toContainText('还缺');
    await expect(timingGroupCards.nth(1)).toContainText('压制');
    // 验证树形分支标记（前项 middle，末项 last）
    await expect(timingWorkGroup.locator('[data-tree-branch="middle"]')).toHaveCount(1);
    await expect(timingWorkGroup.locator('[data-tree-branch="last"]')).toHaveCount(1);

    const timingChild1 = timingWorkGroup.locator(`[data-testid^="board-card-${tParallel.id}-"]`);

    // 父容器支持平滑收起与再展开（收起态显示分段数）
    await timingWorkGroup.getByRole('button', { name: '收起作品 周年庆特辑 分段' }).click();
    await expect(timingWorkGroup).toHaveAttribute('data-expanded', 'false');
    await expect(timingWorkGroup).toContainText('2 段');
    await expect(timingChild1).toHaveCount(0);
    await timingWorkGroup.getByRole('button', { name: '展开作品 周年庆特辑 分段' }).click();
    await expect(timingWorkGroup).toHaveAttribute('data-expanded', 'true');
    await expect(timingChild1).toBeVisible();

    // 2) 「翻译」列同作品只有 1 条 -> 不套折叠父容器，直接平铺为带作品眉标的独立卡片；
    //    且「翻译」列按「缺人 → 进行中」排序，缺人的「待认领短片」排在进行中的「并行直播剪辑」前面
    await expect(colTransEl.locator('[data-testid^="board-work-group-"]')).toHaveCount(0);
    const transCards = colTransEl.locator('[data-testid^="board-card-"]');
    await expect(transCards.nth(0)).toHaveAttribute('data-card-state', 'missing');
    await expect(transCards.nth(0)).toContainText('待认领短片');
    const transSingleWorkCard = colTransEl.locator(`[data-testid^="board-card-${tParallel.id}-"]`);
    await expect(transSingleWorkCard).toBeVisible();
    await expect(transSingleWorkCard).toHaveAttribute('data-card-state', 'in_progress');
    await expect(transSingleWorkCard).toContainText('周年庆特辑');
    await expect(transSingleWorkCard).toContainText('看板主表');
    await expect(transSingleWorkCard).toContainText('翻译 · 官中字幕 · 进行中');

    // 开启「仅看缺人」时，其他缺人工序（如不上看板的「压制」）展开为可点击认领按钮
    await pageA.getByRole('button', { name: '仅看缺人' }).click();
    await expect(timingChild1.getByRole('button', { name: '缺 压制' })).toBeVisible();
    await pageA.getByRole('button', { name: '仅看缺人' }).click();

    // 无作品独立任务保持极简卡片、浅红缺人底色且不出「还缺 / 缺 校对」
    const claimCardA = colTransEl.locator(`[data-testid^="board-card-${tClaim.id}-"]`);
    await expect(claimCardA).toBeVisible();
    await expect(claimCardA).toHaveAttribute('data-card-state', 'missing');
    await expect(claimCardA).toContainText('翻译 · 缺人');
    await expect(claimCardA).not.toContainText('还缺');
    await expect(claimCardA).not.toContainText('缺 校对');
    await expect(colProofEl.locator(`[data-testid^="board-card-${tClaim.id}-"]`)).toHaveCount(0);

    // 通过顶部「按作品筛选」下拉选择「周年庆特辑」-> 只显示该作品，清除后恢复
    await pageA.getByLabel('按作品筛选').click();
    await pageA.getByRole('option', { name: '周年庆特辑' }).click();
    await expect(pageA.getByTestId('active-work-filter-chip')).toContainText('周年庆特辑');
    await expect(claimCardA).toHaveCount(0);
    await pageA.getByRole('button', { name: '清除作品筛选' }).click();
    await expect(claimCardA).toBeVisible();

    // 验证看板卡片上的「快速查看可下载资源」与「查看任务详情」按钮可用
    await claimCardA.getByTestId(`card-resources-btn-${tClaim.id}`).click();
    await expect(pageA.getByTestId(`task-resources-popover-${tClaim.id}`)).toContainText(
      '可下载资源',
    );
    await pageA.keyboard.press('Escape');
    await claimCardA.getByTestId(`card-detail-btn-${tClaim.id}`).click();
    await expect(pageA.getByTestId('task-detail-drawer')).toBeVisible();
    await pageA.getByRole('button', { name: '关闭侧栏' }).click();

    // V6: 甲在看板点击本列「认领」-> 卡片由缺人浅红变为已认领未开始白底，乙实时同步看到「翻译 · 小爱 · 未开始」
    const claimCardB = pageB
      .locator('[data-board-column-name="翻译"]')
      .locator(`[data-testid^="board-card-${tClaim.id}-"]`);
    await expect(claimCardB).toContainText('翻译 · 缺人');

    await claimCardA.getByRole('button', { name: '认领 翻译' }).click();
    await expect(claimCardA).toHaveAttribute('data-card-state', 'waiting');
    await expect(claimCardA).toContainText(`翻译 · ${USER_A_NAME} · 未开始`);
    await expect(claimCardA.getByRole('button', { name: '认领 翻译' })).toHaveCount(0);
    await expect(claimCardB).toContainText(`翻译 · ${USER_A_NAME} · 未开始`, { timeout: 3_000 });

    // V7: 左侧可折叠「我的任务」竖栏包含「进行中（黄）」与「待开始（白）」，支持一键完成与一键开始
    const myRail = pageA.getByTestId('my-in-progress-bar');
    await expect(myRail).toBeVisible();
    await expect(myRail).toHaveAttribute('data-collapsed', 'false');
    await expect(myRail.getByTestId('my-tasks-in-progress-list')).toContainText('并行直播剪辑');
    await expect(myRail.getByTestId('my-tasks-pending-list')).toContainText('待认领短片');

    // 验证「我的任务」卡片上的「快速查看可下载资源」与「查看任务详情」按钮可用
    const myInProgItem = myRail.getByTestId(`my-in-progress-item-${tParallel.id}-${colTiming.id}`);
    await myInProgItem.getByTestId(`card-resources-btn-${tParallel.id}`).click();
    await expect(pageA.getByTestId(`task-resources-popover-${tParallel.id}`)).toContainText(
      '作品共用：周年庆特辑',
    );
    await pageA.keyboard.press('Escape');
    await myInProgItem.getByTestId(`my-task-detail-btn-${tParallel.id}-${colTiming.id}`).click();
    await expect(pageA.getByTestId('task-detail-drawer')).toBeVisible();
    await pageA.getByRole('button', { name: '关闭侧栏' }).click();

    // 一键完成进行中的「并行直播剪辑」
    await myInProgItem.getByRole('button', { name: '完成' }).click();
    await expect(myRail).not.toContainText('并行直播剪辑');

    // 一键开始待开始的「待认领短片」-> 移入「进行中」并切为浅黄底色
    await myRail
      .locator(`[data-testid^="my-pending-item-${tClaim.id}-"]`)
      .getByRole('button', { name: '开始' })
      .click();
    await expect(myRail.getByTestId('my-tasks-in-progress-list')).toContainText('待认领短片');
    await expect(claimCardA).toHaveAttribute('data-card-state', 'in_progress');
    await expect(claimCardA).toContainText(`翻译 · ${USER_A_NAME} · 进行中`);

    // 左侧「我的任务」竖栏支持一键折叠与展开
    await myRail.getByRole('button', { name: '折叠我的任务' }).click();
    await expect(myRail).toHaveAttribute('data-collapsed', 'true');
    await myRail.getByRole('button', { name: '展开我的任务' }).click();
    await expect(myRail).toHaveAttribute('data-collapsed', 'false');

    // V12: 融合在「筛选关键词」中的跨表资源检索（支持自定义文本列 & 纯文本负责人），点击直达工作表并打开详情侧栏
    const homeKeywordInput = pageA.getByLabel('筛选关键词');
    await homeKeywordInput.fill('BD_RAW_2026');
    await expect(pageA.getByTestId('global-search-dropdown')).toBeVisible();
    await expect(pageA.getByTestId(`search-result-${tParallel.id}`)).toBeVisible();
    await homeKeywordInput.fill('官中字幕');
    await expect(pageA.getByTestId(`search-result-${tParallel.id}`)).toBeVisible();
    await pageA.getByTestId(`search-result-${tParallel.id}`).click();
    await expect(pageA).toHaveURL(new RegExp(`/worksheets/${ws1.worksheet.id}`));
    const drawer = pageA.getByTestId('task-detail-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByLabel('标题', { exact: true })).toHaveValue('并行直播剪辑');

    expect(colEncode.id).toBeTruthy();

    await ctxA.close();
    await ctxB.close();
  });

  test('V8 + V9 + V10 + V11 + V14: 双端实时协同、Canvas 在线状态焦点、中文 IME 冲突浮条、断线补发与 390px 窄屏', async ({
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

    // V9: 乙看到甲在线，甲双击 Canvas 标题格进入编辑态时乙看到“小爱 正在编辑”浮标
    await expect(pageB.getByTestId('presence-bar')).toContainText(USER_A_NAME);
    await dblClickCanvasCell(pageA, task.id, 'title');
    const titleEditorA = pageA.getByTestId(`canvas-editor-${task.id}-title`).locator('input');
    await expect(titleEditorA).toBeVisible();
    await expect(pageB.getByTestId('peer-focus-badge')).toContainText(`${USER_A_NAME} 正在编辑`);

    // V8: 甲改标题，同时乙改同一行分工说明 -> 两者均保留并实时同步
    await titleEditorA.fill('甲修改的标题');
    await dblClickCanvasCell(pageB, task.id, 'divisionNote');
    const divEditorB = pageB.getByTestId(`canvas-editor-${task.id}-divisionNote`).locator('input');
    await expect(divEditorB).toBeVisible();
    await divEditorB.fill('乙修改的分工');

    await titleEditorA.press('Enter');
    await divEditorB.press('Enter');

    await expect(pageB.getByTestId(`cell-${task.id}-title`)).toContainText('甲修改的标题');
    await expect(pageA.getByTestId(`cell-${task.id}-divisionNote`)).toContainText('乙修改的分工');

    // V10: 中文输入法组字期间收到远端同格修改 -> 不打断输入、不丢草稿、弹出冲突浮条
    await dblClickCanvasCell(pageB, task.id, 'title');
    const inputB = pageB.getByTestId(`canvas-editor-${task.id}-title`).locator('input');
    await expect(inputB).toBeVisible();
    await inputB.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'zhong' }));
    });
    await inputB.fill('乙正在组字的草稿');
    // 组字期间按 Enter 不误提交
    await inputB.press('Enter');
    await expect(inputB).toBeVisible();

    // 甲同时修改并保存同一格
    await dblClickCanvasCell(pageA, task.id, 'title');
    const inputA2 = pageA.getByTestId(`canvas-editor-${task.id}-title`).locator('input');
    await inputA2.fill('甲抢先保存的值');
    await inputA2.press('Enter');

    // 乙的草稿不被覆盖，冲突浮条出现
    const conflictBar = pageB.getByTestId('cell-conflict-bar');
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
    await expect(pageB.getByTestId(`cell-${task.id}-title`)).toContainText('乙正在组字的草稿');
    await expect(pageA.getByTestId(`cell-${task.id}-title`)).toContainText('乙正在组字的草稿');

    // 再验证「采用对方的」
    await dblClickCanvasCell(pageB, task.id, 'title');
    const inputB2 = pageB.getByTestId(`canvas-editor-${task.id}-title`).locator('input');
    await inputB2.fill('乙将放弃的草稿');
    await dblClickCanvasCell(pageA, task.id, 'title');
    const inputA3 = pageA.getByTestId(`canvas-editor-${task.id}-title`).locator('input');
    await inputA3.fill('甲最新定稿');
    await inputA3.press('Enter');
    await expect(pageB.getByTestId('cell-conflict-bar')).toBeVisible();
    await pageB
      .getByTestId('cell-conflict-bar')
      .getByRole('button', { name: '采用对方的' })
      .click();
    await expect(pageB.getByTestId(`cell-${task.id}-title`)).toContainText('甲最新定稿');

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

    // V14: 390×844 手机视口检查工作表 Canvas 与首页看板均无页面级横向溢出
    await pageB.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(pageB);
    await pageB.goto('/');
    await expect(pageB.getByTestId('board-columns')).toBeVisible();
    await expectNoHorizontalOverflow(pageB);

    await ctxA.close();
    await ctxB.close();
  });
});
