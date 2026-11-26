import { type ArtifactChangedPayload, isValidArtifactUrl } from '@nw/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { scrubTokenUrl } from '../src/app.js';
import { emitArtifactChanged } from '../src/modules/artifacts.js';

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

  it('阶段 3 V11: emitArtifactChanged 广播载荷绝不包含提取码或外部 URL', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.uuid(),
        fc.uuid(),
        secretTokenArb,
        secretTokenArb,
        (projectId, wsId, artifactId, secretCode, secretPath) => {
          const captured: unknown[] = [];
          const secretUrl = `https://pan.baidu.com/s/1${secretPath}?pwd=${secretCode}`;
          const dirtyPayload = {
            scopeKind: 'task',
            action: 'location.created',
            artifactId,
            worksheetId: wsId,
            workId: null,
            taskId: null,
            stageColumnId: null,
            // 即使调用方意外塞入多余敏感键，emitArtifactChanged 也必须剥离
            extractCode: secretCode,
            url: secretUrl,
          } as unknown as ArtifactChangedPayload;

          emitArtifactChanged(
            (ev: unknown) => {
              captured.push(ev);
            },
            projectId,
            dirtyPayload,
          );

          expect(captured.length).toBeGreaterThan(0);
          const serialized = JSON.stringify(captured);
          expect(serialized).not.toContain(secretCode);
          expect(serialized).not.toContain(secretPath);
          expect(serialized).not.toContain('pan.baidu.com');
        },
      ),
      { numRuns: 150 },
    );
  });

  it('阶段 3 V11: isValidArtifactUrl 严格拒绝任意非 http/https 伪协议', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('javascript:', 'data:', 'file:', 'vbscript:', 'ftp:', 'blob:'),
        secretTokenArb,
        (scheme, body) => {
          expect(isValidArtifactUrl(`${scheme}${body}`)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
