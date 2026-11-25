import type { FastifyInstance } from 'fastify';
import { findActiveSession, SESSION_COOKIE } from '../auth/session.js';
import { looksLikeToken } from '../auth/tokens.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { AppError } from '../errors.js';
import type { RealtimeHub } from './hub.js';

export function registerRealtimeRoute(
  app: FastifyInstance,
  deps: { db: Db; config: Config; realtime: RealtimeHub },
): void {
  const { db, config, realtime } = deps;

  app.get(
    '/api/realtime',
    {
      websocket: true,
      config: { isRealtimeUpgrade: true },
      preValidation: async (request) => {
        const origin = request.headers.origin;
        if (!origin || origin !== config.appOrigin) {
          throw new AppError('ORIGIN_FORBIDDEN');
        }

        const token = request.cookies[SESSION_COOKIE];
        if (!token || !looksLikeToken(token)) {
          throw new AppError('UNAUTHENTICATED');
        }

        const session = await findActiveSession(db, token);
        if (!session) {
          throw new AppError('UNAUTHENTICATED');
        }

        request.auth = {
          userId: session.userId,
          projectId: session.projectId,
          role: session.role,
          sessionId: session.sessionId,
          loginName: session.loginName,
          displayName: session.displayName,
          projectName: session.projectName,
        };
      },
    },
    (socket, request) => {
      const auth = request.auth;
      if (!auth) {
        socket.close(4401, '未登录');
        return;
      }
      realtime.registerConnection(socket, {
        userId: auth.userId,
        projectId: auth.projectId,
        sessionId: auth.sessionId,
        role: auth.role,
        displayName: auth.displayName,
      });
    },
  );
}
