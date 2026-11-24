import { z } from 'zod';

const intFromEnv = (def: number, min = 1) =>
  z.coerce.number().int().min(min).default(def) as unknown as z.ZodType<number>;

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: intFromEnv(3000),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_URL: z.string().min(1).startsWith('postgres'),
    APP_ORIGIN: z.url().optional(),
    TRUST_PROXY: z.string().optional(),
    SESSION_TTL_DAYS: intFromEnv(30),
    REALTIME_RETENTION_HOURS: intFromEnv(24),
    REALTIME_REPLAY_LIMIT: intFromEnv(500),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    WEB_DIST_DIR: z.string().optional(),
  })
  .transform((e) => {
    const appOrigin = (
      e.APP_ORIGIN ?? (e.NODE_ENV === 'production' ? undefined : 'http://localhost:5173')
    )?.replace(/\/+$/, '');
    if (!appOrigin) {
      throw new ConfigError(['APP_ORIGIN']);
    }
    return {
      nodeEnv: e.NODE_ENV,
      port: e.PORT,
      host: e.HOST,
      databaseUrl: e.DATABASE_URL,
      appOrigin,
      trustProxy: parseTrustProxy(
        e.TRUST_PROXY ?? (e.NODE_ENV === 'production' ? '172.19.0.0/16' : 'false'),
      ),
      sessionTtlDays: e.SESSION_TTL_DAYS,
      realtimeRetentionHours: e.REALTIME_RETENTION_HOURS,
      realtimeReplayLimit: e.REALTIME_REPLAY_LIMIT,
      logLevel: e.LOG_LEVEL,
      webDistDir: e.WEB_DIST_DIR,
      secureCookies: e.NODE_ENV === 'production' || appOrigin.startsWith('https://'),
    };
  });

export type Config = z.output<typeof schema>;

export class ConfigError extends Error {
  constructor(public readonly variables: string[]) {
    super(`环境变量缺失或非法：${variables.join(', ')}`);
  }
}

function parseTrustProxy(v: string): boolean | string[] {
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) {
    const vars = [...new Set(r.error.issues.map((i) => String(i.path[0] ?? '?')))];
    throw new ConfigError(vars);
  }
  return r.data;
}
