import { can, type Permission, type Role } from '@nw/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { findActiveSession, maybeRenewSession, SESSION_COOKIE } from '../auth/session.js';
import { looksLikeToken } from '../auth/tokens.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { AppError } from '../errors.js';

export type RouteAccess = 'public' | 'authenticated' | { permission: Permission };

export interface AuthContext {
  userId: string;
  projectId: string;
  role: Role;
  sessionId: string;
  loginName: string;
  displayName: string;
  projectName: string;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: RouteAccess;
    /** 标记实时 WebSocket 升级路由，由实时模块自行鉴权 */
    isRealtimeUpgrade?: boolean;
  }

  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export interface RegisteredApiRoute {
  method: string;
  url: string;
  access: RouteAccess | 'realtime';
}

export function registerAuthzPlugin(
  app: FastifyInstance,
  db: Db,
  config: Config,
): { getRegisteredRoutes: () => RegisteredApiRoute[] } {
  const registeredRoutes: RegisteredApiRoute[] = [];
  const undeclaredRoutes: string[] = [];

  app.addHook('onRoute', (routeOptions) => {
    const url = routeOptions.url;
    if (!url.startsWith('/api/')) return;
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    // Fastify 会自动为 GET 路由生成 HEAD 路由，这里一起检查
    for (const method of methods) {
      if (method === 'HEAD') continue;
      if (routeOptions.config?.isRealtimeUpgrade) {
        registeredRoutes.push({ method, url, access: 'realtime' });
        continue;
      }
      const access = routeOptions.config?.access;
      if (!access) {
        undeclaredRoutes.push(`${method} ${url}`);
      } else {
        registeredRoutes.push({ method, url, access });
      }
    }
  });

  app.addHook('onReady', async () => {
    if (undeclaredRoutes.length > 0) {
      throw new Error(`以下路由未声明访问级别（config.access）：${undeclaredRoutes.join(', ')}`);
    }
  });

  // 来源校验与 Content-Type 校验（6.4）
  app.addHook('onRequest', async (request: FastifyRequest) => {
    if (!request.url.startsWith('/api/')) return;
    if (request.method === 'GET' || request.method === 'HEAD') return;

    const origin = request.headers.origin;
    if (!origin || origin !== config.appOrigin) {
      throw new AppError('ORIGIN_FORBIDDEN');
    }

    const contentType = request.headers['content-type'];
    const contentLength = Number(request.headers['content-length'] ?? '0');
    const hasTransferEncoding = Boolean(request.headers['transfer-encoding']);
    if (contentType) {
      if (!contentType.toLowerCase().startsWith('application/json')) {
        throw new AppError('VALIDATION_FAILED', '请求体只接受 application/json');
      }
    } else if (contentLength > 0 || hasTransferEncoding) {
      throw new AppError('VALIDATION_FAILED', '请求体只接受 application/json');
    }
  });

  // 鉴权与权限判定
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith('/api/')) return;
    const routeConfig = request.routeOptions.config;
    if (routeConfig?.isRealtimeUpgrade) return;
    const access = routeConfig?.access;
    if (!access || access === 'public') return;

    const token = request.cookies[SESSION_COOKIE];
    if (!token || !looksLikeToken(token)) {
      throw new AppError('UNAUTHENTICATED');
    }

    const session = await findActiveSession(db, token);
    if (!session) {
      throw new AppError('UNAUTHENTICATED');
    }

    await maybeRenewSession(db, session, token, reply, config);

    request.auth = {
      userId: session.userId,
      projectId: session.projectId,
      role: session.role,
      sessionId: session.sessionId,
      loginName: session.loginName,
      displayName: session.displayName,
      projectName: session.projectName,
    };

    if (typeof access === 'object' && 'permission' in access) {
      if (!can(request.auth.role, access.permission)) {
        throw new AppError('FORBIDDEN');
      }
    }
  });

  return {
    getRegisteredRoutes: () => [...registeredRoutes],
  };
}
