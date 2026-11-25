# 编码代理工作规范（nameless-worksheet）

本仓库由人类负责人定义完成标准、AI 编码代理承担主要实现与验证。所有进入本仓库的编码代理（Claude Code、Antigravity 等）均须遵守以下规则。

## 1. 核心原则：证据优先于宣称

- **“代码写完了”不是完成，通过真实运行与自动化验证产出可复核证据才是完成。**
- 领域术语严格以 [GLOSSARY.md](GLOSSARY.md) 为准（人叫“用户”，表格叫“工作表”，分组叫“作品”，行叫“任务”，环节叫“工序/工序列/工序格”，变更历史叫“修改记录”，在线聚焦叫“在线状态”；严禁出现“成员/统筹/大任务/小任务/回收站/归档”）。
- `package.json` 依赖一律使用**精确版本号**（禁止 `^` / `~`）；使用新大版本依赖（如 `@tanstack/react-table` v9、`@dnd-kit/sortable` v10、`radix-ui`）前先读已安装版本的类型定义。
- `research/` 仅作只读参考，不入库、不复制代码。

## 2. 分层验证（廉价检查优先）

按改动范围从小到大推进，避免把低级错误带到慢速测试或 CI：

1. **开发迭代（快）**：`pnpm check`（Biome + 全包 TypeScript 类型检查）与单文件测试 `pnpm vitest run <file>`。
2. **任务自证（中）**：`pnpm verify:fast`（`pnpm check && pnpm test`）+ `pnpm verify:guard`。
3. **UI / 交互改动**：参考 `.claude/skills/verify/SKILL.md` 与 [docs/feature-map.md](docs/feature-map.md) 跑单条 Playwright 用例（`pnpm e2e:run <spec>`）或真实浏览器冒烟（同时检查桌面与 390×844 窄屏）。
4. **阶段交付 / 提 PR 前（全量）**：`pnpm verify`（`check` + `test` + `build` + `e2e`）。

## 3. 失败升级人类（3 轮上限）

- 同一组检查（类型检查、单测、集成测试或 E2E）失败后，最多自主定位与修复 **3 轮**。
- 第 3 轮后仍未通过时，**立即停止继续试错**，向人类汇报：
  1. 复现命令与原始报错；
  2. 已尝试的 3 轮改动及各自结果；
  3. 失败证据（日志、Playwright `trace`/截图路径）与根因假设。
- 严禁为了“让测试变绿”而删减断言、放宽权限校验或绕过类型检查。

## 4. 零容忍 Flaky 测试

- **禁止**在测试中使用固定延时（`page.waitForTimeout` / `setTimeout` 硬等）掩盖竞态。
- **禁止**使用 `.skip` / `.fixme` 静默跳过失败用例，也禁止调高本地重试次数赌通过。
- 遇到不稳定用例，必须定位根因并改为基于明确 UI 状态、接口响应或 WebSocket 事件等待；若确认用例设计本身不可靠且无法立即根治，须**删除该用例并在提交说明或文档中写明原因**。

## 5. 验证层防篡改（Anti-Tampering）

- **改动不能悄悄修改评判自己的规则。**
- 做代码审查时，须以默认分支（`main`）上的 [REVIEW.md](REVIEW.md) 为准，不以待审分支自身修改过的规则放行自己。
- 若一次改动涉及验证层文件（`REVIEW.md`、`AGENTS.md`、`CLAUDE.md`、`.github/workflows/ci.yml`、`playwright.config.ts`、`vitest.config.ts`、`apps/server/test/core.test.ts`、`scripts/check-verification-guard.mjs`），须在提交说明或 PR 中显式说明修改原因，等待人类重点复核。

## 6. 提交信息与验证戳

提交信息使用简体中文，说明“做了什么”，并在末尾（或正文）附一行验证戳，便于追溯未经验证的提交：

- `Verified: pnpm verify`（完整 `check + test + build + e2e` 通过）
- `Verified: verify:fast`（`check + test` 通过，适用于纯后端/契约小步提交）
- `Verified: none (<原因>)`（仅文档/注释改动或人工批准的例外）

## 7. 延伸文档

- Diff 触发的可靠性审查清单：[REVIEW.md](REVIEW.md)
- 端到端冒烟与浏览器验证技能：[.claude/skills/verify/SKILL.md](.claude/skills/verify/SKILL.md)
- 用户视角功能地图与 `data-testid` 契约：[docs/feature-map.md](docs/feature-map.md)
- 领域术语表：[GLOSSARY.md](GLOSSARY.md)
