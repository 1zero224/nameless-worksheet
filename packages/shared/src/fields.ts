import { z } from 'zod';

export const LOGIN_NAME_RE = /^[a-z0-9_]{3,32}$/;
// 控制字符（C0、DEL、C1）以及行分隔符、段分隔符
// biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要匹配控制字符
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const charCount = (s: string) => [...s].length;

/** 登录名：先去首尾空白、转小写再校验。 */
export const loginNameSchema = z
  .string({ error: '请填写登录名' })
  .trim()
  .toLowerCase()
  .regex(LOGIN_NAME_RE, { error: '登录名为 3–32 位小写字母、数字或下划线' });

export function normalizeDisplayName(s: string): string {
  return s.normalize('NFC').trim();
}

/** 显示名：NFC 归一化、去首尾空白，1–32 个字符，不含控制字符。 */
export const displayNameSchema = z
  .string({ error: '请填写显示名' })
  .transform(normalizeDisplayName)
  .pipe(
    z
      .string()
      .refine((s) => charCount(s) >= 1, { error: '请填写显示名' })
      .refine((s) => charCount(s) <= 32, { error: '显示名最多 32 个字符' })
      .refine((s) => !CONTROL_RE.test(s), { error: '显示名不能包含控制字符' }),
  );

/** 密码：8–128 个字符；与登录名的比较见 passwordMatchesLoginName。 */
export const passwordSchema = z
  .string({ error: '请填写密码' })
  .refine((s) => charCount(s) >= 8, { error: '密码至少 8 个字符' })
  .refine((s) => charCount(s) <= 128, { error: '密码最多 128 个字符' });

export function passwordMatchesLoginName(password: string, loginName: string): boolean {
  return password.toLowerCase() === loginName.toLowerCase();
}
export const PASSWORD_EQUALS_LOGIN_NAME = '密码不能与登录名相同';

export const roleSchema = z.enum(['admin', 'user'], { error: '角色无效' });
export type Role = z.infer<typeof roleSchema>;
export const ROLE_LABELS: Record<Role, string> = { admin: '管理员', user: '普通用户' };

export const INVITE_EXPIRY_DAYS = [1, 7, 30] as const;

// ---- 请求体 ----

export const loginBodySchema = z.object({
  loginName: z
    .string({ error: '请填写登录名' })
    .trim()
    .toLowerCase()
    .min(1, { error: '请填写登录名' })
    .max(64, { error: '登录名或密码错误' }),
  password: z.string({ error: '请填写密码' }).min(1, { error: '请填写密码' }).max(1024),
});

export const registerBodySchema = z
  .object({
    loginName: loginNameSchema,
    displayName: displayNameSchema,
    password: passwordSchema,
  })
  .superRefine((v, ctx) => {
    if (passwordMatchesLoginName(v.password, v.loginName)) {
      ctx.addIssue({ code: 'custom', path: ['password'], message: PASSWORD_EQUALS_LOGIN_NAME });
    }
  });

export const resetPasswordBodySchema = z.object({ password: passwordSchema });

export const updateAccountBodySchema = z.object({ displayName: displayNameSchema });

export const changePasswordBodySchema = z.object({
  currentPassword: z
    .string({ error: '请填写当前密码' })
    .min(1, { error: '请填写当前密码' })
    .max(1024),
  newPassword: passwordSchema,
});

export const updateRoleBodySchema = z.object({ role: roleSchema });

export const createInviteBodySchema = z.object({
  role: roleSchema.default('user'),
  expiresInDays: z
    .union([z.literal(1), z.literal(7), z.literal(30)], { error: '有效期只能是 1、7 或 30 天' })
    .default(7),
  maxUses: z
    .number({ error: '可用次数必须是数字' })
    .int({ error: '可用次数必须是整数' })
    .min(1, { error: '可用次数为 1–50' })
    .max(50, { error: '可用次数为 1–50' })
    .default(1),
});

export const diagTestBodySchema = z.object({
  message: z
    .string({ error: '请填写内容' })
    .refine((s) => charCount(s) >= 1 && charCount(s) <= 200, { error: '内容为 1–200 个字符' }),
});
