import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { scrubTokenUrl } from '../src/app.js';

const tokenCharArb = fc.constantFrom(
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_',
);

const secretTokenArb = fc
  .array(tokenCharArb, { minLength: 8, maxLength: 64 })
  .map((arr) => arr.join(''));

describe('安全脱敏属性测试（fast-check）', () => {
  it('scrubTokenUrl 对任意邀请令牌与重置令牌路径均彻底脱敏且幂等', () => {
    fc.assert(
      fc.property(
        secretTokenArb,
        fc.constantFrom(
          (t: string) => `/api/invites/by-token/${t}`,
          (t: string) => `/api/invites/by-token/${t}/register`,
          (t: string) => `/api/invites/by-token/${t}?foo=1`,
          (t: string) => `/api/password-resets/${t}`,
          (t: string) => `/api/password-resets/${t}?from=mail`,
        ),
        (token, buildUrl) => {
          const rawUrl = buildUrl(token);
          const scrubbed = scrubTokenUrl(rawUrl);
          expect(scrubbed).not.toContain(token);
          expect(scrubbed).toContain(':token');
          expect(scrubTokenUrl(scrubbed)).toBe(scrubbed);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('scrubTokenUrl 不破坏非令牌普通接口路径', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          '/api/health',
          '/api/users',
          '/api/worksheets',
          '/api/board',
          '/api/search',
        ),
        fc.uuid(),
        (prefix, id) => {
          const url = `${prefix}/${id}`;
          expect(scrubTokenUrl(url)).toBe(url);
        },
      ),
      { numRuns: 100 },
    );
  });
});
