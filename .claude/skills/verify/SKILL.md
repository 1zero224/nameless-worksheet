---
name: verify
description: 在 nameless-worksheet 中执行分层验证、真跑本地应用端到端冒烟与浏览器检查。提交代码、完成阶段任务或改动 UI/协同/安全逻辑前使用。
---

# Verify Skill — 无名字幕组在线工作台

在宣称任何任务完成前，按本技能执行**真跑应用 + 客观证据验证**。严禁只凭静态阅读或“应该没问题”宣称通过。

## 1. 先跑廉价检查（默认路径）

```bash
pnpm verify:fast
pnpm verify:guard
```

- `pnpm verify:fast` 执行 `biome check .` + 全工作区 `typecheck` + `vitest run`（含共享属性测试、服务端真实 PostgreSQL 集成测试、WebSocket 测试、前端单测）。
- `pnpm verify:guard` 扫描测试反模式（`waitForTimeout`、`.skip`、`.fixme`）并在 PR/分支对比时提示是否触及验证层文件。

## 2. 端到端与真机冒烟

### 2.1 自动化 Playwright E2E

- 仅修改前端页面或 E2E 用例、且 `dist` 已构建时，先跑单条用例快速反馈：
  ```bash
  pnpm e2e:run e2e/phase2.spec.ts
  ```
- 改动了 `packages/shared` 或 `apps/server`，或准备交付/提交完整阶段时，跑全量构建 + E2E：
  ```bash
  pnpm e2e
  ```
- 完整退出门禁（推荐在 PR/里程碑前执行）：
  ```bash
  pnpm verify
  ```

### 2.2 交互式浏览器目视检查（涉及页面布局/协同/IME/手机端时）

1. 按 [docs/feature-map.md](../../../docs/feature-map.md) 确认本次改动涉及的路由、交互路径与验收判据。
2. 启动独立本地服务：
   - 方式 A（快速复用 E2E 隔离库，自动初始化管理员，不污染开发库）：`pnpm build && node e2e/start-server.mjs`，从 `e2e/.state.json` 读取 `resetUrl`，访问 `http://127.0.0.1:3100`。
   - 方式 B（开发热更新）：`pnpm dev`，访问 `http://localhost:5173`。
3. 核对关键视觉与行为证据：
   - 浏览器 Console 无未捕获异常与 React hydration/key 警告；Network 无意外 4xx/5xx；
   - 桌面视口（1280×800）与手机窄屏（390×844）均无整体横向溢出（`document.documentElement.scrollWidth <= window.innerWidth`）；
   - 多人协同改动须用两个独立浏览器上下文验证实时同步、在线焦点与冲突提示。

## 3. Diff 触发自查

执行 `git diff --name-only` 对照 [REVIEW.md](../../../REVIEW.md) 第 2 节：
- 仅核对命中当前 diff 的检查项（通常 2–6 条）；
- 如有 `Important` 级缺口，立即修复并重跑受影响的验证。

## 4. 失败处理红线

- 同一组失败最多自主修复 **3 轮**；第 3 轮仍未通过时立即停手，附上报错日志与 `test-results/` 中的 trace/截图路径上报人类。
- 严禁加 `waitForTimeout`、`.skip` 或删断言凑通过。
- 验证通过后，在汇报与提交信息中写明客观证据及验证戳（例如 `Verified: pnpm verify` 或 `Verified: verify:fast`）。
