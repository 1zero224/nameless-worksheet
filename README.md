# 无名字幕组在线工作台

字幕组成员填写分工与进度、并把文件直接挂在任务上的在线工作表。

## 环境要求

- Node.js 24（见 `.nvmrc`）
- pnpm 12.15.0

本地开发与测试通过 `embedded-postgres` 自动启动 PostgreSQL 18，无需单独安装数据库或 Docker。

## 快速开始

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` 会启动本地 PostgreSQL 18、执行数据库迁移，并同时启动服务端（`:3000`）与 Vite 前端（`:5173`）。

首次初始化项目与管理员账号：

```bash
DATABASE_URL="postgres://postgres:postgres@localhost:54320/nameless_worksheet_dev" \
  pnpm --filter @nw/server run cli init \
  --project "无名字幕组" --admin admin --display-name "管理员"
```

在浏览器打开输出的重置链接即可为首个管理员设置密码。

## 常用命令

| 命令               | 说明                                   |
| ------------------ | -------------------------------------- |
| `pnpm dev`         | 启动本地数据库、服务端与前端开发服务器 |
| `pnpm check`       | Biome 检查 + 全部包类型检查            |
| `pnpm test`        | Vitest 单元测试与接口测试              |
| `pnpm build`       | 构建 `shared`、`server`、`web`         |
| `pnpm e2e`         | 构建并运行 Playwright 端到端测试       |
| `pnpm verify`      | 完整验证（`check` + `test` + `e2e`）   |
| `pnpm db:generate` | 由 Drizzle schema 生成迁移 SQL         |
| `pnpm db:migrate`  | 执行数据库迁移                         |

## 生产部署

详见 `docs/阶段1-开发文档.md` 第 11 节与 `deploy/` 目录：

```bash
./deploy/deploy.sh <镜像标签>
```
