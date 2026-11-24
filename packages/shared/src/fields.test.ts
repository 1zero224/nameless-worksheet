import { describe, expect, it } from 'vitest';
import {
  createInviteBodySchema,
  displayNameSchema,
  loginNameSchema,
  passwordSchema,
  registerBodySchema,
} from './fields.js';

describe('登录名', () => {
  it('大写转小写', () => {
    expect(loginNameSchema.parse('Alice_01')).toBe('alice_01');
  });
  it('长度边界', () => {
    expect(loginNameSchema.safeParse('ab').success).toBe(false);
    expect(loginNameSchema.safeParse('abc').success).toBe(true);
    expect(loginNameSchema.safeParse('a'.repeat(32)).success).toBe(true);
    expect(loginNameSchema.safeParse('a'.repeat(33)).success).toBe(false);
  });
  it('非法字符', () => {
    expect(loginNameSchema.safeParse('a-b-c').success).toBe(false);
    expect(loginNameSchema.safeParse('张三abc').success).toBe(false);
  });
});

describe('显示名', () => {
  it('去掉首尾全角与半角空白', () => {
    expect(displayNameSchema.parse('　 小明 　')).toBe('小明');
  });
  it('NFC 归一化', () => {
    expect(displayNameSchema.parse('é')).toBe('é');
  });
  it('只有空白视为空', () => {
    expect(displayNameSchema.safeParse('　　').success).toBe(false);
  });
  it('32 个字符为上限，按字符而非 UTF-16 单元计数', () => {
    expect(displayNameSchema.safeParse('字'.repeat(32)).success).toBe(true);
    expect(displayNameSchema.safeParse('字'.repeat(33)).success).toBe(false);
    expect(displayNameSchema.safeParse('😀'.repeat(32)).success).toBe(true);
  });
  it('支持假名与全角字符', () => {
    expect(displayNameSchema.parse('さくら＿ＡＢＣ')).toBe('さくら＿ＡＢＣ');
  });
  it('拒绝控制字符', () => {
    expect(displayNameSchema.safeParse('a\u0007b').success).toBe(false);
    expect(displayNameSchema.safeParse('a\nb').success).toBe(false);
  });
});

describe('密码', () => {
  it('长度边界', () => {
    expect(passwordSchema.safeParse('1234567').success).toBe(false);
    expect(passwordSchema.safeParse('12345678').success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(128)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });
  it('转小写后等于登录名时拒绝', () => {
    const r = registerBodySchema.safeParse({
      loginName: 'alice_01',
      displayName: '爱丽丝',
      password: 'ALICE_01',
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['password']);
  });
});

describe('邀请', () => {
  it('默认值', () => {
    expect(createInviteBodySchema.parse({})).toEqual({
      role: 'user',
      expiresInDays: 7,
      maxUses: 1,
    });
  });
  it('有效期只能是 1/7/30', () => {
    expect(createInviteBodySchema.safeParse({ expiresInDays: 3 }).success).toBe(false);
  });
  it('次数 1–50', () => {
    expect(createInviteBodySchema.safeParse({ maxUses: 0 }).success).toBe(false);
    expect(createInviteBodySchema.safeParse({ maxUses: 51 }).success).toBe(false);
    expect(createInviteBodySchema.safeParse({ maxUses: 50 }).success).toBe(true);
  });
});
