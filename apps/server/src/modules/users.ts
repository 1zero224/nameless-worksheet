import { can, type ResetLinkResponse, type UserListItem, updateRoleBodySchema } from '@nw/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { deleteAllUserSessions } from '../auth/session.js';
import { hashToken, newToken } from '../auth/tokens.js';
import type { Config } from '../config.js';
import { type Db, schema } from '../db/index.js';
import { withTx } from '../db/tx.js';
import { AppError, notFound } from '../errors.js';
import type { EventBus } from '../realtime/bus.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { parseBody, parseUuidParam, readOriginConnId } from './helpers.js';

export function registerUserRoutes(
  app: FastifyInstance,
  deps: {
    db: Db;
    config: Config;
    bus: EventBus;
    realtime: RealtimeHub;
  },
): void {
  const { db, config, bus, realtime } = deps;

  // GET /api/users
  app.get('/api/users', { config: { access: 'authenticated' } }, async (request) => {
    const auth = request.auth!;
    const includeAdminFields = can(auth.role, 'users.manage');

    const rows = await db
      .select({
        id: schema.users.id,
        displayName: schema.users.displayName,
        loginName: schema.users.loginName,
        role: schema.memberships.role,
        createdAt: schema.users.createdAt,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
      .where(eq(schema.memberships.projectId, auth.projectId))
      .orderBy(asc(schema.users.createdAt));

    return rows.map((r): UserListItem => {
      if (includeAdminFields) {
        return {
          id: r.id,
          displayName: r.displayName,
          role: r.role,
          loginName: r.loginName,
          createdAt: r.createdAt.toISOString(),
        };
      }
      return {
        id: r.id,
        displayName: r.displayName,
        role: r.role,
      };
    });
  });

  // PATCH /api/users/:id/role
  app.patch<{ Params: { id: string } }>(
    '/api/users/:id/role',
    { config: { access: { permission: 'users.manage' } } },
    async (request) => {
      const auth = request.auth!;
      const targetUserId = parseUuidParam(request.params.id);
      const body = parseBody(updateRoleBodySchema, request.body);
      const originConnId = readOriginConnId(request);

      const { result } = await withTx(
        db,
        bus,
        { projectId: auth.projectId, userId: auth.userId, originConnId },
        async ({ tx, emit }) => {
          // 锁住该项目全部管理员的 membership 行（不变量 1）
          const adminRows = await tx
            .select({ userId: schema.memberships.userId })
            .from(schema.memberships)
            .where(
              and(
                eq(schema.memberships.projectId, auth.projectId),
                eq(schema.memberships.role, 'admin'),
              ),
            )
            .for('update');

          const targetRows = await tx
            .select({
              id: schema.users.id,
              loginName: schema.users.loginName,
              displayName: schema.users.displayName,
              role: schema.memberships.role,
              createdAt: schema.users.createdAt,
            })
            .from(schema.memberships)
            .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
            .where(
              and(
                eq(schema.memberships.projectId, auth.projectId),
                eq(schema.memberships.userId, targetUserId),
              ),
            )
            .limit(1);

          const target = targetRows[0];
          if (!target) {
            throw notFound();
          }

          if (target.role === 'admin' && body.role === 'user') {
            const remainingAdmins = adminRows.filter((a) => a.userId !== targetUserId);
            if (remainingAdmins.length === 0) {
              throw new AppError('CONFLICT', '项目至少需要保留一名管理员');
            }
          }

          if (target.role !== body.role) {
            await tx
              .update(schema.memberships)
              .set({ role: body.role })
              .where(
                and(
                  eq(schema.memberships.projectId, auth.projectId),
                  eq(schema.memberships.userId, targetUserId),
                ),
              );

            emit({
              scope: { type: 'project', id: auth.projectId },
              type: 'user.updated',
              payload: { userId: targetUserId },
            });
          }

          return {
            id: target.id,
            displayName: target.displayName,
            loginName: target.loginName,
            role: body.role,
            createdAt: target.createdAt.toISOString(),
          } satisfies UserListItem;
        },
      );

      // 角色调整后重新校验该用户所有连接上的订阅
      await realtime.revalidateUser(targetUserId, body.role);

      return result;
    },
  );

  // POST /api/users/:id/password-reset
  app.post<{ Params: { id: string } }>(
    '/api/users/:id/password-reset',
    { config: { access: { permission: 'users.manage' } } },
    async (request) => {
      const auth = request.auth!;
      const targetUserId = parseUuidParam(request.params.id);
      const token = newToken();
      const tokenHash = hashToken(token);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const deletedSessions = await db.transaction(async (tx) => {
        const target = await tx
          .select({ userId: schema.memberships.userId })
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.projectId, auth.projectId),
              eq(schema.memberships.userId, targetUserId),
            ),
          )
          .limit(1);

        if (target.length === 0) {
          throw notFound();
        }

        // 旧的未使用重置链接标记为已使用（不变量 4）
        await tx
          .update(schema.passwordResets)
          .set({ usedAt: now })
          .where(
            and(
              eq(schema.passwordResets.userId, targetUserId),
              isNull(schema.passwordResets.usedAt),
            ),
          );

        // 立即把旧密码置空
        await tx
          .update(schema.users)
          .set({ passwordHash: null, updatedAt: now })
          .where(eq(schema.users.id, targetUserId));

        // 删除该用户全部会话
        const deleted = await deleteAllUserSessions(tx, targetUserId);

        // 插入新的 24 小时重置链接
        await tx.insert(schema.passwordResets).values({
          userId: targetUserId,
          tokenHash,
          expiresAt,
          createdBy: auth.userId,
        });

        return deleted;
      });

      realtime.closeSessions(deletedSessions);

      const res: ResetLinkResponse = {
        url: `${config.appOrigin}/reset/${token}`,
        expiresAt: expiresAt.toISOString(),
      };
      return res;
    },
  );
}
