import { displayNameSchema, loginNameSchema } from '@nw/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { deleteAllUserSessions } from './auth/session.js';
import { hashToken, newToken } from './auth/tokens.js';
import { type Config, ConfigError, loadConfig } from './config.js';
import { createDb, createPool, runMigrations, schema } from './db/index.js';

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

export async function runInit(
  databaseUrl: string,
  appOrigin: string,
  opts: { projectName: string; adminLoginName: string; displayName: string },
): Promise<{ resetUrl: string; projectId: string; userId: string }> {
  const projectName = opts.projectName.trim();
  if (!projectName) {
    throw new Error('项目名称不能为空');
  }
  const loginName = loginNameSchema.parse(opts.adminLoginName);
  const displayName = displayNameSchema.parse(opts.displayName);

  const pool = createPool(databaseUrl, 2);
  const db = createDb(pool);
  try {
    const token = newToken();
    const tokenHash = hashToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const out = await db.transaction(async (tx) => {
      const existing = await tx.select({ id: schema.projects.id }).from(schema.projects).limit(1);
      if (existing.length > 0) {
        throw new Error('数据库已初始化，拒绝重复执行 init');
      }

      const [project] = await tx
        .insert(schema.projects)
        .values({ name: projectName })
        .returning({ id: schema.projects.id });
      if (!project) throw new Error('创建项目失败');

      const [user] = await tx
        .insert(schema.users)
        .values({ loginName, displayName, passwordHash: null })
        .returning({ id: schema.users.id });
      if (!user) throw new Error('创建管理员失败');

      await tx.insert(schema.memberships).values({
        projectId: project.id,
        userId: user.id,
        role: 'admin',
      });

      await tx.insert(schema.passwordResets).values({
        userId: user.id,
        tokenHash,
        expiresAt,
        createdBy: null,
      });

      return { projectId: project.id, userId: user.id };
    });

    const origin = appOrigin.replace(/\/+$/, '');
    return { ...out, resetUrl: `${origin}/reset/${token}` };
  } finally {
    await pool.end();
  }
}

export async function runResetLink(
  databaseUrl: string,
  appOrigin: string,
  rawLoginName: string,
): Promise<{ resetUrl: string }> {
  const loginName = loginNameSchema.parse(rawLoginName);
  const pool = createPool(databaseUrl, 2);
  const db = createDb(pool);
  try {
    const token = newToken();
    const tokenHash = hashToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    await db.transaction(async (tx) => {
      const [user] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.loginName, loginName))
        .limit(1);

      if (!user) {
        throw new Error(`未找到用户：${loginName}`);
      }

      await tx
        .update(schema.passwordResets)
        .set({ usedAt: now })
        .where(
          and(eq(schema.passwordResets.userId, user.id), isNull(schema.passwordResets.usedAt)),
        );

      await tx
        .update(schema.users)
        .set({ passwordHash: null, updatedAt: now })
        .where(eq(schema.users.id, user.id));

      await deleteAllUserSessions(tx, user.id);

      await tx.insert(schema.passwordResets).values({
        userId: user.id,
        tokenHash,
        expiresAt,
        createdBy: null,
      });
    });

    const origin = appOrigin.replace(/\/+$/, '');
    return { resetUrl: `${origin}/reset/${token}` };
  } finally {
    await pool.end();
  }
}

async function main() {
  const [, , cmd, ...args] = process.argv;

  let config: Config;
  try {
    config = loadConfig({
      NODE_ENV: process.env.NODE_ENV ?? 'development',
      ...process.env,
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  if (cmd === 'migrate') {
    await runMigrations(config.databaseUrl);
    console.log('迁移完成');
    return;
  }

  if (cmd === 'init') {
    const projectName = parseFlag(args, '--project');
    const adminLoginName = parseFlag(args, '--admin');
    const displayName = parseFlag(args, '--display-name');
    if (!projectName || !adminLoginName || !displayName) {
      console.error('用法：cli init --project <名称> --admin <登录名> --display-name <显示名>');
      process.exit(1);
    }
    const { resetUrl } = await runInit(config.databaseUrl, config.appOrigin, {
      projectName,
      adminLoginName,
      displayName,
    });
    console.log(`初始化完成。请在 24 小时内打开以下链接设置管理员密码：\n${resetUrl}`);
    return;
  }

  if (cmd === 'reset-link') {
    const loginName = args[0];
    if (!loginName) {
      console.error('用法：cli reset-link <登录名>');
      process.exit(1);
    }
    const { resetUrl } = await runResetLink(config.databaseUrl, config.appOrigin, loginName);
    console.log(`重置链接（24 小时内有效）：\n${resetUrl}`);
    return;
  }

  console.error('未知命令。可用命令：migrate | init | reset-link');
  process.exit(1);
}

import { fileURLToPath } from 'node:url';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
