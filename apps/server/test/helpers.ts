import { randomBytes } from 'node:crypto';
import { DEFAULT_BOARD_COLUMN_NAMES, generateNKeysBetween, type ServerMessage } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { createSession, SESSION_COOKIE } from '../src/auth/session.js';
import { type Config, loadConfig } from '../src/config.js';
import { type Db, runMigrations, schema } from '../src/db/index.js';

export const TEST_ORIGIN = 'http://localhost:5173';

export interface TestEnv {
  dbName: string;
  databaseUrl: string;
  config: Config;
  app: FastifyInstance;
  cleanup: () => Promise<void>;
}

function adminUrl(): string {
  const url = process.env.TEST_DATABASE_ADMIN_URL;
  if (!url) throw new Error('TEST_DATABASE_ADMIN_URL not set');
  return url;
}

export function makeDbUrl(dbName: string): string {
  const u = new URL(adminUrl());
  u.pathname = `/${dbName}`;
  return u.toString();
}

export async function createIsolatedDatabase(): Promise<{
  dbName: string;
  databaseUrl: string;
  drop: () => Promise<void>;
}> {
  const dbName = `nw_test_${Date.now()}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  const databaseUrl = makeDbUrl(dbName);
  await runMigrations(databaseUrl);

  return {
    dbName,
    databaseUrl,
    drop: async () => {
      const c = new pg.Client({ connectionString: adminUrl() });
      await c.connect();
      try {
        await c.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [dbName],
        );
        await c.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      } finally {
        await c.end();
      }
    },
  };
}

export async function createTestEnv(opts?: {
  enableRateLimit?: boolean;
  realtimeReplayLimit?: number;
  heartbeatIntervalMs?: number;
  r2MultipartThresholdBytes?: number;
  r2PartSizeBytes?: number;
  r2MaxFileBytes?: number;
  uploadCleanupGraceHours?: number;
  uploadSessionTtlHours?: number;
  logger?: boolean;
}): Promise<TestEnv> {
  const { dbName, databaseUrl, drop } = await createIsolatedDatabase();
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    APP_ORIGIN: TEST_ORIGIN,
    REALTIME_REPLAY_LIMIT: String(opts?.realtimeReplayLimit ?? 500),
    LOG_LEVEL: 'silent',
    ...(opts?.r2MultipartThresholdBytes !== undefined
      ? { R2_MULTIPART_THRESHOLD_BYTES: String(opts.r2MultipartThresholdBytes) }
      : {}),
    ...(opts?.r2PartSizeBytes !== undefined
      ? { R2_PART_SIZE_BYTES: String(opts.r2PartSizeBytes) }
      : {}),
    ...(opts?.r2MaxFileBytes !== undefined
      ? { R2_MAX_FILE_BYTES: String(opts.r2MaxFileBytes) }
      : {}),
    ...(opts?.uploadCleanupGraceHours !== undefined
      ? { UPLOAD_CLEANUP_GRACE_HOURS: String(opts.uploadCleanupGraceHours) }
      : {}),
    ...(opts?.uploadSessionTtlHours !== undefined
      ? { UPLOAD_SESSION_TTL_HOURS: String(opts.uploadSessionTtlHours) }
      : {}),
  });

  const app = await buildApp({
    config,
    enableJobs: false,
    enableRateLimit: opts?.enableRateLimit ?? false,
    heartbeatIntervalMs: opts?.heartbeatIntervalMs,
    logger: opts?.logger ?? false,
  });

  return {
    dbName,
    databaseUrl,
    config,
    app,
    cleanup: async () => {
      await app.close();
      await drop();
    },
  };
}

export interface SeededUser {
  id: string;
  loginName: string;
  displayName: string;
  password: string;
  role: 'admin' | 'user';
  sessionId: string;
  cookie: string;
}

export interface SeededProject {
  id: string;
  name: string;
  admin: SeededUser;
  user: SeededUser;
  boardColumns: Array<{ id: string; name: string; sortOrder: string }>;
}

async function seedProject(db: Db, suffix: string): Promise<SeededProject> {
  const [project] = await db
    .insert(schema.projects)
    .values({ name: `测试项目_${suffix}` })
    .returning();
  if (!project) throw new Error('seed project failed');

  const adminPw = `AdminPass_${suffix}_123`;
  const userPw = `UserPass_${suffix}_123`;
  const [adminHash, userHash] = await Promise.all([hashPassword(adminPw), hashPassword(userPw)]);

  const now = new Date();
  const [adminRow] = await db
    .insert(schema.users)
    .values({
      loginName: `admin_${suffix}`,
      displayName: `管理员_${suffix}`,
      passwordHash: adminHash,
      claimedAt: now,
    })
    .returning();
  const [userRow] = await db
    .insert(schema.users)
    .values({
      loginName: `user_${suffix}`,
      displayName: `普通用户_${suffix}`,
      passwordHash: userHash,
      claimedAt: now,
    })
    .returning();

  if (!adminRow || !userRow || !adminRow.loginName || !userRow.loginName) {
    throw new Error('seed users failed');
  }

  await db.insert(schema.memberships).values([
    { projectId: project.id, userId: adminRow.id, role: 'admin' },
    { projectId: project.id, userId: userRow.id, role: 'user' },
  ]);

  const boardKeys = generateNKeysBetween(null, null, DEFAULT_BOARD_COLUMN_NAMES.length);
  const seededBoardColumns = await db
    .insert(schema.boardColumns)
    .values(
      DEFAULT_BOARD_COLUMN_NAMES.map((name, i) => ({
        projectId: project.id,
        name,
        sortOrder: boardKeys[i] ?? `a${i}`,
      })),
    )
    .returning({
      id: schema.boardColumns.id,
      name: schema.boardColumns.name,
      sortOrder: schema.boardColumns.sortOrder,
    });

  const adminSess = await createSession(db, adminRow.id, 'test-agent', 30);
  const userSess = await createSession(db, userRow.id, 'test-agent', 30);

  return {
    id: project.id,
    name: project.name,
    boardColumns: seededBoardColumns,
    admin: {
      id: adminRow.id,
      loginName: adminRow.loginName,
      displayName: adminRow.displayName,
      password: adminPw,
      role: 'admin',
      sessionId: adminSess.sessionId,
      cookie: `${SESSION_COOKIE}=${adminSess.token}`,
    },
    user: {
      id: userRow.id,
      loginName: userRow.loginName,
      displayName: userRow.displayName,
      password: userPw,
      role: 'user',
      sessionId: userSess.sessionId,
      cookie: `${SESSION_COOKIE}=${userSess.token}`,
    },
  };
}

/** 第 7.3 节规定的双项目夹具 */
export async function createTwoProjects(
  db: Db,
): Promise<{ projectA: SeededProject; projectB: SeededProject }> {
  const tag = randomBytes(3).toString('hex');
  const projectA = await seedProject(db, `a_${tag}`);
  const projectB = await seedProject(db, `b_${tag}`);
  return { projectA, projectB };
}

export function extractSessionCookie(
  setCookieHeader: string | string[] | undefined,
): string | null {
  if (!setCookieHeader) return null;
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const raw of list) {
    if (raw.startsWith(`${SESSION_COOKIE}=`)) {
      return raw.split(';')[0] ?? null;
    }
  }
  return null;
}

export interface WsTestClient {
  ws: WebSocket;
  messages: ServerMessage[];
  nextMessage: (
    predicate?: (m: ServerMessage) => boolean,
    timeoutMs?: number,
  ) => Promise<ServerMessage>;
  send: (msg: unknown) => void;
  waitClose: (timeoutMs?: number) => Promise<{ code: number; reason: string }>;
  close: () => void;
}

export async function connectWs(
  port: number,
  opts: { cookie?: string; origin?: string } = {},
): Promise<WsTestClient> {
  const headers: Record<string, string> = {};
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.cookie) headers.cookie = opts.cookie;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/realtime`, { headers });
  const messages: ServerMessage[] = [];
  const waiters: Array<{
    predicate: (m: ServerMessage) => boolean;
    resolve: (m: ServerMessage) => void;
  }> = [];

  ws.on('message', (data) => {
    const parsed = JSON.parse(data.toString('utf8')) as ServerMessage;
    const idx = waiters.findIndex((w) => w.predicate(parsed));
    if (idx !== -1) {
      const [w] = waiters.splice(idx, 1);
      w?.resolve(parsed);
    } else {
      messages.push(parsed);
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`HTTP_${res.statusCode}`));
    });
  });

  return {
    ws,
    messages,
    nextMessage(predicate = () => true, timeoutMs = 5_000) {
      const idx = messages.findIndex(predicate);
      if (idx !== -1) {
        const [m] = messages.splice(idx, 1);
        return Promise.resolve(m!);
      }
      return new Promise<ServerMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.resolve === wrappedResolve);
          if (i !== -1) waiters.splice(i, 1);
          reject(new Error('Timeout waiting for WS message'));
        }, timeoutMs);
        const wrappedResolve = (m: ServerMessage) => {
          clearTimeout(timer);
          resolve(m);
        };
        waiters.push({ predicate, resolve: wrappedResolve });
      });
    },
    send(msg: unknown) {
      ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    },
    waitClose(timeoutMs = 5_000) {
      if (ws.readyState === WebSocket.CLOSED) {
        return Promise.resolve({ code: 1000, reason: '' });
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timeout waiting for WS close')),
          timeoutMs,
        );
        ws.once('close', (code, reason) => {
          clearTimeout(timer);
          resolve({ code, reason: reason.toString('utf8') });
        });
      });
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    },
  };
}
