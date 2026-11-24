import { createHash, randomBytes } from 'node:crypto';

/** 32 字节随机数的 base64url 形式 */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 形状明显不对的令牌直接判无效，免得白查数据库 */
export function looksLikeToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}
