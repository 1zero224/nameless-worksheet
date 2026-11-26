import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

interface E2eState {
  resetUrl: string;
  logPath: string;
}

function readState(): E2eState {
  const p = path.resolve(process.cwd(), 'e2e', '.state.json');
  return JSON.parse(readFileSync(p, 'utf8')) as E2eState;
}

const ADMIN_PW = 'AdminE2eSecret_2026!';
const USER_PW = 'UserE2eSecret_2026!';
const ADMIN2_PW = 'Admin2E2eSecret_2026!';

test.describe
  .serial('阶段 1 端到端验收（V1/V4/V5/V6/V8/V9）', () => {
    let inviteUrlSingle = '';
    let inviteUrlAdmin2 = '';
    let resetUrlAdmin2 = '';

    test('初始化管理员通过重置链接设置密码并登录', async ({ page }) => {
      const { resetUrl } = readState();
      await page.goto(resetUrl);

      await expect(page.getByText('设置新密码')).toBeVisible();
      await expect(page.getByText('初始管理员')).toBeVisible();
      await expect(page.getByText('admin_e2e')).toBeVisible();

      await page.getByLabel('新密码', { exact: true }).fill(ADMIN_PW);
      await page.getByLabel('确认新密码').fill(ADMIN_PW);
      await page.getByRole('button', { name: '保存新密码' }).click();

      await expect(page).toHaveURL(/\/login\?reset=1/);
      await expect(page.getByText('密码已设置，请使用新密码登录')).toBeVisible();

      await page.getByLabel('登录名').fill('admin_e2e');
      await page.getByLabel('密码').fill(ADMIN_PW);
      await page.getByRole('button', { name: '登录' }).click();

      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole('heading', { name: '首页' })).toBeAttached();
      await page.getByTestId('user-avatar-trigger').click();
      await expect(page.getByRole('menuitem', { name: '用户与邀请' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: '实时通道诊断' })).toBeVisible();
    });

    test('V1 + V9 + V4(UI) + 390px: 邀请注册中文/假名/全角显示名、单次邀请失效、普通用户权限与窄屏', async ({
      browser,
    }) => {
      // 管理员创建单次普通用户邀请
      const adminCtx = await browser.newContext();
      const adminPage = await adminCtx.newPage();
      await adminPage.goto('/login');
      await adminPage.getByLabel('登录名').fill('admin_e2e');
      await adminPage.getByLabel('密码').fill(ADMIN_PW);
      await adminPage.getByRole('button', { name: '登录' }).click();
      await expect(adminPage).toHaveURL(/\/$/);

      await adminPage.getByTestId('user-avatar-trigger').click();
      await adminPage.getByRole('menuitem', { name: '用户与邀请' }).click();
      await expect(adminPage.getByRole('heading', { name: '用户与邀请' })).toBeVisible();

      await adminPage.getByRole('button', { name: '生成邀请链接' }).click();
      const linkInput = adminPage.getByTestId('one-time-link-input');
      await expect(linkInput).toBeVisible();
      inviteUrlSingle = await linkInput.inputValue();
      expect(inviteUrlSingle).toContain('/invite/');
      await adminPage.getByRole('button', { name: '我已保存' }).click();
      await adminCtx.close();

      // 新浏览器上下文打开邀请链接注册（V1 + V9）
      const userCtx = await browser.newContext();
      const userPage = await userCtx.newPage();
      await userPage.goto(inviteUrlSingle);

      await expect(pageText(userPage, '无名字幕组')).toBeVisible();
      await userPage.getByLabel('登录名').fill('sakura_01');
      await userPage.getByLabel('显示名').fill('さくら＿ＡＢＣ测试');
      await userPage.getByLabel('密码', { exact: true }).fill(USER_PW);
      await userPage.getByLabel('确认密码').fill(USER_PW);
      await userPage.getByRole('button', { name: '完成注册' }).click();

      await expect(userPage).toHaveURL(/\/$/);
      await userPage.getByTestId('user-avatar-trigger').click();
      await expect(userPage.getByText('さくら＿ＡＢＣ测试').first()).toBeVisible();

      // V4(UI): 普通用户在右上角头像菜单中看不到管理入口，直接访问管理页显示无权访问
      await expect(userPage.getByRole('menuitem', { name: '用户与邀请' })).toHaveCount(0);
      await expect(userPage.getByRole('menuitem', { name: '实时通道诊断' })).toHaveCount(0);
      await userPage.keyboard.press('Escape');
      await userPage.goto('/admin/users');
      await expect(userPage.getByRole('heading', { name: '无权访问' })).toBeVisible();

      // V9: 修改显示名
      await userPage.goto('/settings');
      await userPage.getByLabel('显示名').fill('さくら＿修改后');
      await userPage.getByRole('button', { name: '保存显示名' }).click();
      await expect(userPage.getByText('显示名已更新')).toBeVisible();

      // 390px 窄屏顶部标签栏与头像菜单无横向滚动
      await userPage.setViewportSize({ width: 390, height: 844 });
      const overflow = await userPage.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(overflow).toBe(false);
      await userPage.getByTestId('user-avatar-trigger').click();
      await expect(userPage.getByRole('menuitem', { name: '工作表总览' })).toBeVisible();
      await userCtx.close();

      // 再次打开同一条单次邀请 -> 显示无效
      const againCtx = await browser.newContext();
      const againPage = await againCtx.newPage();
      await againPage.goto(inviteUrlSingle);
      await expect(againPage.getByText('邀请链接无效或已过期，请联系管理员')).toBeVisible();
      await againCtx.close();
    });

    test('V5 + V6: 两管理员实时互发、模拟断线补发、管理员重置踢下线', async ({ browser }) => {
      const ctxA = await browser.newContext();
      const pageA = await ctxA.newPage();
      await pageA.goto('/login');
      await pageA.getByLabel('登录名').fill('admin_e2e');
      await pageA.getByLabel('密码').fill(ADMIN_PW);
      await pageA.getByRole('button', { name: '登录' }).click();
      await expect(pageA).toHaveURL(/\/$/);

      // 管理员甲创建一条管理员邀请给乙
      await pageA.getByTestId('user-avatar-trigger').click();
      await pageA.getByRole('menuitem', { name: '用户与邀请' }).click();
      await pageA.locator('#invRole').click();
      await pageA.getByRole('option', { name: '管理员', exact: true }).click();
      await pageA.getByRole('button', { name: '生成邀请链接' }).click();
      inviteUrlAdmin2 = await pageA.getByTestId('one-time-link-input').inputValue();
      await pageA.getByRole('button', { name: '我已保存' }).click();

      // 管理员乙注册并进入诊断页
      const ctxB = await browser.newContext();
      const pageB = await ctxB.newPage();
      await pageB.goto(inviteUrlAdmin2);
      await pageB.getByLabel('登录名').fill('admin_two');
      await pageB.getByLabel('显示名').fill('管理员乙');
      await pageB.getByLabel('密码', { exact: true }).fill(ADMIN2_PW);
      await pageB.getByLabel('确认密码').fill(ADMIN2_PW);
      await pageB.getByRole('button', { name: '完成注册' }).click();
      await expect(pageB).toHaveURL(/\/$/);

      await pageA.getByTestId('user-avatar-trigger').click();
      await pageA.getByRole('menuitem', { name: '实时通道诊断' }).click();
      await pageB.getByTestId('user-avatar-trigger').click();
      await pageB.getByRole('menuitem', { name: '实时通道诊断' }).click();

      await expect(pageA.getByText('已连接')).toBeVisible();
      await expect(pageB.getByText('已连接')).toBeVisible();
      await expect(pageB.getByTestId('diag-cursor')).not.toHaveText('-');

      // V5-1: 甲发送测试事件，乙在 1 秒内看到
      await pageA.getByLabel('测试事件内容').fill('live-ping-from-A');
      await pageA.getByRole('button', { name: '发送测试事件' }).click();
      await expect(pageB.getByTestId('diag-event-log')).toContainText('live-ping-from-A', {
        timeout: 2_000,
      });

      // V5-2: 乙模拟断线，甲再发 3 条，乙恢复连接后按顺序补齐且不重复
      await pageB.getByRole('button', { name: '模拟断线' }).click();
      await expect(pageB.getByText('已模拟断线')).toBeVisible();

      for (const msg of ['replay-msg-1', 'replay-msg-2', 'replay-msg-3']) {
        await pageA.getByLabel('测试事件内容').fill(msg);
        await pageA.getByRole('button', { name: '发送测试事件' }).click();
        await expect(pageA.getByText(/已发送测试事件/)).toBeVisible();
      }

      await pageB.getByRole('button', { name: '恢复连接' }).click();
      await expect(pageB.getByText('已连接')).toBeVisible();

      const logList = pageB.getByTestId('diag-event-log');
      await expect(logList).toContainText('replay-msg-1');
      await expect(logList).toContainText('replay-msg-2');
      await expect(logList).toContainText('replay-msg-3');

      // 倒序日志中最新在最前：replay-msg-3 -> replay-msg-2 -> replay-msg-1
      const logText = await logList.innerText();
      expect(logText.indexOf('replay-msg-3')).toBeLessThan(logText.indexOf('replay-msg-2'));
      expect(logText.indexOf('replay-msg-2')).toBeLessThan(logText.indexOf('replay-msg-1'));
      expect(logText.split('replay-msg-1')).toHaveLength(2); // 不重复

      // V6: 乙停留在诊断页，甲为乙生成重置链接 -> 乙自动跳回登录页
      await pageA.getByTestId('user-avatar-trigger').click();
      await pageA.getByRole('menuitem', { name: '用户与邀请' }).click();
      const rowB = pageA.locator('tr', { hasText: '管理员乙' });
      await rowB.getByRole('button', { name: '生成重置链接' }).click();
      await pageA.getByRole('button', { name: '确认生成' }).click();
      resetUrlAdmin2 = await pageA.getByTestId('one-time-link-input').inputValue();
      await pageA.getByRole('button', { name: '我已保存' }).click();

      await expect(pageB).toHaveURL(/\/login/, { timeout: 5_000 });

      await ctxA.close();
      await ctxB.close();
    });

    test('V8: 服务端日志中不含任何密码、会话令牌、邀请令牌或重置令牌', async () => {
      const { resetUrl, logPath } = readState();
      const logs = readFileSync(logPath, 'utf8');
      expect(logs.length).toBeGreaterThan(0);

      const secrets = [
        ADMIN_PW,
        USER_PW,
        ADMIN2_PW,
        resetUrl.split('/reset/')[1],
        inviteUrlSingle.split('/invite/')[1],
        inviteUrlAdmin2.split('/invite/')[1],
        resetUrlAdmin2.split('/reset/')[1],
        'nw_session=',
      ].filter((s): s is string => Boolean(s));

      for (const secret of secrets) {
        expect(logs, `日志不应包含敏感值`).not.toContain(secret);
      }
    });
  });

function pageText(page: import('@playwright/test').Page, text: string) {
  return page.getByText(text);
}
