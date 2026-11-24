// 本地开发与测试用的 PostgreSQL 18。
// 二进制来自 embedded-postgres 的平台包；用 initdb / pg_ctl 管理进程，
// 因为 Windows 管理员账号下只有 pg_ctl 会自动降权启动 postgres。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL_DB = {
  dataDir: path.join(root, '.pgdata'),
  port: Number(process.env.LOCAL_DB_PORT ?? 54320),
  user: 'postgres',
  password: 'postgres',
};
export const LOCAL_ADMIN_URL = `postgres://${LOCAL_DB.user}:${LOCAL_DB.password}@localhost:${LOCAL_DB.port}/postgres`;

function binDir() {
  const require = createRequire(import.meta.url);
  const pkg = `@embedded-postgres/${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  const epDir = path.resolve(path.dirname(require.resolve('embedded-postgres')), '..');
  // pnpm 把平台包放在 embedded-postgres 的同级目录
  return path.join(epDir, '..', pkg, 'native', 'bin');
}

function run(exe, args, opts = {}) {
  const file = path.join(binDir(), process.platform === 'win32' ? `${exe}.exe` : exe);
  const r = spawnSync(file, args, { encoding: 'utf8', ...opts });
  return r;
}

export function isRunning() {
  if (!existsSync(path.join(LOCAL_DB.dataDir, 'PG_VERSION'))) return false;
  return run('pg_ctl', ['-D', LOCAL_DB.dataDir, 'status']).status === 0;
}

export function startLocalDb() {
  if (!existsSync(path.join(LOCAL_DB.dataDir, 'PG_VERSION'))) {
    mkdirSync(LOCAL_DB.dataDir, { recursive: true });
    const pw = path.join(root, '.pgdata.pw');
    writeFileSync(pw, LOCAL_DB.password);
    const r = run('initdb', [
      '-D',
      LOCAL_DB.dataDir,
      '-U',
      LOCAL_DB.user,
      `--pwfile=${pw}`,
      '-A',
      'scram-sha-256',
      '-E',
      'UTF8',
      '--locale=C',
    ]);
    rmSync(pw, { force: true });
    if (r.status !== 0) throw new Error(`initdb 失败：${r.stderr || r.stdout}`);
  }
  if (isRunning()) return;
  const r = run(
    'pg_ctl',
    [
      '-D',
      LOCAL_DB.dataDir,
      '-l',
      path.join(LOCAL_DB.dataDir, 'server.log'),
      '-w',
      '-o',
      `-p ${LOCAL_DB.port} -c max_connections=300 -c fsync=off`,
      'start',
    ],
    { stdio: 'ignore' },
  ); // postgres 会继承管道句柄，用管道会让 spawnSync 一直等下去
  if (r.status !== 0) throw new Error('pg_ctl start 失败，见 .pgdata/server.log');
}

export function stopLocalDb() {
  if (!isRunning()) return;
  run('pg_ctl', ['-D', LOCAL_DB.dataDir, '-w', '-m', 'fast', 'stop'], { stdio: 'inherit' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === 'start') {
    startLocalDb();
    console.log(`本地数据库已启动：${LOCAL_ADMIN_URL}`);
  } else if (cmd === 'stop') {
    stopLocalDb();
    console.log('本地数据库已停止');
  } else if (cmd === 'status') {
    console.log(isRunning() ? 'running' : 'stopped');
  } else {
    console.error('用法：node scripts/local-db.mjs start|stop|status');
    process.exit(1);
  }
}
