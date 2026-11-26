import { and, eq, gt, isNotNull, ne } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import type { Config } from '../config.js';
import { type Db, type Queryable, schema } from '../db/index.js';
import { hashToken, newToken } from './tokens.js';

export const SESSION_COOKIE = 'nw_session';
const SLIDING_RENEWAL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function setSessionCookie(reply: FastifyReply, token: string, config: Config): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: config.secureCookies,
    maxAge: config.sessionTtlDays * 86400,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: config.secureCookies,
  });
}

export function truncateUserAgent(ua: string | undefined): string | null {
  if (!ua) return null;
  return ua.slice(0, 200);
}

export async function createSession(
  q: Queryable,
  userId: string,
  userAgent: string | undefined,
  ttlDays: number,
): Promise<{ sessionId: string; token: string; expiresAt: Date }> {
  const token = newToken();
  const tokenHash = hashToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * DAY_MS);

  const [row] = await q
    .insert(schema.sessions)
    .values({
      tokenHash,
      userId,
      userAgent: truncateUserAgent(userAgent),
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
    })
    .returning({ id: schema.sessions.id });

  if (!row) {
    throw new Error('Failed to insert session');
  }

  return { sessionId: row.id, token, expiresAt };
}

export interface SessionLookup {
  sessionId: string;
  userId: string;
  projectId: string;
  role: 'admin' | 'user';
  loginName: string;
  displayName: string;
  projectName: string;
  lastSeenAt: Date;
  expiresAt: Date;
}

export async function findActiveSession(db: Db, token: string): Promise<SessionLookup | null> {
  const tokenHash = hashToken(token);
  const now = new Date();

  const rows = await db
    .select({
      sessionId: schema.sessions.id,
      userId: schema.users.id,
      projectId: schema.memberships.projectId,
      role: schema.memberships.role,
      loginName: schema.users.loginName,
      displayName: schema.users.displayName,
      projectName: schema.projects.name,
      lastSeenAt: schema.sessions.lastSeenAt,
      expiresAt: schema.sessions.expiresAt,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .innerJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id))
    .innerJoin(schema.projects, eq(schema.projects.id, schema.memberships.projectId))
    .where(
      and(
        eq(schema.sessions.tokenHash, tokenHash),
        gt(schema.sessions.expiresAt, now),
        isNotNull(schema.users.loginName),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row || row.loginName === null) return null;
  return { ...row, loginName: row.loginName };
}

export async function maybeRenewSession(
  db: Db,
  session: SessionLookup,
  token: string,
  reply: FastifyReply,
  config: Config,
): Promise<void> {
  const now = new Date();
  if (now.getTime() - session.lastSeenAt.getTime() <= SLIDING_RENEWAL_MS) {
    return;
  }
  const expiresAt = new Date(now.getTime() + config.sessionTtlDays * DAY_MS);
  await db
    .update(schema.sessions)
    .set({ lastSeenAt: now, expiresAt })
    .where(eq(schema.sessions.id, session.sessionId));
  setSessionCookie(reply, token, config);
}

export async function isSessionValid(db: Db, sessionId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.id, sessionId), gt(schema.sessions.expiresAt, new Date())))
    .limit(1);
  return rows.length > 0;
}

export async function deleteSessionById(q: Queryable, sessionId: string): Promise<string[]> {
  const deleted = await q
    .delete(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .returning({ id: schema.sessions.id });
  return deleted.map((r) => r.id);
}

export async function deleteAllUserSessions(q: Queryable, userId: string): Promise<string[]> {
  const deleted = await q
    .delete(schema.sessions)
    .where(eq(schema.sessions.userId, userId))
    .returning({ id: schema.sessions.id });
  return deleted.map((r) => r.id);
}

export async function deleteOtherUserSessions(
  q: Queryable,
  userId: string,
  keepSessionId: string,
): Promise<string[]> {
  const deleted = await q
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), ne(schema.sessions.id, keepSessionId)))
    .returning({ id: schema.sessions.id });
  return deleted.map((r) => r.id);
}

/** 按登录名统计连续失败次数：15 分钟内失败 5 次锁定 15 分钟 */
export class LoginLockoutStore {
  private readonly windowMs = 15 * 60 * 1000;
  private readonly maxFailures = 5;
  private readonly records = new Map<string, { failures: number[]; lockedUntil: number }>();

  isLocked(loginName: string, now = Date.now()): boolean {
    const rec = this.records.get(loginName);
    if (!rec) return false;
    if (rec.lockedUntil > now) return true;
    return false;
  }

  recordFailure(loginName: string, now = Date.now()): void {
    const rec = this.records.get(loginName) ?? { failures: [], lockedUntil: 0 };
    rec.failures = rec.failures.filter((t) => now - t < this.windowMs);
    rec.failures.push(now);
    if (rec.failures.length >= this.maxFailures) {
      rec.lockedUntil = now + this.windowMs;
      rec.failures = [];
    }
    this.records.set(loginName, rec);
  }

  clear(loginName: string): void {
    this.records.delete(loginName);
  }
}
