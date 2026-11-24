import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** 既可以是连接池上的数据库，也可以是事务 */
export type Queryable = Db | Tx;

export function createPool(databaseUrl: string, max = 10): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // 空闲连接出错（如数据库重启）不应让进程崩溃
  pool.on('error', () => {});
  return pool;
}

export function createDb(pool: pg.Pool): Db {
  return drizzle({ client: pool, schema });
}

/** 迁移 SQL 所在目录：源码与构建产物都在 apps/server 下的 drizzle/ */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'drizzle',
);

export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl, 1);
  try {
    await migrate(createDb(pool), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await pool.end();
  }
}

export { schema };
