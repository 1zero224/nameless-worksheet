export const ERROR_CODES = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  ORIGIN_FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TOKEN_INVALID: 410,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_FAILED: '输入不符合要求',
  UNAUTHENTICATED: '请先登录',
  INVALID_CREDENTIALS: '登录名或密码错误',
  FORBIDDEN: '无权执行此操作',
  ORIGIN_FORBIDDEN: '请求来源不被允许',
  NOT_FOUND: '对象不存在',
  CONFLICT: '与现有数据冲突',
  TOKEN_INVALID: '链接无效或已过期',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  INTERNAL: '服务器内部错误',
};

export interface ErrorBody {
  error: { code: ErrorCode; message: string; fields?: Record<string, string> };
}
