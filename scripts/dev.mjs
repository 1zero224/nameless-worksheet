// 启动本地开发：确保本地 PostgreSQL 18 运行，创建开发库并迁移，然后并行启动 server 和 web。
import { spawn } from 'node:child_process';
import pg from 'pg';
import { LOCAL_ADMIN_URL, LOCAL_DB, startLocalDb } from './local-db.mjs';

const DEV_DB = 'nameless_worksheet_dev';
const DEV_DATABASE_URL = `postgres://${LOCAL_DB.user}:${LOCAL_DB.password}@localhost:${LOCAL_DB.port}/${DEV_DB}`;

startLocalDb();

const admin = new pg.Client({ connectionString: LOCAL_ADMIN_URL });
await admin.connect();
try {
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DEV_DB]);
  if (exists.rowCount === 0) {
    await admin.query(`CREATE DATABASE "${DEV_DB}"`);
  }
} finally {
  await admin.end();
}

const env = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: process.env.PORT ?? '3000',
  DATABASE_URL: process.env.DATABASE_URL ?? DEV_DATABASE_URL,
  APP_ORIGIN: process.env.APP_ORIGIN ?? 'http://localhost:5173',
};

const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

await new Promise((resolve, reject) => {
  const migrate = spawn(pnpmCmd, ['--filter', '@nw/server', 'run', 'db:migrate'], {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  });
  migrate.on('exit', (code) =>
    code === 0 ? resolve() : reject(new Error(`db:migrate exited with code ${code}`)),
  );
});

const children = [
  spawn(pnpmCmd, ['--filter', '@nw/server', 'run', 'dev'], {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  }),
  spawn(pnpmCmd, ['--filter', '@nw/web', 'run', 'dev'], {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  }),
];

function shutdown() {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
