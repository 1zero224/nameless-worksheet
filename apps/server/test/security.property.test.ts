import {
  type ArtifactChangedPayload,
  detectPreviewKind,
  isValidArtifactUrl,
  sanitizeFilename,
} from '@nw/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { scrubTokenUrl } from '../src/app.js';
import { emitArtifactChanged } from '../src/modules/artifacts.js';
import { buildContentDispositionAttachment } from '../src/storage/driver.js';

const tokenCharArb = fc.constantFrom(
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_',
);

const secretTokenArb = fc
  .array(tokenCharArb, { minLength: 8, maxLength: 64 })
  .map((arr) => arr.join(''));

describe('安全脱敏属性测试（fast-check）', () => {
  it('scrubTokenUrl 对任意邀请令牌、重置令牌与认领令牌路径均彻底脱敏且幂等', () => {
    fc.assert(
      fc.property(
        secretTokenArb,
        fc.constantFrom(
          (t: string) => `/api/invites/by-token/${t}`,
          (t: string) => `/api/invites/by-token/${t}/register`,
          (t: string) => `/api/invites/by-token/${t}?foo=1`,
          (t: string) => `/api/password-resets/${t}`,
          (t: string) => `/api/password-resets/${t}?from=mail`,
          (t: string) => `/api/account-claims/${t}`,
          (t: string) => `/api/account-claims/${t}/complete`,
          (t: string) => `/claim/${t}`,
          (t: string) => `/claim/${t}?ref=qq`,
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

  it('阶段 4 V12: emitArtifactChanged 广播载荷绝不包含签名 URL、R2 key、R2 密钥或提取码', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.uuid(),
        fc.uuid(),
        secretTokenArb,
        secretTokenArb,
        (projectId, wsId, artifactId, secretSig, r2SecretKey) => {
          const captured: unknown[] = [];
          const r2Key = `projects/${projectId}/blobs/${artifactId}`;
          const signedUrl = `https://bucket.account.r2.cloudflarestorage.com/${r2Key}?X-Amz-Signature=${secretSig}`;
          const dirtyPayload = {
            scopeKind: 'stage',
            action: 'version.created',
            artifactId,
            worksheetId: wsId,
            workId: null,
            taskId: null,
            stageColumnId: null,
            r2Key,
            signedUrl,
            r2SecretAccessKey: r2SecretKey,
            singlePutUrl: signedUrl,
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
          expect(serialized).not.toContain(secretSig);
          expect(serialized).not.toContain(r2SecretKey);
          expect(serialized).not.toContain('projects/');
          expect(serialized).not.toContain('X-Amz-Signature');
          expect(serialized).not.toContain('r2.cloudflarestorage.com');
        },
      ),
      { numRuns: 150 },
    );
  });

  it('阶段 4 V10/V12: sanitizeFilename 与 Content-Disposition 对任意文件名均消除控制字符与路径穿越，且 .svg/.html 永不内联预览', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 320 }), (raw) => {
        const clean = sanitizeFilename(raw);
        expect(clean.length).toBeGreaterThan(0);
        expect([...clean].length).toBeLessThanOrEqual(255);
        expect(clean).not.toMatch(/[/\\]/);
        expect(clean).not.toContain('..');
        // biome-ignore lint/suspicious/noControlCharactersInRegex: 属性断言无控制字符
        expect(clean).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);

        const disp = buildContentDispositionAttachment(raw);
        expect(disp.startsWith('attachment; filename="')).toBe(true);
        expect(disp).toContain("filename*=UTF-8''");
        // biome-ignore lint/suspicious/noControlCharactersInRegex: 响应头严禁包含换行与控制字符（防头注入）
        expect(disp).not.toMatch(/[\r\n\u0000-\u001f\u007f]/);
      }),
      { numRuns: 200 },
    );

    fc.assert(
      fc.property(
        secretTokenArb,
        fc.constantFrom('.svg', '.SVG', '.html', '.htm', '.xhtml'),
        (base, ext) => {
          expect(detectPreviewKind(`${base}${ext}`, 'image/svg+xml')).toBe('unsupported');
          expect(detectPreviewKind(`${base}${ext}`, 'text/html')).toBe('unsupported');
        },
      ),
      { numRuns: 100 },
    );
  });
});
