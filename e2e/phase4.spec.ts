import { readFileSync } from 'node:fs';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { expectNoHorizontalOverflow, loginViaUi, readE2eState } from './helpers.js';

const ORIGIN = 'http://127.0.0.1:3100';
const ADMIN_PW = 'AdminE2eSecret_2026!';
const USER_A_LOGIN = 'p4_alice';
const USER_A_NAME = '四期小爱';
const USER_A_PW = 'Phase4Alice_2026!';
const USER_B_LOGIN = 'p4_bob';
const USER_B_NAME = '四期小博';
const USER_B_PW = 'Phase4Bob_2026!';

// 1x1 透明 PNG 最小合法字节
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

// GB18030 编码的 "无名字幕组测试\n"
const GB18030_SUBTITLE = Buffer.from([
  0xce, 0xde, 0xc3, 0xfb, 0xd7, 0xd6, 0xc4, 0xbb, 0xd7, 0xe9, 0xb2, 0xe2, 0xca, 0xd4, 0x0a,
]);

interface GridGeometryHost extends HTMLDivElement {
  __nwGridGeometry?: {
    getCellPoint: (taskId: string, columnKey: string) => { x: number; y: number } | null;
    getStageBadgePoint: (taskId: string, columnKey: string) => { x: number; y: number } | null;
  };
}

async function clickCanvasPoint(
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
  const resolved = pt as { x: number; y: number };
  await page.mouse.move(resolved.x, resolved.y);
  await page.mouse.click(resolved.x, resolved.y);
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

test.describe('阶段 4 端到端验收（V1–V13：R2 直传、分片续传、中文名下载、在线预览、实时协同与窄屏）', () => {
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

  test('V1 + V2 + V3 + V6 + V9 + V11: 四级直传、同名两版下载旧版、同版文件+多网盘共存、原地补传、软删撤销与双端实时同步', async ({
    browser,
    request,
  }) => {
    const authHdr = { cookie: userA.cookie, origin: ORIGIN };
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await loginViaUi(pageA, USER_A_LOGIN, USER_A_PW);
    await loginViaUi(pageB, USER_B_LOGIN, USER_B_PW);

    // 1. 通用文档上传中文名 .ass -> 双端实时同步（V1, V11）
    await pageA.goto('/docs');
    await pageB.goto('/docs');

    const v1Text =
      '[Script Info]\nTitle: 第01话初稿字幕\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,第一版台词\n';
    const v2Text =
      '[Script Info]\nTitle: 第01话终稿字幕\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,第二版修订台词\n';
    const zhFilename = '【无名字幕组】第01话 テスト.ass';

    await pageA.getByTestId('docs-create-btn').click();
    await pageA.getByTestId('artifact-file-input').setInputFiles({
      name: zhFilename,
      mimeType: 'text/plain',
      buffer: Buffer.from(v1Text, 'utf8'),
    });
    // 名称为空时自动预填所选文件名
    await expect(pageA.getByTestId('artifact-name-input')).toHaveValue(zhFilename);
    await pageA.getByTestId('artifact-name-input').fill('四期字幕样本');
    await pageA.getByTestId('artifact-submit-btn').click();

    await expect(pageA.getByTestId('upload-stage-completed').first()).toBeVisible();
    const cardA = pageA
      .locator('[data-testid^="artifact-card-"]', { hasText: '四期字幕样本' })
      .first();
    await expect(cardA).toBeVisible();
    await expect(cardA).toContainText(zhFilename);

    // 乙端无需刷新自动可见（V11）
    const cardB = pageB
      .locator('[data-testid^="artifact-card-"]', { hasText: '四期字幕样本' })
      .first();
    await expect(cardB).toBeVisible();
    await expect(cardB).toContainText(zhFilename);

    const artId = ((await cardA.getAttribute('data-testid')) ?? '').replace('artifact-card-', '');
    const v1DownloadLink = cardA.locator('[data-testid^="location-download-"]').first();
    const v1DownloadHref = (await v1DownloadLink.getAttribute('href')) ?? '';
    expect(v1DownloadHref).toContain('/download');

    // 2. 上传同名 .ass 作为 v2 -> 立即成为最新，展开历史 v1 与 v2 均可下载且字节不同（V2, V6）
    await pageA.getByTestId(`artifact-add-version-${artId}`).click();
    await pageA.getByTestId('version-file-input').setInputFiles({
      name: zhFilename,
      mimeType: 'text/plain',
      buffer: Buffer.from(v2Text, 'utf8'),
    });
    await pageA.getByTestId('version-note-input').fill('校对终稿');
    await pageA.getByTestId('version-submit-btn').click();

    await expect(pageA.getByTestId(`artifact-latest-badge-${artId}`)).toHaveText('v2');
    await expect(pageB.getByTestId(`artifact-latest-badge-${artId}`)).toHaveText('v2');

    // 通过 API/cookies 校验 v1 与 v2 的下载响应头（attachment + RFC 5987 中文名）与真实字节
    const v2DownloadHref =
      (await cardA.locator('[data-testid^="location-download-"]').first().getAttribute('href')) ??
      '';
    expect(v2DownloadHref).not.toBe(v1DownloadHref);

    const dl1Redirect = await request.get(`${ORIGIN}${v1DownloadHref}`, {
      headers: { cookie: userA.cookie },
      maxRedirects: 0,
    });
    expect(dl1Redirect.status()).toBe(302);
    const dl1Final = await request.get(dl1Redirect.headers().location ?? '');
    expect(dl1Final.status()).toBe(200);
    expect(dl1Final.headers()['content-disposition']).toContain('attachment;');
    expect(dl1Final.headers()['content-disposition']).toContain("filename*=UTF-8''");
    expect(await dl1Final.text()).toBe(v1Text);

    const dl2Redirect = await request.get(`${ORIGIN}${v2DownloadHref}`, {
      headers: { cookie: userA.cookie },
      maxRedirects: 0,
    });
    const dl2Final = await request.get(dl2Redirect.headers().location ?? '');
    expect(await dl2Final.text()).toBe(v2Text);

    // 3. 同版本补充百度网盘 -> 文件行与网盘行并列展示，单独软删 R2 文件不影响网盘且撤销恢复可用（V3, V9）
    await pageA.getByTestId(`artifact-menu-${artId}`).click();
    await pageA.getByTestId(`artifact-add-location-${artId}`).click();
    await pageA.getByTestId('location-url-input').fill('https://pan.baidu.com/s/1p4coexist');
    await pageA.getByTestId('location-code-input').fill('r2ok');
    await pageA.getByTestId('location-submit-btn').click();

    await expect(cardA).toContainText('百度网盘');
    await expect(cardA).toContainText('r2ok');
    await expect(cardA).toContainText(zhFilename);

    // 移除 R2 文件入口 -> 百度网盘行保留，Toast 撤销恢复后文件重新可见
    await cardA.locator('[data-location-type="r2"] button[aria-label="文件操作"]').click();
    await pageA.getByRole('menuitem', { name: '移除文件' }).click();
    await expect(cardA.locator('[data-location-type="r2"]')).toHaveCount(0);
    await expect(cardA).toContainText('百度网盘');

    await pageA.getByRole('button', { name: '撤销' }).click();
    await expect(cardA.locator('[data-location-type="r2"]')).toHaveCount(1);

    // 4. 给纯网盘资源 v1 原地补传文件 -> 不升版本（V3）
    await pageA.getByTestId('docs-create-btn').click();
    await pageA.getByTestId('create-mode-link').click();
    await pageA.getByTestId('artifact-name-input').fill('先网盘后补传');
    await pageA.getByTestId('artifact-url-input').fill('https://mega.nz/file/p4attach01');
    await pageA.getByTestId('artifact-submit-btn').click();

    const attachCard = pageA
      .locator('[data-testid^="artifact-card-"]', { hasText: '先网盘后补传' })
      .first();
    await expect(attachCard).toBeVisible();
    const attachArtId = ((await attachCard.getAttribute('data-testid')) ?? '').replace(
      'artifact-card-',
      '',
    );

    await pageA.getByTestId(`artifact-menu-${attachArtId}`).click();
    await pageA.getByTestId(`artifact-attach-file-${attachArtId}`).click();
    await pageA.getByTestId('attach-file-input').setInputFiles({
      name: '补传文件.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('attached-to-v1', 'utf8'),
    });
    await pageA.getByTestId('attach-file-submit-btn').click();
    await expect(attachCard).toContainText('补传文件.txt');
    await expect(pageA.getByTestId(`artifact-latest-badge-${attachArtId}`)).toHaveText('v1');

    // 5. 工作表四级挂载（作品横幅 R2 胶囊弹浮层防误触 + 工序格直传 + 看板弹层取用）（V1）
    const wsRes = await request.post(`${ORIGIN}/api/worksheets`, {
      headers: authHdr,
      data: { name: `四期直传表-${Date.now().toString(36)}`, template: 'standard_video' },
    });
    const { worksheet, columns } = (await wsRes.json()) as {
      worksheet: { id: string };
      columns: Array<{ id: string; name: string }>;
    };
    const timingCol = columns.find((c) => c.name === '时轴')!;

    const taskRes = await request.post(`${ORIGIN}/api/worksheets/${worksheet.id}/tasks`, {
      headers: authHdr,
      data: { title: 'Ep01 正片', workName: '四期作品' },
    });
    const task = (await taskRes.json()) as { id: string; workId: string };

    await pageA.goto(`/worksheets/${worksheet.id}`);
    await expect(pageA.getByTestId(`work-banner-${task.workId}`)).toBeVisible();

    // 作品横幅上传 R2 文件 -> 胶囊点击弹 ArtifactQuickPopover（不直接触发下载）
    await pageA.getByTestId(`work-add-attachment-${task.workId}`).click();
    await pageA.getByTestId('quick-popover-add-btn').click();
    await pageA.getByTestId('artifact-file-input').setInputFiles({
      name: '原片信息.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('raw-info', 'utf8'),
    });
    await pageA.getByTestId('artifact-name-input').fill('作品原片');
    await pageA.getByTestId('artifact-submit-btn').click();

    const workPopoverCapsule = pageA
      .locator(
        `[data-work-attachment-slots="${task.workId}"] [data-testid^="work-capsule-popover-"]`,
        {
          hasText: '作品原片',
        },
      )
      .first();
    await expect(workPopoverCapsule).toBeVisible();
    await workPopoverCapsule.click();
    await expect(pageA.getByTestId('artifact-quick-popover')).toContainText('原片信息.txt');
    await pageA.getByTestId('quick-popover-close-btn').click();

    // 工序格上传 R2 文件 -> 点击角标弹出取用浮层
    await clickCanvasPoint(pageA, 'getCellPoint', task.id, timingCol.id);
    await pageA.getByTestId('stage-popover-manage-artifacts').click();
    await pageA.getByTestId('quick-popover-add-btn').click();
    await pageA.getByTestId('artifact-file-input').setInputFiles({
      name: '时轴交付.ass',
      mimeType: 'text/plain',
      buffer: Buffer.from('[Script Info]\nTitle: 时轴\n', 'utf8'),
    });
    // 不覆盖工序格默认预填名称「四期作品-Ep01 正片-时轴」
    await expect(pageA.getByTestId('artifact-name-input')).toHaveValue('四期作品-Ep01 正片-时轴');
    await pageA.getByTestId('artifact-submit-btn').click();
    await expect(pageA.getByTestId('upload-stage-completed').first()).toBeVisible();

    await clickCanvasPoint(pageA, 'getStageBadgePoint', task.id, timingCol.id);
    await expect(pageA.getByTestId('artifact-quick-popover')).toContainText('时轴交付.ass');
    await pageA.keyboard.press('Escape');

    // 看板卡片资源弹层可直接下载/预览
    await pageA.goto('/');
    const boardResBtn = pageA
      .getByTestId('board-columns')
      .getByTestId(`card-resources-btn-${task.id}`)
      .first();
    await expect(boardResBtn).toBeVisible();
    await boardResBtn.click();
    const resPop = pageA.getByTestId(`task-resources-popover-${task.id}`);
    await expect(resPop).toContainText('原片信息.txt');
    await expect(resPop).toContainText('时轴交付.ass');

    await ctxA.close();
    await ctxB.close();
  });

  test('V4 + V8 + V10: 分片上传单片重试、刷新重选续传（拒绝错内容）、取消清理、跳过续传与文本/编码/图片/SVG 预览', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await loginViaUi(page, USER_A_LOGIN, USER_A_PW);
    await page.goto('/docs');

    // 1. V4: 6 MiB 分片文件（5 MiB + 1 MiB = 2 片），模拟第 2 片首次 500 失败 -> 自动重传成功
    const bigBufA = Buffer.alloc(6 * 1024 * 1024, 0x41);
    const bigBufWrong = Buffer.alloc(6 * 1024 * 1024, 0x5a);

    let failPart2Once = true;
    await page.route('**/stub*partNumber=2*', async (route) => {
      if (failPart2Once && route.request().method() === 'PUT') {
        failPart2Once = false;
        await route.fulfill({ status: 500, body: 'transient error' });
        return;
      }
      await route.continue();
    });

    await page.getByTestId('docs-create-btn').click();
    await page.getByTestId('artifact-file-input').setInputFiles({
      name: '分片重试样本.bin',
      mimeType: 'application/octet-stream',
      buffer: bigBufA,
    });
    await page.getByTestId('artifact-name-input').fill('分片重试样本');
    await page.getByTestId('artifact-submit-btn').click();

    const retryCard = page
      .locator('[data-testid^="artifact-card-"]', { hasText: '分片重试样本' })
      .first();
    await expect(retryCard).toBeVisible({ timeout: 25_000 });
    expect(failPart2Once).toBe(false);
    await page.unroute('**/stub*partNumber=2*');

    // 2. V4: 刷新页面后待续传记录 -> 错内容拒绝 -> 原文件续传跳过已完成分片 1 并成功
    let part2SignHit = false;
    await page.route('**/api/uploads/sessions/*/parts/2/sign', async (route) => {
      part2SignHit = true;
      await route.abort('failed');
    });

    await page.getByTestId('docs-create-btn').click();
    await page.getByTestId('artifact-file-input').setInputFiles({
      name: '断点续传样本.bin',
      mimeType: 'application/octet-stream',
      buffer: bigBufA,
    });
    await page.getByTestId('artifact-name-input').fill('断点续传样本');
    await page.getByTestId('artifact-submit-btn').click();

    // 等待第 1 片传完且第 2 片遇到中断进入错误态（保留 localStorage 断点）
    await expect.poll(() => part2SignHit, { timeout: 20_000 }).toBe(true);
    await expect(page.getByTestId('upload-stage-error')).toBeVisible({ timeout: 20_000 });

    await page.unroute('**/api/uploads/sessions/*/parts/2/sign');

    // 刷新页面 -> 队列自动出现待续传记录
    await page.reload();
    await expect(page.getByTestId('upload-stage-resumable')).toBeVisible();

    // 重选大小相同但内容不同的文件 -> 明确拒绝不误恢复
    const resumeInput = page.locator('[data-testid^="upload-resume-input-"]').first();
    await resumeInput.setInputFiles({
      name: '断点续传样本.bin',
      mimeType: 'application/octet-stream',
      buffer: bigBufWrong,
    });
    await expect(page.getByTestId('upload-stage-resumable')).toContainText(
      '所选文件内容与中断前不一致',
    );

    // 重选原文件 -> 跳过分片 1（仅签发分片 2）续传完成
    const signedPartNumbers: number[] = [];
    page.on('request', (req) => {
      const m = req.url().match(/\/api\/uploads\/sessions\/[^/]+\/parts\/(\d+)\/sign$/);
      if (m) signedPartNumbers.push(Number(m[1]));
    });

    await resumeInput.setInputFiles({
      name: '断点续传样本.bin',
      mimeType: 'application/octet-stream',
      buffer: bigBufA,
    });
    const resumedCard = page
      .locator('[data-testid^="artifact-card-"]', { hasText: '断点续传样本' })
      .first();
    await expect(resumedCard).toBeVisible({ timeout: 25_000 });
    expect(signedPartNumbers).toContain(2);
    expect(signedPartNumbers).not.toContain(1);

    // 3. V4/V8: 取消上传调用服务端 Abort 并清理队列
    let abortCalled = false;
    page.on('response', (res) => {
      if (res.url().includes('/abort') && res.status() === 200) {
        abortCalled = true;
      }
    });
    await page.route('**/api/uploads/sessions/*/parts/2/sign', async (route) => {
      await route.abort('failed');
    });

    await page.getByTestId('docs-create-btn').click();
    await page.getByTestId('artifact-file-input').setInputFiles({
      name: '取消样本.bin',
      mimeType: 'application/octet-stream',
      buffer: bigBufWrong,
    });
    await page.getByTestId('artifact-name-input').fill('取消样本');
    await page.getByTestId('artifact-submit-btn').click();
    await expect(page.getByTestId('upload-stage-error')).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-testid^="upload-cancel-"]').first().click();
    await expect.poll(() => abortCalled).toBe(true);
    await page.unroute('**/api/uploads/sessions/*/parts/2/sign');

    // 4. V10: 在线预览（GB18030 字幕编码切换、PNG 图片、SVG 禁内联与 PSD 仅下载）
    const uploadSmallDoc = async (
      name: string,
      filename: string,
      mimeType: string,
      buffer: Buffer,
    ) => {
      await page.getByTestId('docs-create-btn').click();
      await page
        .getByTestId('artifact-file-input')
        .setInputFiles({ name: filename, mimeType, buffer });
      await page.getByTestId('artifact-name-input').fill(name);
      await page.getByTestId('artifact-submit-btn').click();
      const card = page.locator('[data-testid^="artifact-card-"]', { hasText: name }).first();
      await expect(card).toBeVisible();
      return card;
    };

    const gbCard = await uploadSmallDoc('GB18030字幕', 'gb.srt', 'text/plain', GB18030_SUBTITLE);
    await gbCard.locator('[data-testid^="location-preview-"]').click();
    await expect(page.getByTestId('preview-text-view')).toBeVisible();
    await page.getByTestId('preview-encoding-select').selectOption('gb18030');
    await expect(page.getByTestId('preview-text-content')).toContainText('无名字幕组测试');
    await page.keyboard.press('Escape');

    const pngCard = await uploadSmallDoc('示例图片', 'cover.png', 'image/png', TINY_PNG);
    await pngCard.locator('[data-testid^="location-preview-"]').click();
    await expect(page.getByTestId('preview-image-view')).toBeVisible();
    await page.keyboard.press('Escape');

    const svgCard = await uploadSmallDoc(
      '矢量禁内联',
      'evil.svg',
      'image/svg+xml',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    );
    await svgCard.locator('[data-testid^="location-preview-"]').click();
    await expect(page.getByTestId('preview-unsupported-view')).toBeVisible();
    await expect(page.getByTestId('preview-image-view')).toHaveCount(0);
    await page.keyboard.press('Escape');

    const psdCard = await uploadSmallDoc(
      '封面设计稿',
      'poster.psd',
      'application/octet-stream',
      Buffer.from('8BPS-mock-psd'),
    );
    await psdCard.locator('[data-testid^="location-preview-"]').click();
    await expect(page.getByTestId('preview-unsupported-view')).toBeVisible();
    await expect(page.getByTestId('preview-download-btn')).toBeVisible();
    await page.keyboard.press('Escape');

    await ctx.close();
  });

  test('V12 + V13: 390×844 手机窄屏上传与预览零横向溢出 + 服务端日志零签名 URL 与 R2 key 泄漏', async ({
    browser,
  }) => {
    const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await mobileCtx.newPage();
    await loginViaUi(page, USER_A_LOGIN, USER_A_PW);

    await page.goto('/docs');
    await expect(page.getByTestId('docs-page')).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByTestId('docs-create-btn').click();
    await expect(page.getByTestId('artifact-create-form')).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByTestId('artifact-file-input').setInputFiles({
      name: '手机端字幕.ass',
      mimeType: 'text/plain',
      buffer: Buffer.from('[Script Info]\nTitle: Mobile\n', 'utf8'),
    });
    await page.getByTestId('artifact-name-input').fill('手机端测试文件');
    await page.getByTestId('artifact-submit-btn').click();

    await expect(page.getByTestId('upload-queue-dock')).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const card = page
      .locator('[data-testid^="artifact-card-"]', { hasText: '手机端测试文件' })
      .first();
    await expect(card).toBeVisible();
    await card.locator('[data-testid^="location-preview-"]').click();
    await expect(page.getByTestId('file-preview-modal')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.keyboard.press('Escape');

    await mobileCtx.close();

    // V12: 审计服务端真实 Pino 日志（含 302 下载重定向日志），确认零签名参数与零 R2 key 泄漏
    const { logPath } = readE2eState();
    const logs = readFileSync(logPath, 'utf8');
    expect(logs).not.toContain('sig=');
    expect(logs).not.toContain('X-Amz-Signature');
    expect(logs).not.toMatch(/projects\/[0-9a-f-]+\/blobs\//);
  });
});
