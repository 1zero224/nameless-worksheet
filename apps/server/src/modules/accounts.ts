import {
  changePasswordBodySchema,
  loginBodySchema,
  type MeResponse,
  PASSWORD_EQUALS_LOGIN_NAME,
  passwordMatchesLoginName,
  permissionsFor,
  type ResetPreview,
  resetPasswordBodySchema,
  updateAccountBodySchema,
} from '@nw/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { hashPassword, verifyPassword } from '../auth/password.js';
import {
  clearSessionCookie,
  createSession,
  deleteAllUserSessions,
  deleteOtherUserSessions,
  deleteSessionById,
  type LoginLockoutStore,
  setSessionCookie,
} from '../auth/session.js';
import { hashToken, looksLikeToken } from '../auth/tokens.js';
import type { Config } from '../config.js';
import { type Db, schema } from '../db/index.js';
import { withTx } from '../db/tx.js';
import { AppError, fieldError, uniqueViolation } from '../errors.js';
import type { EventBus } from '../realtime/bus.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { parseBody, readOriginConnId } from './helpers.js';

export function registerAccountRoutes(
  app: FastifyInstance,
  deps: {
    db: Db;
    config: Config;
    bus: EventBus;
    realtime: RealtimeHub;
    lockout: LoginLockoutStore;
    enableRateLimit: boolean;
  },
): void {
  const { db, config, bus, realtime, lockout, enableRateLimit } = deps;

  const ipRateLimit = (max: number) =>
    enableRateLimit
      ? {
          rateLimit: {
            max,
            timeWindow: '1 minute',
            keyGenerator: (req: { ip: string }) => req.ip,
          },
        }
      : {};

  // POST /api/auth/login
  app.post(
    '/api/auth/login',
    {
      config: {
        access: 'public',
        ...ipRateLimit(10),
      },
    },
    async (request, reply) => {
      const body = parseBody(loginBodySchema, request.body);
      const loginName = body.loginName;

      if (lockout.isLocked(loginName)) {
        throw new AppError('RATE_LIMITED', '尝试次数过多，请 15 分钟后再试');
      }

      const rows = await db
        .select({
          userId: schema.users.id,
          loginName: schema.users.loginName,
          displayName: schema.users.displayName,
          passwordHash: schema.users.passwordHash,
          projectId: schema.memberships.projectId,
          role: schema.memberships.role,
          projectName: schema.projects.name,
        })
        .from(schema.users)
        .innerJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id))
        .innerJoin(schema.projects, eq(schema.projects.id, schema.memberships.projectId))
        .where(eq(schema.users.loginName, loginName))
        .limit(1);

      const user = rows[0];
      const verified = await verifyPassword(user?.passwordHash, body.password);

      if (!user || !verified.ok) {
        lockout.recordFailure(loginName);
        throw new AppError('INVALID_CREDENTIALS');
      }

      lockout.clear(loginName);

      if (verified.needsRehash) {
        const newHash = await hashPassword(body.password);
        await db
          .update(schema.users)
          .set({ passwordHash: newHash, updatedAt: new Date() })
          .where(eq(schema.users.id, user.userId));
      }

      const { token } = await createSession(
        db,
        user.userId,
        request.headers['user-agent'],
        config.sessionTtlDays,
      );
      setSessionCookie(reply, token, config);

      const res: MeResponse = {
        user: {
          id: user.userId,
          loginName: user.loginName,
          displayName: user.displayName,
        },
        project: {
          id: user.projectId,
          name: user.projectName,
        },
        role: user.role,
        permissions: permissionsFor(user.role),
      };
      return res;
    },
  );

  // POST /api/auth/logout
  app.post('/api/auth/logout', { config: { access: 'authenticated' } }, async (request, reply) => {
    const auth = request.auth!;
    const deleted = await deleteSessionById(db, auth.sessionId);
    clearSessionCookie(reply, config);
    realtime.closeSessions(deleted);
    return reply.code(204).send();
  });

  // GET /api/auth/me
  app.get('/api/auth/me', { config: { access: 'authenticated' } }, async (request) => {
    const auth = request.auth!;
    const res: MeResponse = {
      user: {
        id: auth.userId,
        loginName: auth.loginName,
        displayName: auth.displayName,
      },
      project: {
        id: auth.projectId,
        name: auth.projectName,
      },
      role: auth.role,
      permissions: permissionsFor(auth.role),
    };
    return res;
  });

  // GET /api/password-resets/:token
  app.get<{ Params: { token: string } }>(
    '/api/password-resets/:token',
    {
      config: {
        access: 'public',
        ...ipRateLimit(20),
      },
    },
    async (request) => {
      const { token } = request.params;
      if (!looksLikeToken(token)) {
        throw new AppError('TOKEN_INVALID');
      }
      const tokenHash = hashToken(token);
      const now = new Date();

      const rows = await db
        .select({
          loginName: schema.users.loginName,
          displayName: schema.users.displayName,
        })
        .from(schema.passwordResets)
        .innerJoin(schema.users, eq(schema.passwordResets.userId, schema.users.id))
        .where(
          and(
            eq(schema.passwordResets.tokenHash, tokenHash),
            isNull(schema.passwordResets.usedAt),
            gt(schema.passwordResets.expiresAt, now),
          ),
        )
        .limit(1);

      const row = rows[0];
      if (!row) {
        throw new AppError('TOKEN_INVALID');
      }
      const preview: ResetPreview = {
        loginName: row.loginName,
        displayName: row.displayName,
      };
      return preview;
    },
  );

  // POST /api/password-resets/:token
  app.post<{ Params: { token: string } }>(
    '/api/password-resets/:token',
    {
      config: {
        access: 'public',
        ...ipRateLimit(20),
      },
    },
    async (request, reply) => {
      const { token } = request.params;
      if (!looksLikeToken(token)) {
        throw new AppError('TOKEN_INVALID');
      }
      const body = parseBody(resetPasswordBodySchema, request.body);
      const tokenHash = hashToken(token);
      const now = new Date();

      // 先查出对应用户以便校验密码不能与登录名相同
      const previewRows = await db
        .select({
          resetId: schema.passwordResets.id,
          userId: schema.users.id,
          loginName: schema.users.loginName,
        })
        .from(schema.passwordResets)
        .innerJoin(schema.users, eq(schema.passwordResets.userId, schema.users.id))
        .where(
          and(
            eq(schema.passwordResets.tokenHash, tokenHash),
            isNull(schema.passwordResets.usedAt),
            gt(schema.passwordResets.expiresAt, now),
          ),
        )
        .limit(1);

      const target = previewRows[0];
      if (!target) {
        throw new AppError('TOKEN_INVALID');
      }

      if (passwordMatchesLoginName(body.password, target.loginName)) {
        throw fieldError('password', PASSWORD_EQUALS_LOGIN_NAME);
      }

      const passwordHash = await hashPassword(body.password);

      const deletedSessions = await db.transaction(async (tx) => {
        const claimed = await tx
          .update(schema.passwordResets)
          .set({ usedAt: now })
          .where(
            and(
              eq(schema.passwordResets.id, target.resetId),
              isNull(schema.passwordResets.usedAt),
              gt(schema.passwordResets.expiresAt, now),
            ),
          )
          .returning({ id: schema.passwordResets.id });

        if (claimed.length === 0) {
          throw new AppError('TOKEN_INVALID');
        }

        await tx
          .update(schema.users)
          .set({ passwordHash, updatedAt: now })
          .where(eq(schema.users.id, target.userId));

        return await deleteAllUserSessions(tx, target.userId);
      });

      lockout.clear(target.loginName);
      realtime.closeSessions(deletedSessions);
      return reply.code(204).send();
    },
  );

  // PATCH /api/account
  app.patch('/api/account', { config: { access: 'authenticated' } }, async (request) => {
    const auth = request.auth!;
    const body = parseBody(updateAccountBodySchema, request.body);
    const originConnId = readOriginConnId(request);

    try {
      const { result } = await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          const [updated] = await tx
            .update(schema.users)
            .set({ displayName: body.displayName, updatedAt: new Date() })
            .where(eq(schema.users.id, auth.userId))
            .returning({
              id: schema.users.id,
              loginName: schema.users.loginName,
              displayName: schema.users.displayName,
            });

          if (!updated) {
            throw new AppError('NOT_FOUND');
          }

          emit({
            scope: { type: 'project', id: auth.projectId },
            type: 'user.updated',
            payload: { userId: auth.userId },
          });

          return updated;
        },
      );
      return result;
    } catch (err) {
      const constraint = uniqueViolation(err);
      if (constraint === 'users_display_name_key') {
        throw fieldError('displayName', '该显示名已被使用', 'CONFLICT');
      }
      throw err;
    }
  });

  // POST /api/account/password
  app.post(
    '/api/account/password',
    { config: { access: 'authenticated' } },
    async (request, reply) => {
      const auth = request.auth!;
      const body = parseBody(changePasswordBodySchema, request.body);

      const [user] = await db
        .select({
          id: schema.users.id,
          loginName: schema.users.loginName,
          passwordHash: schema.users.passwordHash,
        })
        .from(schema.users)
        .where(eq(schema.users.id, auth.userId))
        .limit(1);

      if (!user) {
        throw new AppError('UNAUTHENTICATED');
      }

      const verified = await verifyPassword(user.passwordHash, body.currentPassword);
      if (!verified.ok) {
        throw fieldError('currentPassword', '当前密码错误');
      }

      if (passwordMatchesLoginName(body.newPassword, user.loginName)) {
        throw fieldError('newPassword', PASSWORD_EQUALS_LOGIN_NAME);
      }

      const newHash = await hashPassword(body.newPassword);

      const deletedSessions = await db.transaction(async (tx) => {
        await tx
          .update(schema.users)
          .set({ passwordHash: newHash, updatedAt: new Date() })
          .where(eq(schema.users.id, auth.userId));

        return await deleteOtherUserSessions(tx, auth.userId, auth.sessionId);
      });

      realtime.closeSessions(deletedSessions);
      return reply.code(204).send();
    },
  );
}
