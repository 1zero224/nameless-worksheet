import { DEFAULT_MESSAGES, ERROR_CODES, type ErrorBody, type ErrorCode } from '@nw/shared';

export class AppError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.statusCode = ERROR_CODES[code];
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.fields ? { fields: this.fields } : {}),
      },
    };
  }
}

export const notFound = () => new AppError('NOT_FOUND');

export function fieldError(field: string, message: string, code: ErrorCode = 'VALIDATION_FAILED') {
  return new AppError(code, message, { [field]: message });
}

/** PostgreSQL 唯一约束冲突 */
export function uniqueViolation(err: unknown): string | null {
  const e = err as { code?: string; constraint?: string; cause?: unknown };
  if (e?.code === '23505') return e.constraint ?? '';
  if (e?.cause) return uniqueViolation(e.cause);
  return null;
}
