import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { LoginLockoutStore, SESSION_COOKIE } from './auth/session.js';
import { type RegisteredApiRoute, registerAuthzPlugin } from './authz/index.js';
import type { Config } from './config.js';
import { createDb, createPool, type Db } from './db/index.js';
import { AppError } from './errors.js';
import { startJobs } from './jobs/index.js';
import { registerAccountRoutes } from './modules/accounts.js';
import { registerBoardColumnRoutes } from './modules/board-columns.js';
import { registerChangeLogRoutes } from './modules/change-logs.js';
import { registerColumnRoutes } from './modules/columns.js';
import { registerDiagRoutes } from './modules/diag.js';
import { registerHealthRoutes } from './modules/health.js';
import { registerInviteRoutes } from './modules/invites.js';
import { registerStageRoutes } from './modules/stages.js';
import { registerTaskRoutes } from './modules/tasks.js';
import { registerUserRoutes } from './modules/users.js';
import { registerWorksheetRoutes } from './modules/worksheets.js';
import { type EventBus, InProcessEventBus } from './realtime/bus.js';
import { RealtimeHub } from './realtime/hub.js';
import { registerRealtimeRoute } from './realtime/route.js';
import { createDefaultScopeRegistry } from './realtime/scopes.js';

export function scrubTokenUrl(url: string): string {
  return url
    .replace(/(\/api\/invites\/by-token\/)[^/?#]+/, '$1:token')
    .replace(/(\/api\/password-resets\/)[^/?#]+/, '$1:token')
    .replace(/^(\/invite\/)[^/?#]+/, '$1:token')
    .replace(/^(\/reset\/)[^/?#]+/, '$1:token');
}

export interface BuildAppOptions {
  config: Config;
  pool?: pg.Pool;
  enableJobs?: boolean;
  enableRateLimit?: boolean;
  heartbeatIntervalMs?: number;
  logger?: boolean;
}

export interface AppContext {
  config: Config;
  pool: pg.Pool;
  db: Db;
  bus: EventBus;
  realtime: RealtimeHub;
  getRegisteredRoutes: () => RegisteredApiRoute[];
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = opts;
  const ownsPool = !opts.pool;
  const pool = opts.pool ?? createPool(config.databaseUrl);
  const db = createDb(pool);
  const bus = new InProcessEventBus();
  const scopeRegistry = createDefaultScopeRegistry();
  const realtime = new RealtimeHub(db, bus, scopeRegistry, config, {
    heartbeatIntervalMs: opts.heartbeatIntervalMs,
  });
  const lockout = new LoginLockoutStore();
  const enableRateLimit = opts.enableRateLimit ?? config.nodeEnv !== 'test';

  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024, // 1MB
    logger:
      opts.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: {
              paths: [
                'req.headers.cookie',
                'req.headers.authorization',
                'res.headers["set-cookie"]',
              ],
              censor: '[REDACTED]',
            },
            serializers: {
              req(req) {
                return {
                  method: req.method,
                  url: scrubTokenUrl(req.url),
                  remoteAddress: req.ip,
                };
              },
            },
          },
  });

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);

  if (enableRateLimit) {
    await app.register(fastifyRateLimit, {
      global: true,
      max: 600,
      timeWindow: '1 minute',
      keyGenerator: (request) => {
        const cookie = request.cookies?.[SESSION_COOKIE];
        if (cookie) return `sess:${cookie.slice(0, 16)}`;
        return `ip:${request.ip}`;
      },
      errorResponseBuilder: () => new AppError('RATE_LIMITED'),
    });
  }

  // 允许带空的 application/json 或无 body 的写请求
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const str = typeof body === 'string' ? body : body.toString('utf8');
    if (str.trim() === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(str));
    } catch {
      done(new AppError('VALIDATION_FAILED', 'JSON 格式无效'), undefined);
    }
  });

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send(err.toBody());
    }
    const fastifyErr = err as { statusCode?: number; code?: string };
    if (fastifyErr.statusCode === 429) {
      const rateErr = new AppError('RATE_LIMITED');
      return reply.code(429).send(rateErr.toBody());
    }
    if (fastifyErr.statusCode && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
      const valErr = new AppError('VALIDATION_FAILED');
      return reply.code(fastifyErr.statusCode).send(valErr.toBody());
    }
    app.log.error({ err }, 'Unhandled error');
    const internal = new AppError('INTERNAL');
    return reply.code(500).send(internal.toBody());
  });

  const { getRegisteredRoutes } = registerAuthzPlugin(app, db, config);

  registerHealthRoutes(app, db);
  registerAccountRoutes(app, { db, config, bus, realtime, lockout, enableRateLimit });
  registerInviteRoutes(app, { db, config, bus, enableRateLimit });
  registerUserRoutes(app, { db, config, bus, realtime });
  registerBoardColumnRoutes(app, { db, bus });
  registerWorksheetRoutes(app, { db, bus });
  registerColumnRoutes(app, { db, bus });
  registerTaskRoutes(app, { db, bus });
  registerStageRoutes(app, { db, bus });
  registerChangeLogRoutes(app, { db });
  registerDiagRoutes(app, { db, bus });
  registerRealtimeRoute(app, { db, config, realtime });

  // 前端静态文件与 SPA 回退
  if (config.webDistDir && existsSync(config.webDistDir)) {
    const webDir = path.resolve(config.webDistDir);
    await app.register(fastifyStatic, {
      root: webDir,
      prefix: '/',
      wildcard: false,
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        const nf = new AppError('NOT_FOUND');
        return reply.code(404).send(nf.toBody());
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_request, reply) => {
      const nf = new AppError('NOT_FOUND');
      return reply.code(404).send(nf.toBody());
    });
  }

  let jobsHandle: { stop: () => Promise<void> } | null = null;
  if (opts.enableJobs) {
    jobsHandle = await startJobs(db, config, app.log);
  }

  app.addHook('onClose', async () => {
    realtime.closeAll();
    if (jobsHandle) {
      await jobsHandle.stop();
    }
    if (ownsPool) {
      await pool.end();
    }
  });

  app.decorate('ctx', {
    config,
    pool,
    db,
    bus,
    realtime,
    getRegisteredRoutes,
  });

  return app;
}
