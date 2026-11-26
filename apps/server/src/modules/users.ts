import {
  type ClaimLinkResponse,
  type ClaimStatus,
  can,
  createClaimLinkBodySchema,
  type ResetLinkResponse,
  type UserListItem,
  updateRoleBodySchema,
} from '@nw/shared';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
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

    const [rows, claimRows] = await Promise.all([
      db
        .select({
          id: schema.users.id,
          displayName: schema.users.displayName,
          loginName: schema.users.loginName,
          role: schema.memberships.role,
          createdAt: schema.users.createdAt,
          claimedAt: schema.users.claimedAt,
        })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
        .where(eq(schema.memberships.projectId, auth.projectId))
        .orderBy(asc(schema.users.createdAt)),
      includeAdminFields
        ? db
            .select({
              userId: schema.accountClaims.userId,
              expiresAt: schema.accountClaims.expiresAt,
            })
            .from(schema.accountClaims)
            .where(
              and(
                eq(schema.accountClaims.projectId, auth.projectId),
                isNull(schema.accountClaims.usedAt),
                isNull(schema.accountClaims.revokedAt),
              ),
            )
            .orderBy(desc(schema.accountClaims.createdAt))
        : Promise.resolve([]),
    ]);

    const latestClaimByUser = new Map<string, Date>();
    for (const c of claimRows) {
      if (!latestClaimByUser.has(c.userId)) {
        latestClaimByUser.set(c.userId, c.expiresAt);
      }
    }
    const now = new Date();

    return rows.map((r): UserListItem => {
      if (includeAdminFields) {
        const isClaimed = r.claimedAt !== null || r.loginName !== null;
        let claimStatus: ClaimStatus;
        let claimExpiresAt: string | null = null;
        if (isClaimed) {
          claimStatus = 'claimed';
        } else {
          const latestExp = latestClaimByUser.get(r.id) ?? null;
          if (!latestExp) {
            claimStatus = 'none';
          } else if (latestExp > now) {
            claimStatus = 'active';
            claimExpiresAt = latestExp.toISOString();
          } else {
            claimStatus = 'expired';
            claimExpiresAt = latestExp.toISOString();
          }
        }
        return {
          id: r.id,
          displayName: r.displayName,
          role: r.role,
          loginName: r.loginName,
          createdAt: r.createdAt.toISOString(),
          claimedAt: r.claimedAt ? r.claimedAt.toISOString() : null,
          claimStatus,
          claimExpiresAt,
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
          .select({
            userId: schema.memberships.userId,
            loginName: schema.users.loginName,
            claimedAt: schema.users.claimedAt,
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

        const targetRow = target[0];
        if (!targetRow) {
          throw notFound();
        }
        if (targetRow.claimedAt === null || targetRow.loginName === null) {
          throw new AppError('CONFLICT', '该用户尚未认领账号，请生成认领链接');
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

  // POST /api/users/:id/claim-link
  app.post<{ Params: { id: string } }>(
    '/api/users/:id/claim-link',
    { config: { access: { permission: 'users.manage' } } },
    async (request, reply) => {
      const auth = request.auth!;
      const targetUserId = parseUuidParam(request.params.id);
      const body = parseBody(createClaimLinkBodySchema, request.body);
      const token = newToken();
      const tokenHash = hashToken(token);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + body.ttlDays * 24 * 60 * 60 * 1000);

      await db.transaction(async (tx) => {
        const [member] = await tx
          .select({ userId: schema.memberships.userId })
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.projectId, auth.projectId),
              eq(schema.memberships.userId, targetUserId),
            ),
          )
          .limit(1);

        if (!member) {
          throw notFound();
        }

        const [user] = await tx
          .select({
            id: schema.users.id,
            loginName: schema.users.loginName,
            claimedAt: schema.users.claimedAt,
          })
          .from(schema.users)
          .where(eq(schema.users.id, targetUserId))
          .for('update')
          .limit(1);

        if (!user) {
          throw notFound();
        }

        if (user.claimedAt !== null || user.loginName !== null) {
          throw new AppError('CONFLICT', '该用户已完成认领，无需生成认领链接');
        }

        // 作废该用户此前所有未使用且未作废的认领链接
        await tx
          .update(schema.accountClaims)
          .set({ revokedAt: now })
          .where(
            and(
              eq(schema.accountClaims.projectId, auth.projectId),
              eq(schema.accountClaims.userId, targetUserId),
              isNull(schema.accountClaims.usedAt),
              isNull(schema.accountClaims.revokedAt),
            ),
          );

        await tx.insert(schema.accountClaims).values({
          projectId: auth.projectId,
          userId: targetUserId,
          tokenHash,
          expiresAt,
          createdBy: auth.userId,
        });
      });

      const res: ClaimLinkResponse = {
        url: `${config.appOrigin}/claim/${token}`,
        expiresAt: expiresAt.toISOString(),
      };
      return reply.code(201).send(res);
    },
  );
}
