export const ERROR_CODES = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  ORIGIN_FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  FIELD_CONFLICT: 409,
  STAGE_ALREADY_CLAIMED: 409,
  VERSION_ALREADY_HAS_FILE: 409,
  TOKEN_INVALID: 410,
  UPLOAD_SESSION_EXPIRED: 410,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  STORAGE_ERROR: 502,
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
  FIELD_CONFLICT: '该单元格刚被他人修改',
  STAGE_ALREADY_CLAIMED: '该工序已被他人认领',
  VERSION_ALREADY_HAS_FILE: '该版本已由他人上传文件，可将本次已传文件改存为新版本',
  TOKEN_INVALID: '链接无效或已过期',
  UPLOAD_SESSION_EXPIRED: '上传会话已过期，请重新上传',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  INTERNAL: '服务器内部错误',
  STORAGE_ERROR: '云端存储服务操作失败，请稍后重试',
};

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    fields?: Record<string, string>;
    details?: unknown;
  };
}
