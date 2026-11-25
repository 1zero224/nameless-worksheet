import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  displayNameSchema,
  loginNameSchema,
  passwordSchema,
  registerBodySchema,
} from './fields.js';
import {
  type Assignee,
  assigneesSchema,
  dedupeAssignees,
  isValidCalendarDate,
  isValidHttpUrl,
  normalizeText,
  nullableDateSchema,
  nullableHttpUrlSchema,
} from './worksheet.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: 验证输出绝不含控制字符
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const charCount = (s: string) => [...s].length;

const validLoginCharArb = fc.constantFrom(
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_',
);

const validDisplayCharArb = fc.oneof(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_- '),
  fc.constantFrom(...'无名字幕组翻译校对时轴嵌字さくらアイウエオＡＢＣ＿'),
  fc.constantFrom('é', 'e\u0301', '😀', '🎬'),
);

describe('shared 字段与归一化属性测试（fast-check）', () => {
  it('normalizeText 对任意 Unicode 字符串满足幂等性与 NFC 规范化', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 80 }), (raw) => {
        const once = normalizeText(raw);
        const twice = normalizeText(once);
        expect(twice).toBe(once);
        expect(once).toBe(once.normalize('NFC'));
        expect(once).toBe(once.trim());
      }),
      { numRuns: 200 },
    );
  });

  it('loginNameSchema 对合法字符集大小写无关且幂等，长度越界必拒', () => {
    fc.assert(
      fc.property(
        fc.array(validLoginCharArb, { minLength: 3, maxLength: 32 }).map((arr) => arr.join('')),
        (raw) => {
          const parsed = loginNameSchema.parse(raw);
          expect(parsed).toBe(raw.toLowerCase());
          expect(loginNameSchema.parse(parsed)).toBe(parsed);
        },
      ),
      { numRuns: 200 },
    );

    fc.assert(
      fc.property(
        fc.oneof(
          fc.array(validLoginCharArb, { minLength: 0, maxLength: 2 }).map((a) => a.join('')),
          fc.array(validLoginCharArb, { minLength: 33, maxLength: 64 }).map((a) => a.join('')),
        ),
        (invalid) => {
          expect(loginNameSchema.safeParse(invalid).success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('displayNameSchema 输出满足 NFC、去首尾空白、码点上限 32、无控制字符且幂等', () => {
    fc.assert(
      fc.property(
        fc.array(validDisplayCharArb, { minLength: 0, maxLength: 45 }).map((arr) => arr.join('')),
        (raw) => {
          const res = displayNameSchema.safeParse(raw);
          if (res.success) {
            expect(res.data).toBe(res.data.normalize('NFC'));
            expect(charCount(res.data)).toBeGreaterThanOrEqual(1);
            expect(charCount(res.data)).toBeLessThanOrEqual(32);
            expect(CONTROL_RE.test(res.data)).toBe(false);
            expect(displayNameSchema.parse(res.data)).toBe(res.data);
          }
        },
      ),
      { numRuns: 250 },
    );
  });

  it('displayNameSchema 拒绝任意含控制字符的字符串', () => {
    const controlCharArb = fc.constantFrom('\u0000', '\u0007', '\n', '\r', '\t', '\u007f');
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !CONTROL_RE.test(s)),
        controlCharArb,
        fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !CONTROL_RE.test(s)),
        (prefix, ctrl, suffix) => {
          const candidate = `a${prefix}${ctrl}${suffix}b`;
          expect(displayNameSchema.safeParse(candidate).success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('registerBodySchema 始终拒绝密码与登录名忽略大小写相同的情况', () => {
    fc.assert(
      fc.property(
        fc.array(validLoginCharArb, { minLength: 8, maxLength: 20 }).map((a) => a.join('')),
        (name) => {
          expect(passwordSchema.safeParse(name).success).toBe(true);
          const res = registerBodySchema.safeParse({
            loginName: name.toLowerCase(),
            displayName: '测试用户',
            password: name.toUpperCase(),
          });
          expect(res.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('isValidCalendarDate 与 nullableDateSchema 精确区分真实日历日期与非法日期', () => {
    const validDateArb = fc
      .record({
        year: fc.integer({ min: 1970, max: 2100 }),
        month: fc.integer({ min: 1, max: 12 }),
        day: fc.integer({ min: 1, max: 31 }),
      })
      .filter(({ year, month, day }) => {
        const dt = new Date(Date.UTC(year, month - 1, day));
        return (
          dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day
        );
      })
      .map(
        ({ year, month, day }) =>
          `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      );

    fc.assert(
      fc.property(validDateArb, (dateStr) => {
        expect(isValidCalendarDate(dateStr)).toBe(true);
        expect(nullableDateSchema.parse(`  ${dateStr}  `)).toBe(dateStr);
      }),
      { numRuns: 200 },
    );

    const invalidDateArb = fc.oneof(
      fc.integer({ min: 1970, max: 2100 }).map((y) => `${y}-02-30`),
      fc.integer({ min: 1970, max: 2100 }).map((y) => `${y}-04-31`),
      fc
        .tuple(fc.integer({ min: 1970, max: 2100 }), fc.integer({ min: 13, max: 99 }))
        .map(([y, m]) => `${y}-${String(m).padStart(2, '0')}-01`),
    );

    fc.assert(
      fc.property(invalidDateArb, (bad) => {
        expect(isValidCalendarDate(bad)).toBe(false);
        expect(nullableDateSchema.safeParse(bad).success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('isValidHttpUrl 与 nullableHttpUrlSchema 只允许 http/https，绝不放行危险协议', () => {
    const hostArb = fc.constantFrom('example.com', 'sub.bilibili.com', '127.0.0.1:3000');
    const pathArb = fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_/.'), { maxLength: 40 })
      .map((a) => a.join(''));

    fc.assert(
      fc.property(fc.constantFrom('http', 'https'), hostArb, pathArb, (proto, host, p) => {
        const url = `${proto}://${host}/${p}`;
        expect(isValidHttpUrl(url)).toBe(true);
        expect(nullableHttpUrlSchema.parse(url)).toBe(url);
      }),
      { numRuns: 150 },
    );

    fc.assert(
      fc.property(
        fc.constantFrom('javascript:', 'data:', 'file://', 'ftp://', 'vbscript:'),
        pathArb,
        (scheme, rest) => {
          const bad = `${scheme}${rest || 'alert(1)'}`;
          expect(isValidHttpUrl(bad)).toBe(false);
          expect(nullableHttpUrlSchema.safeParse(bad).success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('dedupeAssignees 与 assigneesSchema 满足去重唯一性、保序性与幂等性', () => {
    const userIdPool = [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000004',
    ] as const;

    const assigneeArb: fc.Arbitrary<Assignee> = fc.oneof(
      fc.constantFrom(...userIdPool).map((userId) => ({ type: 'user' as const, userId })),
      fc
        .constantFrom('外援小王', '官中', '初校甲', '压制乙')
        .map((name) => ({ type: 'text' as const, name })),
    );

    fc.assert(
      fc.property(fc.array(assigneeArb, { maxLength: 20 }), (list) => {
        const deduped = dedupeAssignees(list);
        expect(dedupeAssignees(deduped)).toEqual(deduped);
        expect(deduped.length).toBeLessThanOrEqual(list.length);

        const keys = deduped.map((a) => (a.type === 'user' ? `u:${a.userId}` : `t:${a.name}`));
        expect(new Set(keys).size).toBe(keys.length);

        const parsed = assigneesSchema.parse(list);
        expect(parsed).toEqual(deduped);
      }),
      { numRuns: 200 },
    );
  });
});
