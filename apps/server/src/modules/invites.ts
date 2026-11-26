import {
  type CreatedInvite,
  createInviteBodySchema,
  type InviteItem,
  type InvitePreview,
  type InviteStatus,
  type MeResponse,
  permissionsFor,
  registerBodySchema,
} from '@nw/shared';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../auth/password.js';
import { createSession, setSessionCookie } from '../auth/session.js';
import { hashToken, looksLikeToken, newToken } from '../auth/tokens.js';
import type { Config } from '../config.js';
import { type Db, schema } from '../db/index.js';
import { withTx } from '../db/tx.js';
import { AppError, fieldError, notFound, uniqueViolation } from '../errors.js';
import type { EventBus } from '../realtime/bus.js';
import { parseBody, parseUuidParam, readOriginConnId } from './helpers.js';

function computeInviteStatus(
  row: { revokedAt: Date | null; expiresAt: Date; usedCount: number; maxUses: number },
  now: Date,
): InviteStatus {
  if (row.revokedAt !== null) return 'revoked';
  if (row.expiresAt <= now) return 'expired';
  if (row.usedCount >= row.maxUses) return 'exhausted';
  return 'active';
}

export function registerInviteRoutes(
  app: FastifyInstance,
  deps: {
    db: Db;
    config: Config;
    bus: EventBus;
    enableRateLimit: boolean;
  },
): void {
  const { db, config, bus, enableRateLimit } = deps;

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

  // GET /api/invites/by-token/:token
  app.get<{ Params: { token: string } }>(
    '/api/invites/by-token/:token',
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
          role: schema.invites.role,
          projectName: schema.projects.name,
        })
        .from(schema.invites)
        .innerJoin(schema.projects, eq(schema.invites.projectId, schema.projects.id))
        .where(
          and(
            eq(schema.invites.tokenHash, tokenHash),
            isNull(schema.invites.revokedAt),
            gt(schema.invites.expiresAt, now),
            sql`${schema.invites.usedCount} < ${schema.invites.maxUses}`,
          ),
        )
        .limit(1);

      const row = rows[0];
      if (!row) {
        throw new AppError('TOKEN_INVALID');
      }

      const preview: InvitePreview = {
        projectName: row.projectName,
        role: row.role,
      };
      return preview;
    },
  );

  // POST /api/invites/by-token/:token/register
  app.post<{ Params: { token: string } }>(
    '/api/invites/by-token/:token/register',
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
      const body = parseBody(registerBodySchema, request.body);
      const tokenHash = hashToken(token);
      const originConnId = readOriginConnId(request);

      // 先快速检查邀请对应的 projectId（真正的名额抢占在事务内原子执行）
      const previewRows = await db
        .select({
          projectId: schema.invites.projectId,
          projectName: schema.projects.name,
        })
        .from(schema.invites)
        .innerJoin(schema.projects, eq(schema.invites.projectId, schema.projects.id))
        .where(
          and(
            eq(schema.invites.tokenHash, tokenHash),
            isNull(schema.invites.revokedAt),
            gt(schema.invites.expiresAt, new Date()),
            sql`${schema.invites.usedCount} < ${schema.invites.maxUses}`,
          ),
        )
        .limit(1);

      const preview = previewRows[0];
      if (!preview) {
        throw new AppError('TOKEN_INVALID');
      }

      const passwordHash = await hashPassword(body.password);

      try {
        const { result } = await withTx(
          db,
          bus,
          { projectId: preview.projectId, originConnId },
          async ({ tx, emit }) => {
            // 原子抢占邀请名额（不变量 2）
            const claimed = await tx
              .update(schema.invites)
              .set({ usedCount: sql`${schema.invites.usedCount} + 1` })
              .where(
                and(
                  eq(schema.invites.tokenHash, tokenHash),
                  isNull(schema.invites.revokedAt),
                  gt(schema.invites.expiresAt, sql`now()`),
                  sql`${schema.invites.usedCount} < ${schema.invites.maxUses}`,
                ),
              )
              .returning({
                projectId: schema.invites.projectId,
                role: schema.invites.role,
              });

            const invite = claimed[0];
            if (!invite) {
              throw new AppError('TOKEN_INVALID');
            }

            const [user] = await tx
              .insert(schema.users)
              .values({
                loginName: body.loginName,
                displayName: body.displayName,
                passwordHash,
                claimedAt: new Date(),
              })
              .returning({
                id: schema.users.id,
                loginName: schema.users.loginName,
                displayName: schema.users.displayName,
              });

            if (!user || !user.loginName) {
              throw new Error('Failed to insert user');
            }

            await tx.insert(schema.memberships).values({
              projectId: invite.projectId,
              userId: user.id,
              role: invite.role,
            });

            const session = await createSession(
              tx,
              user.id,
              request.headers['user-agent'],
              config.sessionTtlDays,
            );

            emit({
              scope: { type: 'project', id: invite.projectId },
              type: 'user.updated',
              payload: { userId: user.id },
            });

            return {
              token: session.token,
              me: {
                user: {
                  id: user.id,
                  loginName: user.loginName,
                  displayName: user.displayName,
                },
                project: {
                  id: invite.projectId,
                  name: preview.projectName,
                },
                role: invite.role,
                permissions: permissionsFor(invite.role),
              } satisfies MeResponse,
            };
          },
        );

        setSessionCookie(reply, result.token, config);
        return reply.code(201).send(result.me);
      } catch (err) {
        const constraint = uniqueViolation(err);
        if (constraint === 'users_login_name_key') {
          throw fieldError('loginName', '该登录名已被使用', 'CONFLICT');
        }
        if (constraint === 'users_display_name_key') {
          throw fieldError('displayName', '该显示名已被使用', 'CONFLICT');
        }
        throw err;
      }
    },
  );

  // GET /api/invites
  app.get(
    '/api/invites',
    { config: { access: { permission: 'invites.manage' } } },
    async (request) => {
      const auth = request.auth!;
      const now = new Date();

      const rows = await db
        .select({
          id: schema.invites.id,
          role: schema.invites.role,
          expiresAt: schema.invites.expiresAt,
          maxUses: schema.invites.maxUses,
          usedCount: schema.invites.usedCount,
          revokedAt: schema.invites.revokedAt,
          createdAt: schema.invites.createdAt,
          createdById: schema.users.id,
          createdByDisplayName: schema.users.displayName,
        })
        .from(schema.invites)
        .innerJoin(schema.users, eq(schema.invites.createdBy, schema.users.id))
        .where(eq(schema.invites.projectId, auth.projectId))
        .orderBy(desc(schema.invites.createdAt));

      return rows.map(
        (r): InviteItem => ({
          id: r.id,
          role: r.role,
          expiresAt: r.expiresAt.toISOString(),
          maxUses: r.maxUses,
          usedCount: r.usedCount,
          revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
          createdBy: { id: r.createdById, displayName: r.createdByDisplayName },
          createdAt: r.createdAt.toISOString(),
          status: computeInviteStatus(r, now),
        }),
      );
    },
  );

  // POST /api/invites
  app.post(
    '/api/invites',
    { config: { access: { permission: 'invites.manage' } } },
    async (request, reply) => {
      const auth = request.auth!;
      const body = parseBody(createInviteBodySchema, request.body);
      const token = newToken();
      const tokenHash = hashToken(token);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + body.expiresInDays * 24 * 60 * 60 * 1000);

      const [row] = await db
        .insert(schema.invites)
        .values({
          projectId: auth.projectId,
          tokenHash,
          role: body.role,
          expiresAt,
          maxUses: body.maxUses,
          createdBy: auth.userId,
        })
        .returning();

      if (!row) {
        throw new Error('Failed to create invite');
      }

      const res: CreatedInvite = {
        id: row.id,
        role: row.role,
        expiresAt: row.expiresAt.toISOString(),
        maxUses: row.maxUses,
        usedCount: row.usedCount,
        revokedAt: null,
        createdBy: { id: auth.userId, displayName: auth.displayName },
        createdAt: row.createdAt.toISOString(),
        status: 'active',
        url: `${config.appOrigin}/invite/${token}`,
      };

      return reply.code(201).send(res);
    },
  );

  // DELETE /api/invites/:id
  app.delete<{ Params: { id: string } }>(
    '/api/invites/:id',
    { config: { access: { permission: 'invites.manage' } } },
    async (request, reply) => {
      const auth = request.auth!;
      const inviteId = parseUuidParam(request.params.id);

      const updated = await db
        .update(schema.invites)
        .set({ revokedAt: new Date() })
        .where(and(eq(schema.invites.id, inviteId), eq(schema.invites.projectId, auth.projectId)))
        .returning({ id: schema.invites.id });

      if (updated.length === 0) {
        throw notFound();
      }

      return reply.code(204).send();
    },
  );
}
