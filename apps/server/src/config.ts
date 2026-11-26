import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MULTIPART_THRESHOLD_BYTES,
  DEFAULT_PART_SIZE_BYTES,
  DEFAULT_UPLOAD_CONCURRENCY,
} from '@nw/shared';
import { z } from 'zod';

const intFromEnv = (def: number, min = 1, max?: number) => {
  let num = z.coerce.number().int().min(min);
  if (max !== undefined) num = num.max(max);
  return num.default(def) as unknown as z.ZodType<number>;
};

const optionalNonEmpty = z
  .string()
  .optional()
  .transform((v) => {
    const trimmed = v?.trim();
    return trimmed ? trimmed : undefined;
  });

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

    // 阶段 4：对象存储与上传配置
    STORAGE_DRIVER: z.enum(['r2', 'local']).optional(),
    R2_ACCOUNT_ID: optionalNonEmpty,
    R2_ACCESS_KEY_ID: optionalNonEmpty,
    R2_SECRET_ACCESS_KEY: optionalNonEmpty,
    R2_BUCKET: optionalNonEmpty,
    R2_ENDPOINT: optionalNonEmpty,
    R2_MAX_FILE_BYTES: intFromEnv(DEFAULT_MAX_FILE_BYTES, 1),
    R2_MULTIPART_THRESHOLD_BYTES: intFromEnv(DEFAULT_MULTIPART_THRESHOLD_BYTES, 1),
    R2_PART_SIZE_BYTES: intFromEnv(DEFAULT_PART_SIZE_BYTES, 1),
    R2_UPLOAD_CONCURRENCY: intFromEnv(DEFAULT_UPLOAD_CONCURRENCY, 1, 6),
    R2_UPLOAD_SIGN_TTL_SEC: intFromEnv(600, 1),
    R2_DOWNLOAD_SIGN_TTL_SEC: intFromEnv(600, 1),
    UPLOAD_SESSION_TTL_HOURS: intFromEnv(24, 1),
    UPLOAD_CLEANUP_GRACE_HOURS: intFromEnv(2, 0),
  })
  .transform((e) => {
    const appOrigin = (
      e.APP_ORIGIN ?? (e.NODE_ENV === 'production' ? undefined : 'http://localhost:5173')
    )?.replace(/\/+$/, '');
    if (!appOrigin) {
      throw new ConfigError(['APP_ORIGIN']);
    }

    const hasAllR2Creds = Boolean(
      e.R2_ACCOUNT_ID && e.R2_ACCESS_KEY_ID && e.R2_SECRET_ACCESS_KEY && e.R2_BUCKET,
    );

    const storageDriver: 'r2' | 'local' =
      e.STORAGE_DRIVER ?? (e.NODE_ENV === 'production' ? 'r2' : hasAllR2Creds ? 'r2' : 'local');

    if (e.NODE_ENV === 'production' && storageDriver !== 'r2') {
      throw new ConfigError(['STORAGE_DRIVER']);
    }

    if (storageDriver === 'r2') {
      const missing: string[] = [];
      if (!e.R2_ACCOUNT_ID) missing.push('R2_ACCOUNT_ID');
      if (!e.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
      if (!e.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
      if (!e.R2_BUCKET) missing.push('R2_BUCKET');
      if (missing.length > 0) {
        throw new ConfigError(missing);
      }
    }

    const r2Endpoint = e.R2_ENDPOINT
      ? e.R2_ENDPOINT.replace(/\/+$/, '')
      : e.R2_ACCOUNT_ID
        ? `https://${e.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
        : undefined;

    if (r2Endpoint) {
      const parsedUrl = z.url({ protocol: /^https?$/ }).safeParse(r2Endpoint);
      if (!parsedUrl.success) {
        throw new ConfigError(['R2_ENDPOINT']);
      }
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

      storageDriver,
      r2AccountId: e.R2_ACCOUNT_ID,
      r2AccessKeyId: e.R2_ACCESS_KEY_ID,
      r2SecretAccessKey: e.R2_SECRET_ACCESS_KEY,
      r2Bucket: e.R2_BUCKET,
      r2Endpoint,
      r2MaxFileBytes: e.R2_MAX_FILE_BYTES,
      r2MultipartThresholdBytes: e.R2_MULTIPART_THRESHOLD_BYTES,
      r2PartSizeBytes: e.R2_PART_SIZE_BYTES,
      r2UploadConcurrency: e.R2_UPLOAD_CONCURRENCY,
      r2UploadSignTtlSec: e.R2_UPLOAD_SIGN_TTL_SEC,
      r2DownloadSignTtlSec: e.R2_DOWNLOAD_SIGN_TTL_SEC,
      uploadSessionTtlHours: e.UPLOAD_SESSION_TTL_HOURS,
      uploadCleanupGraceHours: e.UPLOAD_CLEANUP_GRACE_HOURS,
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
