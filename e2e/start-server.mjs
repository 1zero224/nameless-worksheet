import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { LOCAL_ADMIN_URL, startLocalDb } from '../scripts/local-db.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.E2E_PORT ?? 3100);
const appOrigin = `http://127.0.0.1:${port}`;

let adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl) {
  startLocalDb();
  adminUrl = LOCAL_ADMIN_URL;
}

const dbName = `nw_e2e_${Date.now()}_${randomBytes(3).toString('hex')}`;
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${dbName}"`);
} finally {
  await admin.end();
}

const u = new URL(adminUrl);
u.pathname = `/${dbName}`;
const databaseUrl = u.toString();

const env = {
  ...process.env,
  NODE_ENV: 'test',
  PORT: String(port),
  HOST: '127.0.0.1',
  DATABASE_URL: databaseUrl,
  APP_ORIGIN: appOrigin,
  WEB_DIST_DIR: path.join(root, 'apps', 'web', 'dist'),
  LOG_LEVEL: 'info',
};

const cliPath = path.join(root, 'apps', 'server', 'dist', 'cli.js');
execFileSync(process.execPath, [cliPath, 'migrate'], { env, stdio: 'inherit' });

const initOut = execFileSync(
  process.execPath,
  [
    cliPath,
    'init',
    '--project',
    '无名字幕组',
    '--admin',
    'admin_e2e',
    '--display-name',
    '初始管理员',
  ],
  { env, encoding: 'utf8' },
);
const match = initOut.match(/http:\/\/127\.0\.0\.1:\d+\/reset\/[A-Za-z0-9_-]+/);
if (!match) {
  throw new Error(`未能从 init 输出中解析重置链接：${initOut}`);
}

const logPath = path.join(root, 'e2e', '.server.log');
writeFileSync(
  path.join(root, 'e2e', '.state.json'),
  JSON.stringify({ resetUrl: match[0], dbName, logPath }, null, 2),
);

const logStream = createWriteStream(logPath, { flags: 'w' });
const serverPath = path.join(root, 'apps', 'server', 'dist', 'main.js');
const child = spawn(process.execPath, [serverPath], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', (chunk) => {
  logStream.write(chunk);
});
child.stderr.on('data', (chunk) => {
  logStream.write(chunk);
  process.stderr.write(chunk);
});

async function cleanup() {
  if (!child.killed) child.kill('SIGTERM');
  logStream.end();
  try {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    await c.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await c.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await c.end();
  } catch {
    // ignore
  }
  process.exit(0);
}

process.on('SIGINT', () => void cleanup());
process.on('SIGTERM', () => void cleanup());
child.on('exit', (code) => {
  logStream.end();
  process.exit(code ?? 0);
});
