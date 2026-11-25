import type { Role } from './fields.js';

/** 权限表：前端据此决定显示哪些入口，服务端据此做最终判定。 */
export const PERMISSIONS = {
  'users.manage': { admin: true, user: false },
  'invites.manage': { admin: true, user: false },
  'diag.realtime': { admin: true, user: false },
  'worksheets.manage': { admin: true, user: true },
  'data.import': { admin: true, user: false },
  'data.export': { admin: true, user: false },
  'storage.manage': { admin: true, user: false },
} as const satisfies Record<string, Record<Role, boolean>>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return PERMISSIONS[permission][role];
}

export function permissionsFor(role: Role): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}
