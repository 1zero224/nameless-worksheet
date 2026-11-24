import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';

export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.length > 0 ? String(issue.path.join('.')) : '_root';
      if (!(key in fields)) {
        fields[key] = issue.message;
      }
    }
    const firstMsg = result.error.issues[0]?.message ?? '输入不符合要求';
    throw new AppError('VALIDATION_FAILED', firstMsg, fields);
  }
  return result.data;
}

const uuidSchema = z.uuid();

export function parseUuidParam(value: string): string {
  const r = uuidSchema.safeParse(value);
  if (!r.success) {
    throw new AppError('NOT_FOUND');
  }
  return r.data;
}

export function readOriginConnId(request: FastifyRequest): string | null {
  const raw = request.headers['x-connection-id'];
  if (typeof raw === 'string' && raw.length > 0 && raw.length <= 64) {
    return raw;
  }
  return null;
}
