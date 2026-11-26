# Teable 级 UI 重构：实验设计文档

状态：**已完成并合入 `main`**（`c6999a9`，随后经 `3ac1b55..530b09d` 进一步精修为单行 44px 顶栏、首页左侧可折叠「我的任务」竖栏、移除表内视图切换/工作表标签颜色/作品列及统一「空缺」举手认领；最新 UI 现状以 [feature-map.md](feature-map.md) 与《[产品设计文档](字幕组在线工作台-产品设计文档.md)》v1.12 为准；决策依据见 [ADR-0005](adr/0005-teable-grid-and-unified-attachment-slots.md)） · 日期：2026-11-26  
术语依据：[GLOSSARY.md](../GLOSSARY.md) · 功能契约：[feature-map.md](feature-map.md) · 前序文档：[多维表格化改版-实验设计文档.md](多维表格化改版-实验设计文档.md)

---

## 1. 背景与核心目标

前序实验（`3d33f0a`）用纯 DOM 表格 + 手写 Tailwind 样式做了布局收紧，但体感上仍与 **Teable / 飞书多维表格** 存在明显差距：
1. **视觉与控件质感不足**：缺乏成体系的极简中性灰阶、半透明细边框与微动效，看板卡片塞满彩虹胶囊显得杂乱；
2. **表格体验不及 Canvas 引擎**：选区、滚屏、列头、行号与分组大标题的手感不如 Teable 顺滑；
3. **侧边栏、视图标签页与看板结构不够直观**：工作表缺少像 Teable 一样的顶部视图标签切换，看板上长视频分段散落刷屏、未按作品大标题聚合。

同时，我们**坚决保留自研后端的独有核心能力**（原版 Teable 无法满足）：
- 阶段 3–4 的**同名文件自动版本堆叠**与 **10 GiB Cloudflare R2 分片断点续传 + 多网盘链接**；
- **作品大标题直接挂载整片共用附件**、**工序格内一键下载最新附件**；
- 首页跨多张工作表的**并行工序流转看板**（同一任务并行进行中时同时出现在多列）与原子抢认领；
- 轻量单进程 Node + PostgreSQL 架构（香港 VPS 轻松运行）。

---

## 2. 复用边界、许可与仓库规范

1. **合法抽离 Teable Canvas 表格核心（MIT 许可）**：
   - 仅从本地 `research/teable/packages/sdk/src/components/grid/`（91 个文件，隶属 `@teable/sdk`，**MIT 许可**）抽离并去耦至 `apps/web/src/vendor/teable-grid/`；
   - 保留原始 MIT `LICENSE` 与版权声明，**绝不引入任何 Teable 品牌资产（名称、Logo、专属图标）**；
   - 经人类负责人确认后，在 `AGENTS.md` 第 1 条补充说明“允许按 MIT 协议规范引入精简去耦的 `teable-grid` 至 `apps/web/src/vendor/teable-grid/`”，并在提交说明中显式注明对验证层文档的修改原因（遵循 `AGENTS.md` 第 5 条）。
2. **外围 UI 体系与动效（全 MIT、精确锁版本）**：
   - **视觉底座**：采用与 Teable `packages/ui-lib` 同源的正版 **`shadcn/ui` 中性极简 Design Token**（纯白画布 + 炭黑字 + 8% 透明黑细边框 + 4% 透明黑悬停底面），零拷贝 AGPL 代码；
   - **动效与反馈三件套**（`package.json` 一律写精确版本号，禁止 `^` / `~`）：
     - `tw-animate-css`（Tailwind v4 官方动效库，负责 Popover / Menu / Dialog / Drawer 淡入缩放与滑出）；
     - `motion`（原 Framer Motion，负责作品聚合卡平滑展开/收起、视图标签页切换滑块、看板列折叠过渡）；
     - `sonner`（Teable 同款 Toast 堆叠与撤销动效）。
3. **看板、侧边栏与视图标签栏**：
   - 不搬运 Teable `apps/nextjs-app/` 下强耦合 Next.js 与 `@teable/core` 的业务代码；而是 **1:1 对齐其视觉比例、边框阴影、列折叠交互与动画质感**，直接对接本项目现有的 REST API 与 WebSocket 实时事件，零后端/数据库迁移。

---

## 3. 视觉系统换血（对齐 Teable 极简质感）

涉及文件：`apps/web/src/index.css`、`apps/web/src/components/ui/colors.ts`、`apps/web/src/components/ui/primitives.tsx`、`apps/web/src/components/ui/overlays.tsx`。

### 3.1 核心 Design Token（告别发脏的 `slate` 与硬边框）

在 `apps/web/src/index.css` 定义语义化 CSS 变量并映射到 Tailwind v4 `@theme`：
- `--background`: `#ffffff`（主画布纯白）
- `--foreground`: `#09090b`（主文字炭黑，清晰利落）
- `--muted`: `#fafafa`（侧边栏/表头/看板列极浅灰底）
- `--muted-foreground`: `#71717a`（次要文案中性灰）
- `--border`: `rgba(0, 0, 0, 0.08)`（全站默认极细半透明边框，替代硬邦邦的 `border-slate-200`）
- `--border-strong`: `rgba(0, 0, 0, 0.14)`（悬停/焦点态边框）
- `--surface-hover`: `rgba(0, 0, 0, 0.04)`（按钮/行/导航项悬停底面）
- `--surface-active`: `rgba(0, 0, 0, 0.06)`（选中态柔和浅灰底，彻底取消刺眼的纯黑块 `bg-slate-900`）
- `--ring`: `#18181b` / `#2563eb`（焦点框克制收敛）

### 3.2 色彩克制原则（消灭“彩虹炸弹”）

- 全站主界面以**白 + 炭黑 + 中性浅灰**为主基调；
- 工作表色点只作 `6px` 精致圆点点缀，不再大面积渲染彩色圆角背景胶囊；
- 工序状态色使用低饱和、极柔和的浅底色（进行中淡蓝、已完成淡绿、不适用极浅灰），确保整张表一眼清晰、久看不累；
- 全局 Toast 替换为 `sonner`（右上/右下轻盈堆叠，保留软删除「撤销」按钮交互）。

---

## 4. Canvas 表格核心：`teable-grid` 抽离与业务定制

### 4.1 去耦清单（`apps/web/src/vendor/teable-grid/`）

从 `research/teable/packages/sdk/src/components/grid/` 抽离 91 个核心文件并剔除测试外无关依赖，需要剥离/替换的外部导入极少（已实查）：
1. `@teable/icons` → 替换为 `lucide-react` 或极简内联 SVG Sprite；
2. `@teable/ui-lib`（仅用了 `Input`、`Button`、`Tooltip`、`useUiDirection`）→ 替换为本项目 `components/ui` 基础件，方向固定 LTR；
3. `@teable/core`（仅用了 `getRandomString`、`SelectionRegionType` 等极少量工具/枚举）→ 内联到 `vendor/teable-grid/utils/compat.ts`；
4. `../../../context/app/i18n`（`useTranslation`）→ 替换为简体中文常量文案；
5. `tailwindcss/colors`（`gridTheme.ts`）→ 转为显式 Hex/RGBA 常量，彻底消除构建耦合；
6. 确认 `vendor/teable-grid/` 零 `@teable/*` 引用，并独立通过 `tsc --noEmit` 与 `biome check`（在 `biome.json` 中可对 `vendor/teable-grid/` 做必要 lint 豁免，避免无谓改写第三方内部风格）。

### 4.2 工作表数据映射与作品大标题分组

直接利用 `teable-grid` 原生内置的 **`LinearRowType.Group` + `groupCollection`** 与 **`collaborators`**：

1. **作品大标题分组横幅**：
   - 工作表中无作品的独立任务（`workId === null`）直接平铺，不套分组横幅；
   - 归属同一作品的任务（`workId !== null`）归入一个原生 `LinearRowType.Group` 分组头下方：
     - 分组头渲染：折叠/展开箭头 + 作品名称 + 完成进度（如 `已完成 2/5`）；
     - 在分组头右侧通过精准定位浮层或交互热区提供：**双击/按钮重命名**（复用 `PATCH /api/worksheets/:id/works/:workId`）、**`WorkAttachmentSlots` 作品级附件槽位**（阶段 3 挂整片原片/共用资料）、**`+ 添加分段`**（原地新增该作品下任务）；
   - 默认隐藏冗余的「作品」列（仍可在工具栏字段显隐中开启）。
2. **自定义工序格绘制器（`stageCellRenderer.ts`）**：
   - 在 Canvas 层直接绘制你想要的“一格走完一道工序”：
     - **整格柔和底色** + 左侧 2px 状态色条（`not_started` 纯白、`in_progress` `#EFF6FF` 浅蓝、`done` `#ECFDF5` 浅绿、`na` `#F4F4F5` 浅灰）；
     - 左侧绘制负责人名字（单人或 `小林 +2`）；
     - 右侧绘制备注微图标 + **最新附件快捷角标槽位**（阶段 3 接入后显示如 `⬇ v2` / `🔗 盘`，并注册独立点击热区：点击角标直接下载最新附件或打开网盘、不弹编辑浮层）；
   - 点击工序格其他区域：在格子锚点位置弹出我们现有的 Radix `StageCellEditor` Popover（改负责人、切状态、填备注、并发冲突保护，底部预留阶段 3 本工序附件上传与版本历史区）。
3. **文本/作品/优先级/发布信息格编辑与中文 IME 保护**：
   - 文本格采用 DOM 覆盖层 `InlineTextCell`（严格保持 `compositionstart/end` 中文输入法防打断、远端更新不覆盖编辑草稿、`cell-conflict-bar` 并发冲突浮条）；
   - 其他结构化格点击锚定弹出对应的轻量 Radix Popover；
   - `collaborators` 属性直接绑定 WebSocket `PresencePeer[]`，他人选中或编辑的格子实时在 Canvas 上渲染带颜色边框与名字浮标。
4. **顶部已发布折叠区 & 底部 `+ 新建任务`**：
   - 表格上方保留 30px 极简「已发布（N 条）」折叠条；
   - 利用 `teable-grid` 原生 `onRowAppend`（表底 `+` 追加行）实现无缝原地新建任务，顶栏提供 `+ 新建作品` 入口。
5. **窄屏（`390×844`）兜底**：
   - 保留 `TouchLayer` 触控滑动；在手机视口下点击任意任务行或展开图标可直接打开全屏 `TaskDetailDrawer` 进行流畅编辑，保证 `document.documentElement.scrollWidth <= window.innerWidth`。

---

## 5. Teable 风格侧边栏与顶部视图标签栏

涉及文件：`apps/web/src/app/AppShell.tsx`、`apps/web/src/pages/WorksheetDetailPage.tsx`。

### 5.1 极简左侧栏（对标 Teable Sidebar）

- 宽度 `216px`（可一键折叠），底色 `--muted`（`#FAFAFA`），右侧 `1px solid var(--border)`；
- 顶部项目标识 + 折叠按钮；
- 导航项改用精致 Lucide 细线图标（`15px`、`strokeWidth={1.75}`），选中态为柔和圆角浅灰条（`bg-black/[0.06] text-foreground font-medium`），不再使用厚重黑底；
- 主区为「工作表」列表：标题右侧直接 `+` 新建工作表，单项悬停显示拖拽手柄与 `⋯` 菜单（重命名/改色/删除），实时同步无闪烁；
- 「个人设置」与管理员入口收拢在左下角紧凑折叠区。

### 5.2 工作表顶部「视图标签栏（View Tabs）」

打开任意工作表（`/worksheets/:id`）后，顶部采用 Teable 标志性的两层极简头部：

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ ● 长视频全熟    [ ⊞ 表格视图 ]  [ ◫ 看板视图 ]        [在线: 小林] [修改记录] │ ← 44px 视图标签栏
├────────────────────────────────────────────────────────────────────────────┤
│ [+ 新建作品]  [字段▾]  [筛选: 全部|我的|进行中▾]  [排序▾]  [搜关键词]        │ ← 36px 图标工具栏
├────────────────────────────────────────────────────────────────────────────┤
│ ▸ 已发布（4 条）                                                           │ ← 30px 紧凑折叠条
├────────────────────────────────────────────────────────────────────────────┤
│                       Teable Canvas Grid / 单表看板                        │ ← 占满剩余 100vh
└────────────────────────────────────────────────────────────────────────────┘
```

- **视图标签页切换**（带 `motion` `layoutId` 底部指示线平滑滑移）：
  - **`表格视图`**（默认）：Teable Canvas Grid；
  - **`看板视图`**（本表专属看板）：按当前工作表映射到看板列的工序列，以作品大标题聚合卡形态展示本表任务流转，无需离开当前工作表即可在表与看板间瞬切！

---

## 6. 看板视图重构：Teable 极简质感 + 作品大标题聚合 + 丝滑动效

涉及文件：`apps/web/src/pages/HomePage.tsx`、拆出可复用的 `apps/web/src/components/board/KanbanBoard.tsx`（同时服务首页跨表总看板与工作表内「看板视图」）。

### 6.1 视觉 1:1 对齐 Teable 看板

- **列容器**：宽 `296px`，柔和浅灰底（`bg-muted/80`）、`1px solid var(--border)` 圆角容器、独立纵向滚动；
- **列头支持一键竖向折叠**（复刻 Teable `KanbanStackContainer` 经典交互）：点击列头折叠按钮，整列以平滑宽度过渡收起为 **`48px` 宽的精致竖条**（旋转显示列名 + 数量），给其他繁忙列腾出屏幕宽度；
- **卡片样式**：纯白底（`bg-white`）、`1px solid var(--border)`、`rounded-lg`、极轻阴影（`shadow-[0_1px_2px_rgba(0,0,0,0.04)]`），悬停边框微加深，零多余彩虹标签。

### 6.2 核心治乱设计：列内按「作品大标题」聚合可折叠卡

每一列内，卡片分为两种形态，彻底消除长视频分段刷屏：

1. **独立任务卡（无作品，`workId === null`）—— 极简 3 层**：
   ```text
   ┌────────────────────────────────────┐
   │ ● 刺刺广播2025-2026                │ ← 极淡来源小字（11px neutral）
   │ 刺刺广播 #15                       │ ← 清晰标题（13px font-medium）
   │ 小林 · 进行中         [+ 缺 校对]  │ ← 底部紧凑状态与单行操作
   └────────────────────────────────────┘
   ```
   *(去掉旧版底部重复的迷你工序小圆点与多层高饱和色块；需要看全工序或附件时，点击卡片平滑滑出右侧 `TaskDetailDrawer`。)*

2. **作品聚合卡（同列内归属同一 `workId` 的多条任务合并为 1 张卡）**：
   ```text
   ┌────────────────────────────────────┐
   │ ● 长视频全熟               4 段 ▾  │ ← 顶部来源 + 分段数 + 展开箭头
   │ 无刺有刺2nd专场演唱会 (2024.09.22)  │ ← 作品大标题（13px font-semibold）
   │ ██████░░░░  进行中 2 · 缺人 2      │ ← 细进度条 + 精炼状态摘要
   ├────────────────────────────────────┤ ← motion 平滑展开/收起内部各分段：
   │ 0-36:37          小林 · 进行中     │
   │ 36:37-01:00:33   未开始   [+ 认领] │
   │ 01:00:33-1:17    未开始   [+ 认领] │
   └────────────────────────────────────┘
   ```
   - 默认折叠，一屏可轻松总览所有进行中的作品与独立任务；
   - 展开后每条分段占 1 行紧凑列表，可直接点击 `[+ 认领]` 原子抢认领、点击分段打开详情侧栏、以及（阶段 3）点击行尾 `[⬇]` 直接下载本工序最新附件；
   - 完整保留你们的**跨表并行工序流转规则**：同一作品若同时有分段在「时轴」和「翻译」进行中，两列都会聚合显示该作品在各自列中的分段，互不干扰。

### 6.3 动效规范

- **作品聚合卡展开/收起**：使用 `motion` 的 `AnimatePresence` + 高度/透明度平滑过渡（`duration: 0.18, ease: [0.2, 0, 0, 1]`）；
- **视图标签栏切换**：`motion` 共享 `layoutId` 下划线平滑滑移；
- **看板列折叠/展开**：宽幅平滑过渡；
- **浮层与抽屉**：`tw-animate-css` 负责 Radix Popover / DropdownMenu / Dialog / Sheet 柔和进出场；
- **提示反馈**：`sonner` 堆叠 Toast，所有动画尊重 `prefers-reduced-motion`。

---

## 7. 分步实施计划（建议在 `exp/multitable-ui` 按序推进）

| 步骤 | 内容 | 核心产出与验证点 |
|---|---|---|
| **S0** | 依赖准备 | `AGENTS.md` 例外条款与 [ADR-0005](adr/0005-teable-grid-and-unified-attachment-slots.md) 已就位；在 `apps/web/package.json` 精确锁版本安装 `tw-animate-css`、`motion`、`sonner`（以及 `teable-grid` 所需的轻量依赖如 `lodash` 若尚未安装） |
| **S1** | 抽离去耦 `teable-grid` | 将 `research/teable/packages/sdk/src/components/grid/` 精简去耦到 `apps/web/src/vendor/teable-grid/`（附原始 MIT `LICENSE`），零 `@teable/*` 引用，`pnpm check` 通过 |
| **S2** | 全局视觉 Token + Teable 风格侧边栏 + `sonner` | 重写 `index.css` 语义变量与 `colors.ts` 低饱和配色，重构 `AppShell.tsx` 极简侧边栏，接入 `sonner` 与 `tw-animate-css` |
| **S3** | 用 `teable-grid` 接管工作表 + 作品分组 + 工序格绘制器 + 视图标签栏 | 实现 `stageCellRenderer.ts`、`LinearRowType.Group` 作品大标题横幅（含作品级附件槽位与 `+ 添加分段`）、`collaborators` 在线焦点、DOM 编辑浮层（含中文 IME 与冲突浮条）、顶部 `表格视图 / 看板视图` 标签栏 |
| **S4** | 重构看板为 Teable 风格作品聚合看板 | 抽离公共 `KanbanBoard.tsx`（列竖向折叠 + 列内作品大标题聚合卡 + `motion` 动画 + 极简去噪），同时驱动首页总看板与工作表内「看板视图」 |
| **S5** | E2E 同步适配、真浏览器冒烟与部署 | 保留关键测试契约并适配 Canvas Grid / 聚合看板定位（不删减核心验收断言），跑通 `pnpm verify` + `pnpm verify:guard` + 桌面 `1440×900` 与手机 `390×844` 真浏览器检查，构建并部署到香港 VPS |

---

## 8. 风险与验收红线

1. **Canvas 表格下的 E2E 定位与可访问性**：Canvas 内部单元格不是普通 DOM 节点，需确保通过稳定交互入口（点击坐标/快捷键/测试辅助钩子或可访问隐藏层/编辑态 DOM `data-testid`）保证阶段 2 全部核心验收（中文 IME、并发冲突条、在线状态、双端实时同步、作品分组与新增）继续 100% 自动化覆盖，不删减任何验收场景。
2. **中文输入法（IME）实测**：在 `teable-grid` 的 DOM 文本编辑浮层中实测拼音组字期间按 `Enter` 不提前提交、远端事件到达不覆写草稿。
3. **手机窄屏 `390×844`**：确认零横向溢出、看板列可流畅横滑、点击任务行可顺畅进入全屏 `TaskDetailDrawer` 完成编辑。
4. **验证层透明声明**：本次若更新 `AGENTS.md`（仅放行 MIT `teable-grid` 引入说明），须在提交信息中显式注明原因，不改动任何测试防篡改规则或放宽校验。
