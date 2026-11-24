import { type Algorithm, hash, verify } from '@node-rs/argon2';

// Algorithm.Argon2id === 2（@node-rs/argon2 声明为 const enum，在 verbatimModuleSyntax 下直接写数值）
export const ARGON2_PARAMS = {
  algorithm: 2 as Algorithm,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_PARAMS);
}

let dummyHash: Promise<string> | undefined;
/** 登录名不存在时也做一次同等代价的校验，避免通过响应时间探测登录名 */
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  return dummyHash;
}

export interface VerifyResult {
  ok: boolean;
  /** 哈希参数与当前常量不同，需要重新哈希 */
  needsRehash: boolean;
}

export async function verifyPassword(
  storedHash: string | null | undefined,
  password: string,
): Promise<VerifyResult> {
  if (!storedHash) {
    await verify(await getDummyHash(), password).catch(() => false);
    return { ok: false, needsRehash: false };
  }
  const ok = await verify(storedHash, password).catch(() => false);
  return { ok, needsRehash: ok && !hasCurrentParams(storedHash) };
}

export function hasCurrentParams(storedHash: string): boolean {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  return (
    !!m &&
    Number(m[1]) === ARGON2_PARAMS.memoryCost &&
    Number(m[2]) === ARGON2_PARAMS.timeCost &&
    Number(m[3]) === ARGON2_PARAMS.parallelism
  );
}
